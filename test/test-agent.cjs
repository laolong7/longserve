// ============================================================
// Longserve Agent 自动化测试（本地 mock，无需真实 key/服务器）
// 覆盖：危险命令规则、执行确认流（批准/拒绝）、
//       mock AI 会话循环（SSE 事件序/工具执行/reasoning_content 保存）、
//       文件存储（配置/会话/审计）、HTTP API 全链路（含 SSE 与 401）
// 运行：node test/test-agent.js
// ============================================================
const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name) }
}

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'lagent-test-'))

// ---------- 单元：危险规则 ----------
console.log('危险命令规则')
{
  const { checkDanger } = require('../agent/src/danger')
  ok(checkDanger('df -h').danger === false, 'df -h 安全')
  ok(checkDanger('rm -rf /data/logs').danger === true, 'rm -rf 拦截')
  ok(checkDanger('reboot').danger === true, 'reboot 拦截')
  ok(checkDanger('systemctl stop nginx').danger === true, '停止核心服务拦截')
  ok(checkDanger('rm /opt/longserve-agent/longserve-agent').danger === true, '动 Agent 自身拦截')
  ok(checkDanger('echo hello && rm -rf /tmp/x').danger === true, '链式命令里的 rm 拦截')
}

// ---------- 单元：执行确认流 ----------
console.log('执行确认流')
// 审计落盘依赖 store 初始化（exec 与 AI 共用数据目录）
require('../agent/src/store').init(tmpData)
async function testConfirmFlow() {
  const execMod = require('../agent/src/exec')
  // 拒绝路径
  let evt = null
  const p1 = execMod.requestExec('rm -rf /tmp/test-danger', 'ai', (e) => (evt = e))
  await new Promise((r) => setTimeout(r, 50))
  ok(evt && evt.type === 'confirm' && evt.id, '危险命令挂起并发出 confirm 事件')
  ok(typeof p1.then === 'function', 'requestExec 返回挂起中的 Promise')
  execMod.resolveConfirm(evt.id, false)
  const r1 = await p1
  ok(r1.output.includes('[已拒绝]'), '拒绝后不执行')

  // 批准路径（用 echo 验证真实执行）
  evt = null
  const p2 = execMod.requestExec('echo confirm-ok-12345', 'ai', (e) => (evt = e))
  await new Promise((r) => setTimeout(r, 30))
  // echo 不危险直接执行了（confirm 事件为 null）
  ok(evt === null, '安全命令直接执行不挂起')
  const r2 = await p2
  ok(r2.output.includes('confirm-ok-12345'), '安全命令真实执行并返回输出')

  // listPending 可见性
  evt = null
  const p3 = execMod.requestExec('reboot', 'ai', (e) => (evt = e))
  await new Promise((r) => setTimeout(r, 30))
  ok(execMod.listPending().some((p) => p.id === evt.id), '挂起的确认可在 pending 列表查到')
  execMod.resolveConfirm(evt.id, true)
  await p3
}
main().catch((e) => { console.error('测试执行异常:', e); process.exit(1) })

