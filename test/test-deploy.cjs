// ============================================================
// Agent 部署器契约 + 全链路测试（本地 mock-ssh，绝不连真实服务器）
// 回归目标（v1.11.2 修复的四类契约错位，修复前部署 100% 假超时）：
//   1. writeRemoteFile/readRemoteFile 曾按 (connId, cmd, timeout) 三参调用，
//      命令串被当成 timeout → setTimeout(NaN)=1ms → 「命令超时（NaNs）」
//   2. exec 返回值契约：SshManager.exec 成功 resolve {code,stdout}、失败 reject，
//      部署器内部必须归一化成 {ok,code,stdout,error}
//   3. 重试逻辑：只对真失败（reject）重试一次，成功绝不双执行
//   4. sftp 通道用完即关（openSession.close / dropCache 真 end）
// 运行：node test/test-deploy.cjs
// ============================================================
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { makeExec, writeRemoteFile, readRemoteFile, parseGlibcVersion, AgentDeployer, agentBinaryPath } = require('../main/agent-deployer')

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name) }
}

// ---------- 单元：exec 适配层契约 ----------
console.log('exec 适配层契约（makeExec）')
async function testMakeExec() {
  // 成功路径：归一化为 {ok,code,stdout}，且只执行一次（旧版会双执行）
  let calls = []
  const okMgr = {
    exec: async (connId, cmd, timeout) => {
      calls.push({ connId, cmd, timeout })
      return { code: 0, stdout: 'hello' }
    }
  }
  const exec1 = makeExec(okMgr, 'conn_1')
  const r1 = await exec1('echo hello', 5000)
  ok(r1.ok === true && r1.code === 0 && r1.stdout === 'hello', '成功归一化为 {ok,code,stdout}')
  ok(calls.length === 1, '成功只执行一次（回归：旧版成功也会重试双执行）')
  ok(calls[0].cmd === 'echo hello' && typeof calls[0].timeout === 'number', '调用形状为 (字符串命令, 数字超时)')
  ok(calls[0].connId === 'conn_1', 'connId 由适配层注入')

  // 失败（reject）路径：重试一次后仍失败 → {ok:false,error}
  calls = []
  const badMgr = { exec: async () => { calls.push(1); throw new Error('命令超时（5s）') } }
  const r2 = await makeExec(badMgr, 'c')('true', 3000)
  ok(r2.ok === false && r2.error === '命令超时（5s）', '两次失败后返回 {ok:false,error}')
  ok(calls.length === 2, '失败只重试一次（共 2 次）')

  // reject 后重试成功
  calls = []
  let n = 0
  const flakyMgr = {
    exec: async () => {
      n++
      if (n === 1) throw new Error('连接瞬断')
      return { code: 0, stdout: 'ok' }
    }
  }
  const r3 = await makeExec(flakyMgr, 'c')('true', 3000)
  ok(r3.ok === true && r3.stdout === 'ok' && n === 2, '瞬时失败重试后成功')
}

// ---------- 单元：远程读写文件契约 ----------
console.log('远程读写文件契约')
async function testRemoteFile() {
  // 回归核心：writeRemoteFile/readRemoteFile 必须两参调用 (命令串, 数字超时)
  // 旧版三参 (null, 命令串, 数字) 会把命令串当 timeout → 「命令超时（NaNs）」必现
  const calls = []
  const rec = {
    exec: async (cmd, timeout) => {
      calls.push({ cmd, timeout })
      return { ok: true, code: 0, stdout: '' }
    }
  }
  await writeRemoteFile(rec, '/opt/longserve-agent/data/config.json', '{"token":"t1"}')
  ok(typeof calls[0].cmd === 'string' && calls[0].cmd.includes('base64 -d'), 'writeRemoteFile 第一参是命令串（不是 null）')
  ok(typeof calls[0].timeout === 'number' && calls[0].timeout === 20000, 'writeRemoteFile 第二参是数字超时（不是命令串）')

  calls.length = 0
  const rec2 = {
    exec: async (cmd, timeout) => {
      calls.push({ cmd, timeout })
      return { ok: true, code: 0, stdout: '{"token":"abc"}' }
    }
  }
  const cfg = await readRemoteFile(rec2, '/opt/longserve-agent/data/config.json')
  ok(cfg && cfg.token === 'abc', 'readRemoteFile 解析 JSON')
  ok(typeof calls[0].cmd === 'string' && calls[0].cmd.startsWith('cat ') && typeof calls[0].timeout === 'number', 'readRemoteFile 两参形状正确')

  // 错误分支
  let threw = ''
  try { await writeRemoteFile({ exec: async () => ({ ok: false, error: 'boom' }) }, '/x', 'y') }
  catch (e) { threw = e.message }
  ok(threw.includes('远程写入失败：boom'), 'writeRemoteFile 失败带错误信息抛出')

  threw = ''
  try { await writeRemoteFile({ exec: async () => ({ ok: true, code: 3, stdout: '' }) }, '/x', 'y') }
  catch (e) { threw = e.message }
  ok(threw.includes('退出码 3'), 'writeRemoteFile 非零退出码抛出')

  ok(await readRemoteFile({ exec: async () => ({ ok: false, error: 'e' }) }, '/x') === null, 'readRemoteFile 失败返回 null')
  ok(await readRemoteFile({ exec: async () => ({ ok: true, code: 1, stdout: '' }) }, '/x') === null, 'readRemoteFile 文件不存在返回 null')
  ok(await readRemoteFile({ exec: async () => ({ ok: true, code: 0, stdout: 'not-json' }) }, '/x') === null, 'readRemoteFile 坏 JSON 返回 null')
}

