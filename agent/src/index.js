// ============================================================
// Longserve Agent 入口：HTTP 服务 + API 路由 + 控制台静态托管
// 认证：除 /api/health 与静态资源外，全部接口要求 Bearer token
// （token 由桌面端部署时生成并注入 data/config.json，扫码即携带）
// 运行形态：Node SEA 单二进制（assets 内嵌控制台）或 node src/index.js 开发模式
// ============================================================
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { isSea, getAsset } = require('node:sea')

const store = require('./store')
const ai = require('./ai')
const status = require('./status')
const execMod = require('./exec')
const services = require('./services')

const PORT_DEFAULT = 37777

// ---------- 静态资源：SEA 内嵌优先，开发模式读磁盘 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2'
}

function readStatic(name) {
  try {
    // SEA 模式：assets 键即相对 public 的路径（见 build.mjs）；开发模式读磁盘
    if (isSea()) return Buffer.from(getAsset(name))
    return fs.readFileSync(path.join(__dirname, 'public', name))
  } catch {
    return null
  }
}

// ---------- 工具 ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (d) => {
      size += d.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(d)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

function bearerToken(req) {
  const h = req.headers['authorization'] || ''
  if (h.startsWith('Bearer ')) return h.slice(7).trim()
  return ''
}

// ---------- SSE ----------
function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no' // nginx 反代场景禁缓冲
  })
  res.write(': sse\n\n')
  // 心跳：防手机网络中间件掐断空闲连接
  const heartbeat = setInterval(() => {
    try { res.write(': hb\n\n') } catch { /* 连接已断 */ }
  }, 15000)
  return {
    emit(obj) {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch { /* 连接已断 */ }
    },
    close() {
      clearInterval(heartbeat)
      try { res.end() } catch { /* 已断 */ }
    }
  }
}

// ---------- 主循环状态 ----------
let chatRunning = false
let chatAbort = null

