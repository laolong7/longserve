// ============================================================
// 本地 Mock Anthropic Messages API（自检专用，只监听 127.0.0.1）
// 验证 ai-proxy 的 Anthropic 协议分支：
//   1. 纯文本流式回复
//   2. tool_use 调用 -> 客户端回 tool_result -> 文本总结
//   3. 模型列表 /v1/models
// 用法：node test/mock-anthropic.js [端口]
// ============================================================
const http = require('http')
const crypto = require('crypto')

const PORT = Number(process.argv[2]) || 8787

function sse(res, obj) {
  res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`)
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    console.log('[mock-anthropic]', req.method, req.url)

    // 模型列表
    if (req.method === 'GET' && req.url.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mimo-v2.6-pro' }, { id: 'mimo-v2.6-pro[1M]' }] }))
      return
    }

    if (req.method !== 'POST' || !req.url.includes('/messages')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }

    // 协议校验：认证头与版本头
    if (!req.headers['x-api-key'] && !req.headers.authorization) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'missing auth' } }))
      return
    }
    if (!req.headers['anthropic-version']) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'missing anthropic-version' } }))
      return
    }

    let payload
    try { payload = JSON.parse(body) } catch { payload = {} }
    const hasToolResult = (payload.messages || []).some((m) =>
      Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result')
    )
    console.log('[mock-anthropic] model=%s msgs=%d toolResult=%s',
      payload.model, (payload.messages || []).length, hasToolResult)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })

    let i = 0
    const step = (fn) => setTimeout(fn, 30 * ++i)

    if (!hasToolResult) {
      // 第一轮：先说一句话，然后发起 tool_use（模拟 AI 要执行命令）
      step(() => sse(res, { type: 'message_start', message: { usage: { input_tokens: 100 } } }))
      step(() => sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      step(() => sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好的，我来查看磁盘占用。' } }))
      step(() => sse(res, { type: 'content_block_stop', index: 0 }))
      step(() => sse(res, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_mock_01', name: 'run_command' } }))
      step(() => sse(res, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"df -h","purpose":' } }))
      step(() => sse(res, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"查看磁盘"}' } }))
      step(() => sse(res, { type: 'content_block_stop', index: 1 }))
      step(() => sse(res, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 50 } }))
      step(() => sse(res, { type: 'message_stop' }))
      setTimeout(() => res.end(), 30 * ++i)
    } else {
      // 第二轮：拿到 tool_result 后给文本总结
      step(() => sse(res, { type: 'message_start', message: { usage: { input_tokens: 300 } } }))
      step(() => sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      step(() => sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '磁盘使用率 22%，状态健康，无需处理。' } }))
      step(() => sse(res, { type: 'content_block_stop', index: 0 }))
      step(() => sse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } }))
      step(() => sse(res, { type: 'message_stop' }))
      setTimeout(() => res.end(), 30 * ++i)
    }
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-anthropic] listening 127.0.0.1:${PORT}`)
})