// ---------- 单元：glibc 版本解析（v1.11.3 老系统兼容预检） ----------
console.log('glibc 版本解析（parseGlibcVersion）')
function testParseGlibc() {
  const ubuntu = parseGlibcVersion('ldd (Ubuntu GLIBC 2.31-0ubuntu9.16) 2.31')
  ok(ubuntu && ubuntu.musl === false && ubuntu.version === '2.31' && ubuntu.minor === 31, 'Ubuntu 新系统：2.31')
  const centos7 = parseGlibcVersion('ldd (GNU libc) 2.17')
  ok(centos7 && centos7.minor === 17, 'CentOS 7 边界值：2.17（glibc-217 最低要求，应识别通过）')
  const ubuntu1804 = parseGlibcVersion('ldd (Ubuntu GLIBC 2.27-3ubuntu1.5) 2.27')
  ok(ubuntu1804 && ubuntu1804.minor === 27, 'Ubuntu 18.04：2.27（< 2.28，官方构建跑不了、glibc-217 可跑）')
  const musl = parseGlibcVersion('musl libc (x86_64)')
  ok(musl && musl.musl === true, 'musl/Alpine 识别为不支持')
  ok(parseGlibcVersion('some garbage output') === null, '无法解析返回 null（不阻塞部署）')
  ok(parseGlibcVersion('') === null, '空输出返回 null')
}

// ---------- 集成：mock-ssh 全链路部署 ----------
console.log('mock-ssh 全链路（部署→状态→换钥→卸载）')
async function testFullDeploy() {
  const SshManager = require('../main/ssh-manager')
  const SftpManager = require('../main/sftp-manager')

  const port = 22220 + Math.floor(Math.random() * 500)
  const mock = spawn(process.execPath, [path.join(__dirname, 'mock-ssh.js'), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('mock-ssh 启动超时')), 8000)
    mock.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); resolve() } })
    mock.on('exit', () => reject(new Error('mock-ssh 异常退出')))
  })

  const sshManager = new SshManager(() => {})
  const sftpManager = new SftpManager(sshManager)
  const deployer = new AgentDeployer(sshManager, sftpManager)
  try {
    const { connId } = await sshManager.connect({ host: '127.0.0.1', port, username: 'test', password: 'test' })
    ok(true, '连接 mock-ssh 成功')

    // 1. 完整部署（二进制用真实 agent/release/longserve-agent）
    const t0 = Date.now()
    const r = await deployer.deploy(
      { isPackaged: false },
      {
        connId,
        instance: { host: '127.0.0.1' },
        aiProvider: { name: 'test-ai', protocol: 'openai', baseUrl: 'https://api.test.com/v1', apiKey: 'k123', model: 'm1', reasoningBack: true },
        port: 37777,
        onStep: () => {}
      }
    )
    const elapsed = Date.now() - t0
    ok(!!r && !!r.token && r.port === 37777, `部署成功返回 token/port（${elapsed}ms）`)
    ok(elapsed < 30000, '部署全程无假超时（回归：旧版 1ms 内必死）')
    ok(fs.existsSync(agentBinaryPath({ isPackaged: false })), '本地 Agent 二进制存在')

    // 2. 远端产物核对：config.json 落盘且 token 一致（走 exec cat，顺便验证 exec 契约）
    const cat = await sshManager.exec(connId, `cat '/opt/longserve-agent/data/config.json'`, 5000)
    const cfg = JSON.parse(cat.stdout)
    ok(cfg.token === r.token && cfg.port === 37777 && cfg.ai.apiKey === 'k123', '远程 config.json 内容正确（token/端口/AI 配置）')

    // 3. 二进制经 sftp 确认存在（openSession 一次性会话）
    const session = await sftpManager.openSession(connId)
    const st = await new Promise((resolve) => session.sftp.stat('/opt/longserve-agent/longserve-agent', (err, s) => resolve(err ? null : s)))
    ok(!!st && st.size > 0, '二进制已上传（sftp.stat 可见）')
    session.close()

    // 4. 状态查询（回归：旧版 r.ok 契约错位导致永远"未运行"）
    const st2 = await deployer.status(connId, 37777)
    ok(st2.active === true && st2.healthy === true, '状态查询：运行中 + 接口正常')

    // 5. 重新生成 token（回归：旧版永远报"该服务器尚未部署 Agent"）
    const r2 = await deployer.regenerateToken(connId, 37777)
    ok(!!r2.token && r2.token !== r.token, '换发 token 成功且已更新')

    // 6. 卸载（回归：旧版必抛"卸载失败：undefined"）
    const r3 = await deployer.undeploy(connId)
    ok(r3.ok === true, '卸载成功')
  } finally {
    sshManager.closeAll()
    mock.kill()
    await new Promise((r) => setTimeout(r, 200))
  }
}

;(async () => {
  await testMakeExec()
  await testRemoteFile()
  testParseGlibc()
  await testFullDeploy()
  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  process.exitCode = failed ? 1 : 0
})().catch((e) => { console.error('测试执行异常:', e); process.exit(1) })