// ---------- 路由 ----------
async function handleApi(req, res, pathname, query) {
  // 健康检查：无需 token（部署后桌面端/控制台用它探活）
  if (pathname === '/api/health') {
    const cfg = store.loadConfig()
    return sendJson(res, 200, {
      ok: true,
      name: 'longserve-agent',
      version: store.VERSION,
      configured: !!cfg,
      aiConfigured: !!(cfg && cfg.ai && (cfg.ai.mock || cfg.ai.baseUrl))
    })
  }

  // 其余接口一律验 token
  const cfg = store.loadConfig()
  if (!cfg || !cfg.token) return sendJson(res, 503, { error: 'Agent 尚未初始化（缺少配置），请从桌面端重新部署' })
  const token = bearerToken(req) || query.get('token') || ''
  if (!token || token !== cfg.token) return sendJson(res, 401, { error: '未绑定或密钥无效，请重新扫码' })

  // ---- 绑定确认（扫码后第一步，校验 token 并返回服务器概况） ----
  if (pathname === '/api/bind' && req.method === 'POST') {
    const s = await status.collect()
    return sendJson(res, 200, {
      ok: true,
      server: { hostname: s.hostname, platform: s.platform, release: s.release, cores: s.cpu.cores },
      agentVersion: store.VERSION
    })
  }

  // ---- 状态总览 ----
  if (pathname === '/api/status' && req.method === 'GET') {
    const s = await status.collect()
    return sendJson(res, 200, { ok: true, status: s, pending: execMod.listPending() })
  }

  // ---- AI 会话 ----
  if (pathname === '/api/chat/history' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, messages: ai.history(), running: chatRunning })
  }
  if (pathname === '/api/chat/clear' && req.method === 'POST') {
    if (chatRunning) return sendJson(res, 409, { error: 'AI 正在处理，请先停止' })
    ai.clear()
    return sendJson(res, 200, { ok: true })
  }
  if (pathname === '/api/chat' && req.method === 'POST') {
    if (chatRunning) return sendJson(res, 409, { error: 'AI 正在处理上一条消息，请稍候' })
    const body = await readBody(req)
    const text = String(body.text || '').trim()
    if (!text) return sendJson(res, 400, { error: '消息不能为空' })

    const sse = openSse(res)
    chatRunning = true
    chatAbort = new AbortController()
    const finish = () => {
      chatRunning = false
      chatAbort = null
      sse.close()
    }
    // runChat 的 done/error 事件发出后由路由收尾（emit 闭包内拦截）
    const emit = (evt) => {
      sse.emit(evt)
      if (evt.type === 'done' || evt.type === 'error') finish()
    }
    ai.runChat(text, emit, chatAbort.signal).catch((err) => {
      emit({ type: 'error', message: '内部错误：' + err.message })
      finish()
    })
    return // SSE 长连接，不走 sendJson
  }
  if (pathname === '/api/chat/abort' && req.method === 'POST') {
    if (chatAbort) chatAbort.abort()
    return sendJson(res, 200, { ok: true })
  }

  // ---- 危险命令确认 ----
  if (pathname === '/api/pending' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, pending: execMod.listPending() })
  }
  // ---- 中止正在执行的命令（控制台 ^C） ----
  if (pathname === '/api/exec/abort' && req.method === 'POST') {
    const n = execMod.abortRunning()
    return sendJson(res, 200, { ok: true, aborted: n })
  }
  if (pathname === '/api/confirm' && req.method === 'POST') {
    const body = await readBody(req)
    const ok = execMod.resolveConfirm(String(body.id || ''), !!body.approve)
    return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: '确认请求不存在或已过期' })
  }

  // ---- 审计日志 ----
  if (pathname === '/api/audit' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, records: store.readAudit(200) })
  }

  // ---- 指令历史（磁盘重建的终端转写，重开页面不丢） ----
  if (pathname === '/api/exec/history' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, records: execTranscript(200) })
  }

  // ---- 服务控制（全部 systemd 服务） ----
  if (pathname === '/api/services' && req.method === 'GET') {
    try {
      return sendJson(res, 200, { ok: true, services: await services.list() })
    } catch (err) {
      return sendJson(res, 500, { error: err.message })
    }
  }
  if (pathname === '/api/services/action' && req.method === 'POST') {
    const body = await readBody(req)
    const name = String(body.name || '')
    const action = String(body.action || '')
    const ACTION_TEXT = services.ACTION_TEXT
    // 状态变更类操作一律两段式：先回 needConfirm，控制台确认后带 confirmed=true 重发
    if (!body.confirmed && ['stop', 'restart', 'disable'].includes(action)) {
      return sendJson(res, 200, {
        ok: true,
        needConfirm: true,
        reasons: [`将执行 systemctl ${action} ${name}`, '服务会中断，确定继续？']
      })
    }
    try {
      const r = await services.act(name, action)
      store.appendAudit({ time: Date.now(), source: 'manual', command: `systemctl ${action} ${name}`, danger: false, code: 0, output: r.output, note: ACTION_TEXT[action] || action })
      return sendJson(res, 200, { ok: true, output: r.output })
    } catch (err) {
      return sendJson(res, 500, { error: err.message })
    }
  }

  return sendJson(res, 404, { error: '接口不存在' })
}

// 从 audit.jsonl 重建指令终端转写：
//   完成记录（带 output）一命令一条；拒绝记录（approved===false）也保留；
//   跳过「等待确认」挂起记录与纯批准记录（结果都在完成记录里，避免重复）
function execTranscript(limit = 200) {
  return store
    .readAudit(1000)
    .filter((r) => r && (r.output || r.approved === false))
    .slice(0, limit)
    .reverse() // readAudit 新的在前 → 转写要旧的在前
}

// 手动指令（不经 AI 直接执行）：两段式危险确认 ——
// 第一段返回 needConfirm + 原因，控制台弹确认后带 confirmed=1 重发才真正执行
// （AI 来源的危险命令走 exec.requestExec 挂起；手动来源直接同步交互，无需挂起）
const { checkDanger } = require('./danger')

