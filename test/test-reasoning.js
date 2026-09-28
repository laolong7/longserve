// ============================================================
// 思考流式转发自动化测试（本地 mock，无需真实 key）
// 覆盖：OpenAI reasoning_content / reasoning 双字段、Anthropic thinking_delta、
//       非流式 JSON 兜底带思考、正文增量不受影响
// 运行：node test/test-reasoning.js
// ============================================================
const http = require('http')
const proxy = require('../main/ai-proxy.js')

let failures = 0
function check(name, cond) {
  console.log((cond ? '✅' : '❌') + ' ' + name)
  if (!cond) failures++
}

const servers = [] // 统一收口：等全部关闭再退出，避免 Windows 上 libuv 断言崩溃
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

// 采集一次对话的全部 delta 事件
function chat(provider) {
  return new Promise((resolve) => {
    const deltas = []
    proxy.chatStream({
      eventId: 'r_' + Math.random().toString(36).slice(2),
      provider,
      body: { messages: [{ role: 'user', content: 'hi' }] }
    }, (type, data) => {
      if (type === 'delta') deltas.push(data)
      if (type === 'done') resolve({ deltas })
      if (type === 'error') resolve({ deltas, error: data.message })
    })
  })
}

const sseLine = (obj) => `data: ${JSON.stringify(obj)}\n\n`

async function main() {
  // ---- 1. OpenAI 兼容：delta.reasoning_content（DeepSeek-R1 风格）----
  {
    const { server, port } = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(
        sseLine({ choices: [{ delta: { reasoning_content: '先想' } }], model: 'm' }) +
        sseLine({ choices: [{ delta: { reasoning_content: '一下' } }], model: 'm' }) +
        sseLine({ choices: [{ delta: { content: '答案是 42' } }], model: 'm' }) +
        'data: [DONE]\n\n'
      )
    })
    const r = await chat({ protocol: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-x', model: 'm' })
    const reasoning = r.deltas.filter((d) => d.reasoning).map((d) => d.reasoning).join('')
    const content = r.deltas.filter((d) => d.content).map((d) => d.content).join('')
    check('OpenAI reasoning_content 逐块转发', reasoning === '先想一下')
    check('正文增量不受影响', content === '答案是 42')
    server.close()
  }

  // ---- 2. OpenAI 兼容：delta.reasoning（部分网关的字段名）----
  {
    const { server, port } = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(sseLine({ choices: [{ delta: { reasoning: '思考中' } }] }) + 'data: [DONE]\n\n')
    })
    const r = await chat({ protocol: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-x', model: 'm' })
    const reasoning = r.deltas.filter((d) => d.reasoning).map((d) => d.reasoning).join('')
    check('OpenAI reasoning 字段同样转发', reasoning === '思考中')
    server.close()
  }

  // ---- 3. Anthropic 原生：thinking_delta ----
  {
    const { server, port } = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(
        sseLine({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }) +
        sseLine({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '深呼吸' } }) +
        sseLine({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }) +
        sseLine({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } }) +
        sseLine({ type: 'message_stop' })
      )
    })
    const r = await chat({ protocol: 'anthropic', baseUrl: `http://127.0.0.1:${port}/anthropic`, apiKey: 'tp-x', model: 'm' })
    const reasoning = r.deltas.filter((d) => d.reasoning).map((d) => d.reasoning).join('')
    const content = r.deltas.filter((d) => d.content).map((d) => d.content).join('')
    check('Anthropic thinking_delta 流式转发', reasoning === '深呼吸')
    check('Anthropic 正文不受影响', content === '你好')
    server.close()
  }

  // ---- 4. 非流式 JSON 兜底：message 带 reasoning_content ----
  {
    const { server, port } = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { reasoning_content: '整段思考', content: '整段回答' } }]
      }))
    })
    const r = await chat({ protocol: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-x', model: 'm' })
    const reasoning = r.deltas.filter((d) => d.reasoning).map((d) => d.reasoning).join('')
    const content = r.deltas.filter((d) => d.content).map((d) => d.content).join('')
    check('非流式 JSON 思考一次性转发', reasoning === '整段思考')
    check('非流式 JSON 正文转发', content === '整段回答')
    server.close()
  }

  console.log(failures ? `\n共 ${failures} 项失败` : '\n全部通过')
  // 等所有 mock server 关闭，用 exitCode 自然退出：
  // Windows 下 process.exit 会与 undici 连接池收尾竞争触发 libuv 断言（exit 127）
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))))
  process.exitCode = failures ? 1 : 0
}

main().catch((e) => { console.error('测试执行异常:', e); process.exit(1) })
