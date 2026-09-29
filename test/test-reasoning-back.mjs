// ============================================================
// 思考内容回传（reasoning_content）自动化测试（本地 mock，无需真实 key）
// 覆盖：buildOpenAiMessages 纯函数（回传/关闭/工具消息完整性）、
//       ai-proxy 转发 body 时 reasoning_content 字段原样到达服务器、
//       DeepSeek 场景模拟：第二轮请求 assistant 消息必须带 reasoning_content
// 运行：node test/test-reasoning-back.mjs
// ============================================================
import http from 'http'
import { buildOpenAiMessages, REASONING_ERR_RE } from '../renderer/utils/aictx.mjs'

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name) }
}

// ---- 纯函数：buildOpenAiMessages ----
console.log('buildOpenAiMessages 纯函数')

const history = [
  { role: 'user', content: '看下磁盘' },
  {
    role: 'assistant',
    content: '',
    reasoning: '用户想看磁盘，我应该先跑 df -h',
    toolCalls: [{ id: 'call_1', name: 'run_command', argsJson: '{"command":"df -h"}', result: '/dev/vda1 40G 20G 50%' }]
  },
  { role: 'assistant', content: '磁盘用了 50%', reasoning: '结果正常，汇报' }
]

{
  const out = buildOpenAiMessages(history, '系统提示', { reasoningBack: true })
  ok(out[0].role === 'system' && out[0].content === '系统提示', 'system 消息在首位')
  ok(out[1].role === 'user' && out[1].content === '看下磁盘', 'user 消息原样')
  const a1 = out[2]
  ok(a1.role === 'assistant' && a1.reasoning_content === '用户想看磁盘，我应该先跑 df -h', 'assistant 思考内容已回传（reasoning_content）')
  ok(a1.thinking === a1.reasoning_content, '思考内容同时以 thinking 字段回传（DeepSeek v4 校验字段）')
  ok(a1.tool_calls?.[0]?.function?.name === 'run_command', 'tool_calls 保留')
  ok(out[3].role === 'tool' && out[3].tool_call_id === 'call_1', '工具结果消息紧随其后')
  const a2 = out[4]
  ok(a2.reasoning_content === '结果正常，汇报', '第二条 assistant 思考内容已回传')
  ok(out.length === 5, '无多余消息')
}

{
  const out = buildOpenAiMessages(history, 's', { reasoningBack: false })
  ok(!('reasoning_content' in out[2]) && !('reasoning_content' in out[4]), '关闭开关时不回传思考内容')
}

{
  const out = buildOpenAiMessages(history, 's', {}) // 默认开启
  ok(!!out[2].reasoning_content, '默认（缺省参数）回传开启')
}

{
  // 空思考不产生字段
  const out = buildOpenAiMessages([{ role: 'assistant', content: 'hi', reasoning: '' }], 's', {})
  ok(!('reasoning_content' in out[1]), '空思考内容不加字段')
}

console.log('报错识别正则')
{
  ok(REASONING_ERR_RE.test('content[].thinking in the thinking mode must be passed back to the API'), 'DeepSeek 原文报错命中')
  ok(REASONING_ERR_RE.test('Unrecognized request argument supplied: reasoning_content'), 'OpenAI 严格校验报错命中')
  ok(!REASONING_ERR_RE.test('认证失败：用户名或密码错误'), '无关报错不命中')
}