async function main() {
  await testConfirmFlow()

// ---------- 单元：mock AI 会话循环 ----------
console.log('mock AI 会话循环')
{
  const store = require('../agent/src/store')
  store.init(tmpData)
  store.saveConfig({ token: 't', port: 37790, ai: { mock: true }, createdAt: 1 })
  const ai = require('../agent/src/ai')

  const events = []
  const events2 = []
  await ai.runChat('看下磁盘', (e) => events.push(e), null)
  ok(events.some((e) => e.type === 'reasoning'), '第一轮有思考流')
  ok(events.some((e) => e.type === 'delta'), '第二轮有正文流')
  const toolEvt = events.find((e) => e.type === 'tool')
  ok(toolEvt && toolEvt.name === 'run_command' && toolEvt.args.command === 'df -h', '工具调用 run_command(df -h) 事件')
  ok(events.some((e) => e.type === 'tool_result'), '工具结果事件')
  ok(events[events.length - 1].type === 'done', '循环以 done 结束')

  // reasoning_content 必须随 assistant 消息保存（DeepSeek 思考模式回传要求）
  const saved = JSON.parse(fs.readFileSync(path.join(tmpData, 'chat.json'), 'utf8'))
  const asst = saved.messages.find((m) => m.role === 'assistant' && m.tool_calls)
  ok(asst && asst.reasoning_content && asst.reasoning_content.includes('df -h'), 'assistant 消息保存了 reasoning_content')

  // 第二轮对话：上下文延续（mock 有 tool result 分支）
  await ai.runChat('汇报一下', (e) => events2.push(e), null)
  ok(events2.some((e) => e.type === 'delta'), '第二轮对话正常')
  ok(ai.history().some((m) => m.role === 'user' && m.content === '汇报一下'), '历史包含两轮消息')

  // 清空
  ai.clear()
  ok(ai.history().length === 0, '清空会话生效')
}

// ---------- 集成：HTTP API 全链路 ----------
console.log('HTTP API 全链路（含 SSE）')
{
  process.env.AGENT_DATA_DIR = tmpData
  // 用子进程起 agent（避免端口/状态与本测试进程冲突）
  const { spawn } = require('child_process')
  const port = 37795
  const child = spawn(process.execPath, ['src/index.js', `--port=${port}`, `--data=${tmpData}`], {
    cwd: path.join(__dirname, '..', 'agent'),
    stdio: 'ignore'
  })

  const waitUp = async () => {
    for (let i = 0; i < 40; i++) {
      try {
        await new Promise((resolve, reject) => {
          http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
            res.resume()
            res.on('end', resolve)
          }).on('error', reject)
        })
        return true
      } catch { await new Promise((r) => setTimeout(r, 250)) }
    }
    return false
  }
  const up = await waitUp()
  ok(up, 'Agent 服务启动')

  const req = (method, p, body, token = 't') =>
    new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null
      const r = http.request(
        { host: '127.0.0.1', port, path: p, method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } },
        (res) => {
          let buf = ''
          res.on('data', (d) => (buf += d))
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }))
        }
      )
      r.on('error', reject)
      if (data) r.write(data)
      r.end()
    })

  const health = await req('GET', '/api/health', null, '')
  ok(health.status === 200 && JSON.parse(health.body).ok, 'health 无需 token')

  const bad = await req('GET', '/api/status', null, 'wrong-token')
  ok(bad.status === 401, '错误 token 返回 401')

  const bind = await req('POST', '/api/bind', {})
  ok(bind.status === 200 && JSON.parse(bind.body).ok, '绑定成功返回服务器概况')

  const status = await req('GET', '/api/status')
  ok(status.status === 200 && JSON.parse(status.body).status.cpu.cores > 0, '状态采集正常')

  // SSE 对话：mock 模式全事件流
  const sseBody = await req('POST', '/api/chat', { text: '看下磁盘' })
  const sseEvents = sseBody.body.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)))
  ok(sseEvents.some((e) => e.type === 'reasoning'), 'SSE 收到思考事件')
  ok(sseEvents.some((e) => e.type === 'delta'), 'SSE 收到正文事件')
  ok(sseEvents[sseEvents.length - 1].type === 'done', 'SSE 以 done 收尾')

  // 并发对话应被拒绝（chat 已结束所以再发一条验证可重新开始；发两条则第二条 409）
  const [c1, c2] = await Promise.all([
    req('POST', '/api/chat', { text: '第一条' }),
    req('POST', '/api/chat', { text: '第二条' }).catch((e) => ({ error: e.message }))
  ])
  const codes = [c1.status, c2.status].sort()
  ok(codes[0] === 200 && codes[1] === 409, '并发对话被限流（409）')

  // 手动指令通道（安全命令直接执行）
  const ex = await req('POST', '/api/exec', { command: 'echo manual-ok' })
  ok(ex.status === 200 && JSON.parse(ex.body).output.includes('manual-ok'), '手动指令执行')

  // 手动危险命令两段式
  const ex2 = await req('POST', '/api/exec', { command: 'rm -rf /tmp/whatever' })
  ok(JSON.parse(ex2.body).needConfirm === true, '手动危险命令返回 needConfirm')

  const audit = await req('GET', '/api/audit')
  const auditRecs = JSON.parse(audit.body).records
  ok(auditRecs.some((r) => r.source === 'ai' && r.command === 'df -h'), 'AI 来源审计记录')
  ok(auditRecs.some((r) => r.source === 'manual' && r.command === 'echo manual-ok'), '手动来源审计记录')

  const notFound = await req('GET', '/api/nothing')
  ok(notFound.status === 404, '未知接口 404')

  child.kill()
  await new Promise((r) => setTimeout(r, 300))

  await testAnthropicConvert()
}

}