async function handleExec(req, res) {
  // 鉴权与 handleApi 同款（安全补丁：此入口曾漏掉 token 校验，等于裸奔的命令执行）
  const cfg = store.loadConfig()
  if (!cfg || !cfg.token) return sendJson(res, 503, { error: 'Agent 尚未初始化（缺少配置），请从桌面端重新部署' })
  const token = bearerToken(req) || ''
  if (!token || token !== cfg.token) return sendJson(res, 401, { error: '未绑定或密钥无效，请重新扫码' })

  const body = await readBody(req)
  const command = String(body.command || '').trim()
  if (!command) return sendJson(res, 400, { error: '命令不能为空' })
  const { danger, reasons } = checkDanger(command)
  if (danger) {
    if (!body.confirmed) {
      store.appendAudit({ time: Date.now(), source: 'manual', command, danger: true, approved: null, note: '等待确认' })
      return sendJson(res, 200, { ok: true, needConfirm: true, reasons })
    }
    store.appendAudit({ time: Date.now(), source: 'manual', command, danger: true, approved: true })
  } else {
    store.appendAudit({ time: Date.now(), source: 'manual', command, danger: false })
  }
  const r = await execMod.runShell(command)
  store.appendAudit({ time: Date.now(), source: 'manual', command, danger, code: r.code, output: execMod.summarize(r, 300) })
  const out = r.killed ? '※ 已中止（Ctrl+C）\n' + execMod.summarize(r) : execMod.summarize(r)
  return sendJson(res, 200, { ok: true, code: r.code, killed: !!r.killed, output: out })
}

// ---------- 静态资源 ----------
function handleStatic(res, pathname) {
  let name = pathname === '/' ? 'index.html' : pathname.slice(1)
  if (name.includes('..')) return sendJson(res, 400, { error: '非法路径' })
  let buf = readStatic(name)
  if (!buf && name === 'index.html') {
    return sendJson(res, 503, { error: '控制台资源缺失（构建产物未嵌入），请重新构建 Agent' })
  }
  if (!buf) {
    // SPA 兜底：未知路径回 index.html（前端路由）
    buf = readStatic('index.html')
    name = 'index.html'
  }
  if (!buf) return sendJson(res, 503, { error: '控制台资源缺失' })
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(name)] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  })
  res.end(buf)
}

// ---------- 启动 ----------
function main() {
  const args = process.argv.slice(2)
  const portArg = args.find((a) => /^--port=\d+$/.test(a))
  const dataArg = args.find((a) => a.startsWith('--data='))
  store.init(dataArg ? dataArg.slice(7) : undefined)

  const cfg = store.loadConfig()
  const port = Number(portArg && portArg.slice(7)) || (cfg && cfg.port) || PORT_DEFAULT

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost')
    const pathname = u.pathname
    const query = u.searchParams
    try {
      if (pathname.startsWith('/api/')) {
        if (pathname === '/api/exec') return await handleExec(req, res)
        return await handleApi(req, res, pathname, query)
      }
      return handleStatic(res, pathname)
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: err.message })
      else { try { res.end() } catch { /* 已断 */ } }
    }
  })

  server.listen(port, '0.0.0.0', () => {
    console.log(`[longserve-agent] v${store.VERSION} 已启动: http://0.0.0.0:${port}`)
    console.log(`[longserve-agent] 数据目录: ${store.dataPath()}`)
    if (!cfg) console.log('[longserve-agent] ⚠ 尚未初始化配置（应由桌面端部署流程写入 data/config.json）')
    else if (cfg.ai && cfg.ai.mock) console.log('[longserve-agent] ⚠ mock 模式：AI 返回本地假流，不会真实调用 AI')
  })

  // 优雅退出
  process.on('SIGTERM', () => server.close(() => process.exit(0)))
}

main()
