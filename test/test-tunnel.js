// ============================================================
// 隧道 / exec / 质量采样集成测试（本地 mock ssh server，无需真实服务器）
// 覆盖：
//   - ssh-manager.exec 收集式执行（含超时看门狗）
//   - 质量监控首采样（conn:quality 事件）
//   - 本地转发(-L)完整链路：本机监听 → forwardOut → mock tcpip echo
//   - stopTunnel 后端口不再接受连接；连接断开自动清理隧道
// 运行：node test/test-tunnel.js
// ============================================================
const ssh2 = require('ssh2')
const net = require('net')
const SshManager = require('../main/ssh-manager')

let failures = 0
function check(name, cond) {
  console.log((cond ? '✅' : '❌') + ' ' + name)
  if (!cond) failures++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 与 mock-ssh.js 的 systemctl 样例保持一致（服务面板解析契约：ACTIVE 是第 3 列）
const SYSTEMD_SAMPLE = [
  'nginx.service    loaded active   running  A high performance web server',
  'docker.service   loaded inactive dead     Docker Application Container Engine',
  'broken.service   loaded failed   failed  Some broken unit'
].join('\n') + '\n'

// ---------- mock ssh server：exec + tcpip(echo) ----------
function startMockSsh() {
  const { private: key } = ssh2.utils.generateKeyPairSync('ed25519')
  return new Promise((resolve) => {
    const server = new ssh2.Server({ hostKeys: [key] }, (client) => {
      client.on('authentication', (ctx) => ctx.accept())
      client.on('ready', () => {
        client.on('session', (accept) => {
          const s = accept()
          // ssh-manager 连接时会请求 pty + shell（mock 只需要 accept，shell 不用）
          s.on('pty', (a) => a())
          s.on('shell', (a) => {
            const ch = a()
            ch.write('mock shell ready\r\n')
          })
          s.on('exec', (acceptExec, _rej, info) => {
            const ch = acceptExec()
            const cmd = (info.command || '').trim()
            if (cmd === 'true' || cmd === ':') { ch.exit(0); ch.close() }
            else if (cmd.startsWith('systemctl')) { ch.write(SYSTEMD_SAMPLE); ch.exit(0); ch.close() }
            else if (cmd === 'sleep-forever') { /* 挂住：等 exec 超时看门狗踢 */ }
            else { ch.stderr.write('mock: not found\n'); ch.exit(127); ch.close() }
          })
        })
        // forwardOut：mock 把流量接进内置 echo（验证整条转发链路）
        client.on('tcpip', (accept, _rej, info) => {
          const ch = accept()
          ch.write(`echo:${info.destIP}:${info.destPort}\n`)
          ch.on('data', (d) => ch.write(d))
          ch.on('error', () => {})
        })
        // 远程转发 forwardIn 的协议层请求：真实 OpenSSH 原生支持，mock 手动 accept
        client.on('request', (accept, reject, name, info) => {
          if (name === 'tcpip-forward' && accept) accept(info.bindPort || 0)
          else if (name === 'cancel-tcpip-forward' && accept) accept()
          else if (reject) reject()
        })
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

// 本机监听端口可用性
function probePort(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
  })
}
// 经隧道发一句并收全部回声
function roundTrip(port, payload) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1')
    let out = ''
    s.on('data', (d) => { out += d.toString('utf8') })
    s.on('connect', () => s.write(payload))
    setTimeout(() => { s.destroy(); resolve(out) }, 700)
    s.on('error', reject)
  })
}

let server = null // mock server（finally 统一关闭）

async function main() {
  events = []
  const mgr = new SshManager((ch, payload) => events.push({ ch, payload }))
  const mock = await startMockSsh()
  server = mock.server
  const port = mock.port
  try {
    await runTests(mgr, port)
  } catch (err) {
    console.error('测试执行异常:', err)
    failures = 1
  }
  // fs.writeSync 同步写 stdout：管道下 process.exit 会截断异步缓冲的 console.log
  try { server && server.close() } catch { /* 忽略 */ }
  const fs = require('fs')
  fs.writeSync(1, failures ? `\n共 ${failures} 项失败\n` : '\n全部通过\n')
  process.exit(failures ? 1 : 0)
}

let events = [] // conn:quality 等事件收集（runTests 里断言用）
async function runTests(mgr, port) {

  // ---- 连接 ----
  const conn = await mgr.connect({ host: '127.0.0.1', port, username: 'u', password: 'p' })
  const connId = conn.connId
  check('SSH mock 连接成功', !!connId)

  // ---- 质量监控首采样（startQualityMonitor 连接成功即跑一次） ----
  await wait(600)
  const q = events.find((e) => e.ch.startsWith('conn:quality:'))
  check('质量采样事件发出且 RTT 有效', !!q && q.payload.ok === true && typeof q.payload.rtt === 'number')

  // ---- exec ----
  const r1 = await mgr.exec(connId, 'true', 3000)
  check('exec true 返回 exit 0', r1.code === 0)
  const r2 = await mgr.exec(connId, 'systemctl list-units', 3000)
  check('exec systemctl 样例输出（含 nginx.service）', r2.stdout.includes('nginx.service'))
  // 契约自证：ACTIVE 在第 3 列（服务面板解析修复的回归锚点）
  const line = r2.stdout.split('\n')[0].trim().split(/\s+/)
  check('systemd 输出 ACTIVE=parts[2]（nginx 为 active）', line[2] === 'active')
  try {
    await mgr.exec(connId, 'sleep-forever', 800)
    check('exec 挂起命令被超时看门狗中断', false)
  } catch (e) {
    check('exec 挂起命令被超时看门狗中断', /超时/.test(e.message))
  }

  // ---- 本地转发 -L ----
  const LISTEN = 13456
  const add = await mgr.addTunnel(connId, {
    type: 'local', listenHost: '127.0.0.1', listenPort: LISTEN, targetHost: '127.0.0.1', targetPort: 9999
  })
  check('本地隧道建立（监听 13456）', !!add.tunnelId)
  await wait(150)
  check('监听端口已就绪', await probePort(LISTEN))
  const echo = await roundTrip(LISTEN, 'ping-through-tunnel\n')
  check('转发链路回声可达（mock 收到 dst 并回显）', echo.includes('echo:127.0.0.1:9999') && echo.includes('ping-through-tunnel'))
  check('tunnel:list 返回 1 条', mgr.listTunnels(connId).length === 1)

  // ---- stopTunnel ----
  mgr.stopTunnel(add.tunnelId)
  await wait(200)
  check('停止后监听端口已关闭', !(await probePort(LISTEN)))

  // ---- 连接断开自动清理 ----
  await mgr.addTunnel(connId, {
    type: 'local', listenHost: '127.0.0.1', listenPort: 13457, targetHost: '127.0.0.1', targetPort: 80
  })
  await wait(150)
  mgr.close(connId)
  await wait(300)
  check('连接断开后隧道自动清理', mgr.listTunnels(connId).length === 0)
  check('断开后隧道端口已释放', !(await probePort(13457)))

  // ---- 远程转发 -R：协议握手验证（forwardIn 请求被接受） ----
  const conn2 = await mgr.connect({ host: '127.0.0.1', port, username: 'u', password: 'p' })
  const add2 = await mgr.addTunnel(conn2.connId, {
    type: 'remote', bindHost: '127.0.0.1', bindPort: 13458, targetHost: '127.0.0.1', targetPort: 80
  })
  check('远程隧道 forwardIn 请求被接受', !!add2.tunnelId)
  mgr.stopTunnel(add2.tunnelId)
  mgr.close(conn2.connId)
}

// 统一收尾：挂住的 exec channel / mock server 会拖住事件循环，异常路径直接退
function finish(code) {
  try { server && server.close() } catch { /* 忽略 */ }
  const fs = require('fs')
  fs.writeSync(1, failures ? `\n共 ${failures} 项失败\n` : '\n全部通过\n')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error('测试执行异常:', e)
  finish(1)
})