// 收尾：临时数据目录在系统 tmp，不必手动清理

// ---------- 单元：Anthropic 协议消息转换（定义于顶层，main 内 await 调用） ----------
async function testAnthropicConvert() {
  console.log('Anthropic 协议转换')
  {
    const aiMod = require('../agent/src/ai.js')
  // toAnthropicMessages 未导出，通过 mock 协议请求间接验证：
  // mock Anthropic 端点收 body 断言转换正确性
  const store = require('../agent/src/store')
  const tmpData2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lagent-ant-'))
  store.init(tmpData2)
  store.saveConfig({ token: 't', port: 1, ai: { protocol: 'anthropic', baseUrl: 'http://127.0.0.1:0', apiKey: 'k', model: 'm' }, createdAt: 1 })

  // 直接测转换：借助 anthropicStream 的前置转换逻辑，用本地 mock 服务器
  const http2 = require('http')
  const server = http2.createServer((req, res) => {
    let buf = ''
    req.on('data', (d) => (buf += d))
    req.on('end', () => {
      const body = JSON.parse(buf)
      ;(async () => {
        ok(body.model === 'm' && body.max_tokens === 8192, 'Anthropic 请求体：model/max_tokens')
        ok(typeof body.system === 'string' && body.system.includes('运维助手'), 'system 提到顶层（历史裁剪后也不丢）')
        const asst = body.messages.find((m) => m.role === 'assistant')
        ok(Array.isArray(asst.content) && asst.content[0].type === 'tool_use' && asst.content[0].input.command === 'df -h', 'tool_calls 转 tool_use 块')
        const userMsg = body.messages.find((m) => m.role === 'user' && Array.isArray(m.content))
        ok(userMsg && userMsg.content[0].type === 'tool_result', 'tool 结果转 tool_result 块')
        ok(body.tools && body.tools[0].name === 'run_command' && !!body.tools[0].input_schema, '工具定义转 input_schema')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ content: [{ type: 'text', text: 'anthropic-ok' }] }))
      })()
    })
  })
  const aiMod2 = aiMod // mock 服务器跑一次真实 runChat（anthropic 协议）
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  // 端口写回 baseUrl
  const cfg2 = store.loadConfig()
  cfg2.ai.baseUrl = `http://127.0.0.1:${server.address().port}`
  store.saveConfig(cfg2)
  // 预置带工具调用的历史（验证 OpenAI 风格存储 → Anthropic 块结构转换）
  store.saveChat([
    { role: 'user', content: '看下磁盘' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{"command":"df -h"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' }
  ])
  const evts = []
  await aiMod2.runChat('看下磁盘', (e) => evts.push(e), null)
  ok(evts.some((e) => e.type === 'delta' && e.text === 'anthropic-ok'), 'Anthropic 非流式兜底返回正文')
  server.close()
  }
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exitCode = failed ? 1 : 0
