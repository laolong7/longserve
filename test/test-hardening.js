// ============================================================
// 链路加固自动化测试（本地 mock，无需真实 key）
// 覆盖：超时看门狗 / 域名根模型列表 / 解密哨兵拦截 / 非流式 JSON 兜底
// 运行：node test/test-hardening.js
// ============================================================
const http = require('http')
const proxy = require('../main/ai-proxy.js')

let failures = 0
function check(name, cond) {
  console.log((cond ? '✅' : '❌') + ' ' + name)
  if (!cond) failures++
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function chat(provider, timeouts) {
  return new Promise((resolve) => {
    proxy.chatStream({
      eventId: 'h_' + Math.random().toString(36).slice(2),
      provider,
      timeouts,
      body: { messages: [{ role: 'user', content: 'hi' }] }
    }, (type, data) => {
      if (type === 'done') resolve({ done: true, data })
      if (type === 'error') resolve({ error: data.message })
    })
  })
}

async function main() {
  // ---- 1. 挂起服务器：必须超时报错，而不是永远等待 ----
  {
    const { server, port } = await listen(() => { /* 接受连接但永不响应 */ })
    const t0 = Date.now()
    const r = await chat(
      { protocol: 'anthropic', baseUrl: 'http://127.0.0.1:' + port + '/anthropic', apiKey: 'tp-x', model: 'm' },
      { first: 800, idle: 800, total: 5000 }
    )
    const ms = Date.now() - t0
    check('挂起网关触发超时（不永久卡死）', !!r.error && r.error.includes('超时'))
    check('超时耗时受控（<5s）', ms < 5000)
    server.close()
  }

  // ---- 2. 流开始后断流吊死：空闲超时生效 ----
  {
    const { server, port } = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
    })
    const r = await chat(
      { protocol: 'anthropic', baseUrl: 'http://127.0.0.1:' + port + '/anthropic', apiKey: 'tp-x', model: 'm' },
      { first: 2000, idle: 800, total: 5000 }
    )
    check('流中断流触发空闲超时', !!r.error && r.error.includes('超时'))
    server.close()
  }

  // ---- 3. 模型列表只挂在域名根（mimo 网关形态）也能找到 ----
  {
    const { server, port } = await listen((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'mimo-v2.6-pro' }] }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    const models = await proxy.listModels({
      protocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:' + port + '/anthropic',
      apiKey: 'tp-x'
    })
    check('模型列表域名根候选命中', models.includes('mimo-v2.6-pro'))
    server.close()
  }

  // ---- 4. 解密哨兵/空密钥直接拦截，不发请求 ----
  {
    const r1 = await chat({ protocol: 'anthropic', baseUrl: 'http://127.0.0.1:1/anthropic', apiKey: ' DECRYPT_FAILED', model: 'm' })
    check('哨兵密钥被拦截并提示解密失败', !!r1.error && r1.error.includes('解密失败'))
    const r2 = await chat({ protocol: 'anthropic', baseUrl: 'http://127.0.0.1:1/anthropic', apiKey: '  ', model: 'm' })
    check('空密钥被拦截并提示为空', !!r2.error && r2.error.includes('为空'))
  }

  // ---- 5. 中转站忽略 stream 返回完整 JSON：正常出内容 ----
  {
    const { server, port } = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        content: [{ type: 'text', text: '你好呀' }],
        usage: { output_tokens: 3 }
      }))
    })
    let content = ''
    const r = await new Promise((resolve) => {
      proxy.chatStream({
        eventId: 'h_json',
        provider: { protocol: 'anthropic', baseUrl: 'http://127.0.0.1:' + port + '/anthropic', apiKey: 'tp-x', model: 'm' },
        body: { messages: [{ role: 'user', content: 'hi' }] }
      }, (type, data) => {
        if (type === 'delta' && data.content) content += data.content
        if (type === 'done') resolve({ done: true })
        if (type === 'error') resolve({ error: data.message })
      })
    })
    check('非流式 JSON 兜底出内容', r.done && content === '你好呀')
    server.close()
  }

  // ---- 6. 200 + JSON 错误体（中转站怪癖）转成可见错误 ----
  {
    const { server, port } = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'model not found: m' } }))
    })
    const r = await chat({ protocol: 'anthropic', baseUrl: 'http://127.0.0.1:' + port + '/anthropic', apiKey: 'tp-x', model: 'm' })
    check('200+JSON 错误体被透传为错误', !!r.error && r.error.includes('model not found'))
    server.close()
  }

  console.log(failures === 0 ? '\n🎉 链路加固测试全部通过' : '\n💥 ' + failures + ' 项失败')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1) })