// ---- 集成：ai-proxy 把 reasoning_content 原样转发到服务器 ----
console.log('ai-proxy 转发保真（DeepSeek 场景模拟）')
{
  // mock 服务器：第二轮请求校验 assistant 消息必须带 reasoning_content（模拟 DeepSeek 强校验）
  let receivedBodies = []
  const server = http.createServer((req, res) => {
    let buf = ''
    req.on('data', (d) => (buf += d))
    req.on('end', () => {
      const body = JSON.parse(buf)
      receivedBodies.push(body)
      const bad = body.messages.find(
        (m) => m.role === 'assistant' && m.tool_calls && !m.reasoning_content
      )
      if (bad) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'content[].thinking in the thinking mode must be passed back to the API' } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '好的' } }] }) + '\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const proxy = (await import('../main/ai-proxy.js')).default

  // 第一轮：带思考 + 工具调用的流式回复（mock 返回 '好的'，只验证请求链路通畅）
  let err1 = null
  await new Promise((resolve) => {
    proxy.chatStream({
      eventId: 'rb1',
      provider: { protocol: 'openai', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-test', model: 'deepseek-reasoner' },
      body: { messages: [{ role: 'user', content: '看下磁盘' }] }
    }, (type, data) => {
      if (type === 'error') err1 = data.message
      if (type === 'done' || type === 'error') resolve()
    })
  })
  ok(!err1, '第一轮请求正常完成' + (err1 ? '（' + err1 + '）' : ''))

  // 第二轮：带 reasoning_content 的 assistant 历史（渲染层 buildOpenAiMessages 的产物）
  const messages = buildOpenAiMessages(
    [
      { role: 'user', content: '看下磁盘' },
      { role: 'assistant', content: '', reasoning: '先 df -h', toolCalls: [{ id: 'c1', name: 'run_command', argsJson: '{"command":"df -h"}', result: 'ok' }] }
    ],
    's',
    { reasoningBack: true }
  )
  const deltas2 = []
  let err2 = null
  await new Promise((resolve) => {
    proxy.chatStream({
      eventId: 'rb2',
      provider: { protocol: 'openai', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-test', model: 'deepseek-reasoner' },
      body: { messages }
    }, (type, data) => {
      if (type === 'delta') deltas2.push(data)
      if (type === 'error') err2 = data.message
      if (type === 'done') resolve()
    })
  })
  ok(deltas2.some((d) => d.content === '好的'), '第二轮通过强校验并收到回复')
  ok(!err2, '第二轮无报错' + (err2 ? '（' + err2 + '）' : ''))
  ok(
    receivedBodies[1]?.messages.some((m) => m.role === 'assistant' && m.reasoning_content === '先 df -h'),
    'reasoning_content 字段经主进程转发后原样到达服务器'
  )

  // 反例：不带回传时服务器确实拒绝（验证 mock 强校验本身有效）
  let err3 = null
  await new Promise((resolve) => {
    proxy.chatStream({
      eventId: 'rb3',
      provider: { protocol: 'openai', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-test', model: 'deepseek-reasoner' },
      body: { messages: [
        { role: 'user', content: '看下磁盘' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' }
      ] }
    }, (type, data) => {
      if (type === 'error') err3 = data.message
      if (type === 'done' || type === 'error') resolve()
    })
  })
  ok(!!err3 && /thinking mode/.test(err3), '缺回传时确实被拒（复现了牢笼遇到的报错）')

  // Windows 下 process.exit 会与 undici 连接池收尾竞争触发 libuv 断言：
  // 先强断 keep-alive，等 server 关闭完成，再用 exitCode 自然退出（同 test-reasoning.js）
  server.closeAllConnections()
  await new Promise((r) => server.close(r))

  // ---- delta.thinking 字段识别（DeepSeek v4 思考模式流式字段） ----
  console.log('delta.thinking 字段识别')
  {
    const line = (obj) => `data: ${JSON.stringify(obj)}\n\n`
    const s2 = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(
        line({ choices: [{ delta: { thinking: '想一' } }] }) +
        line({ choices: [{ delta: { thinking: '下' } }] }) +
        line({ choices: [{ delta: { content: '答案' } }] }) +
        'data: [DONE]\n\n'
      )
    })
    await new Promise((r) => s2.listen(0, '127.0.0.1', r))
    const deltas = []
    await new Promise((resolve) => {
      proxy.chatStream({
        eventId: 'rb4',
        provider: { protocol: 'openai', baseUrl: `http://127.0.0.1:${s2.address().port}`, apiKey: 'k', model: 'm' },
        body: { messages: [{ role: 'user', content: 'hi' }] }
      }, (type, data) => {
        if (type === 'delta') deltas.push(data)
        if (type === 'done' || type === 'error') resolve()
      })
    })
    ok(deltas.filter((d) => d.reasoning).map((d) => d.reasoning).join('') === '想一下', 'delta.thinking 被识别为思考增量')
    ok(deltas.some((d) => d.content === '答案'), '正文增量不受影响')
    s2.closeAllConnections()
    await new Promise((r) => s2.close(r))
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  process.exitCode = failed ? 1 : 0
}
