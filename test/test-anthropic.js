// ============================================================
// Anthropic 协议转换自动化测试（本地 mock，无需真实 key）
// 运行：node test/test-anthropic.js   （需先启动 test/mock-anthropic.js）
// ============================================================
const proxy = require('../main/ai-proxy.js')

const provider = {
  protocol: 'anthropic',
  baseUrl: 'http://127.0.0.1:8787/anthropic',
  apiKey: 'tp-mock-test',
  model: 'mimo-v2.6-pro'
}

let failures = 0
function check(name, cond) {
  console.log((cond ? '✅' : '❌') + ' ' + name)
  if (!cond) failures++
}

async function main() {
  // ---- 第一轮：文本 + tool_use 分片 ----
  let content = ''
  const calls = {}
  await proxy.chatStream({
    eventId: 't1',
    provider,
    body: {
      messages: [{ role: 'user', content: '看看磁盘占用' }],
      tools: [{
        type: 'function',
        function: {
          name: 'run_command',
          description: '执行命令',
          parameters: { type: 'object', properties: { command: { type: 'string' } } }
        }
      }],
      temperature: 0.4
    }
  }, (type, data) => {
    if (type === 'delta') {
      if (data.content) content += data.content
      if (data.toolCalls) {
        for (const t of data.toolCalls) {
          calls[t.index] = calls[t.index] || { id: '', name: '', argsJson: '' }
          if (t.id) calls[t.index].id += t.id
          if (t.name) calls[t.index].name += t.name
          if (t.argsFragment) calls[t.index].argsJson += t.argsFragment
        }
      }
    } else if (type === 'error') {
      console.log('ERROR:', data.message)
      process.exit(1)
    }
  })

  check('第一轮收到文本', content.includes('磁盘占用'))
  const tc = calls[1]
  check('第一轮 tool_use 块（index=1）解析出名称', tc && tc.name === 'run_command')
  check('tool_use id 正确', tc && tc.id === 'toolu_mock_01')
  let args = {}
  try { args = JSON.parse(tc ? tc.argsJson : '{}') } catch { /* 分片损坏 */ }
  check('参数分片跨块拼接正确（df -h）', args.command === 'df -h')
  check('purpose 字段完整（中文分片）', args.purpose === '查看磁盘')

  // ---- 第二轮：带 tool_result 回传 ----
  let c2 = ''
  await proxy.chatStream({
    eventId: 't2',
    provider,
    body: {
      messages: [
        { role: 'user', content: '看看磁盘占用' },
        {
          role: 'assistant',
          content: '好的，我来查看磁盘占用。',
          tool_calls: [{
            id: 'toolu_mock_01',
            type: 'function',
            function: { name: 'run_command', arguments: '{"command":"df -h"}' }
          }]
        },
        { role: 'tool', tool_call_id: 'toolu_mock_01', content: '/dev/sda1 22% used' }
      ]
    }
  }, (type, data) => {
    if (type === 'delta' && data.content) c2 += data.content
    if (type === 'error') {
      console.log('ERROR2:', data.message)
      process.exit(1)
    }
  })
  check('第二轮 tool_result 转换 + 文本总结', c2.includes('22%'))

  // ---- 模型列表 ----
  const models = await proxy.listModels(provider)
  check('模型列表（Anthropic 分支）', models.includes('mimo-v2.6-pro'))

  console.log(failures === 0 ? '\n🎉 Anthropic 协议测试全部通过' : `\n💥 ${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error('测试异常:', e.message); process.exit(1) })
