// ============================================================
// AI 会话循环（OpenAI 兼容协议，流式 + 原生 function calling）
// 设计要点：
//   1. 会话历史由 Agent 持有（data/chat.json），手机只是视图——
//      刷新页面、换设备、断线重连都不丢对话
//   2. assistant 思考内容（reasoning_content）随历史保存并逐轮回传：
//      DeepSeek 思考模式 + 工具调用同时开启时 API 强制要求，缺了直接拒绝
//   3. 工具循环最多 8 轮；run_command 走 exec.requestExec，
//      危险命令挂起等待手机确认，确认事件经 SSE 推给控制台
//   4. mock 模式（config.ai.mock）：本地生成假流，无 key 全链路自测
// ============================================================
const store = require('./store')
const execMod = require('./exec')
const status = require('./status')

const MAX_HOPS = 8

// ---------- 工具定义（OpenAI tools 格式，Agent 版最小集） ----------
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        '在本服务器上执行一条 shell 命令并返回输出。删除、重启、改配置等危险命令会被拦截，需用户在手机上确认后才会执行。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的完整命令' },
          purpose: { type: 'string', description: '一句话说明执行目的' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'server_status',
      description: '采集服务器当前状态：CPU/内存/磁盘/负载/运行时长。用户问服务器状态时优先用这个而不是手敲命令。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出服务器上指定目录的内容。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '目录绝对路径，如 /var/www' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取服务器上的文本文件内容（限 100KB），用于查看配置、日志等。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '文件绝对路径' } },
        required: ['path']
      }
    }
  }
]

function systemPrompt() {
  const os = require('os')
  return (
    `你是服务器「${os.hostname()}」的 AI 运维助手，通过 Longserve 手机控制台与用户对话。\n` +
    `当前服务器：${os.platform()} ${os.release()} ${os.arch()}，${os.cpus().length} 核。\n\n` +
    `工作守则：\n` +
    `1. 需要实际操作时用 run_command 执行，执行前先用一句话说明目的\n` +
    `2. 删除/重启/改配置等重大操作会被系统拦截并请用户在手机上确认；被拒绝时不要重试同一命令，先询问用户\n` +
    `3. 执行后查看命令输出确认结果，再向用户汇报\n` +
    `4. 只做与用户需求相关的操作，不做多余动作\n` +
    `5. 回答用中文，简洁专业；手机屏幕小，汇报尽量短`
  )
}

// ---------- 工具执行 ----------
async function execTool(name, args, emit) {
  if (name === 'run_command') {
    const cmd = (args.command || '').trim()
    if (!cmd) return '[错误] 命令为空'
    const r = await execMod.requestExec(cmd, 'ai', (evt) => emit(evt)) // 危险命令挂起时推 confirm 事件
    return r.output
  }
  if (name === 'server_status') {
    const s = await status.collect()
    return status.toText(s)
  }
  if (name === 'list_dir') {
    const fs = require('fs')
    try {
      const items = fs.readdirSync(args.path, { withFileTypes: true })
      if (!items.length) return '（目录为空）'
      return items.slice(0, 100).map((it) => (it.isDirectory() ? 'd ' : '- ') + it.name).join('\n')
    } catch (err) {
      return '[错误] ' + err.message
    }
  }
  if (name === 'read_file') {
    const fs = require('fs')
    try {
      const st = fs.statSync(args.path)
      if (st.isDirectory()) return '[错误] 目标是目录，请用 list_dir'
      if (st.size > 100 * 1024) return `[错误] 文件过大（${Math.round(st.size / 1024)}KB），仅支持 100KB 内文本文件`
      return fs.readFileSync(args.path, 'utf8')
    } catch (err) {
      return '[错误] ' + err.message
    }
  }
  return `[错误] 未知工具 ${name}`
}

// ---------- mock 流（无 key 自测全链路） ----------
// 剧本：第一轮输出思考 + 调 run_command('df -h')；拿到工具结果后输出总结
function mockStream(messages, handlers, signal) {
  const last = messages[messages.length - 1]
  const hasToolResult = messages.some((m) => m.role === 'tool')
  return new Promise((resolve, reject) => {
    const step = (fn, delay) => setTimeout(fn, delay)
    let i = 0
    const timer = setInterval(() => {
      if (signal && signal.aborted) {
        clearInterval(timer)
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
        return
      }
      i++
      if (!hasToolResult) {
        if (i === 1) handlers.onReasoning('（mock）用户想了解磁盘，先跑 df -h 看一眼。')
        if (i === 2) handlers.onReasoning(' 磁盘信息是只读操作，无需确认。')
        if (i === 3) {
          handlers.onToolCall({ index: 0, id: 'call_mock_1', name: 'run_command', argsFragment: '{"command":' })
        }
        if (i === 4) handlers.onToolCall({ index: 0, argsFragment: '"df -h", "purpose": "查看磁盘占用"}' })
        if (i >= 5) {
          clearInterval(timer)
          resolve()
        }
      } else {
        if (i === 1) handlers.onReasoning('（mock）df -h 结果已拿到，汇报给用户。')
        if (i === 2) handlers.onDelta('【mock 模式】磁盘检查完成：根分区使用率正常，详情见上方命令输出。')
        if (i >= 3) {
          clearInterval(timer)
          resolve()
        }
      }
    }, 60)
    if (signal) signal.addEventListener('abort', () => {
      clearInterval(timer)
      const err = new Error('aborted')
      err.name = 'AbortError'
      reject(err)
    }, { once: true })
    void last
  })
}

// ---------- Anthropic 原生协议适配 ----------
// 存储统一为 OpenAI 风格（含 reasoning_content/thinking），仅请求时按协议转换；
// Anthropic 侧不做思考回传（thinking block 需要 signature，多轮不携带是允许的）

// OpenAI 风格 messages -> Anthropic 风格（system 提顶层、tool 转块、连续 user 合并）
function toAnthropicMessages(openAiMessages) {
  let system
  const out = []
  for (const m of openAiMessages) {
    if (m.role === 'system') {
      system = system ? system + '\n\n' + m.content : m.content
      continue
    }
    if (m.role === 'user') {
      const last = out[out.length - 1]
      if (last && last.role === 'user' && typeof last.content === 'string' && typeof m.content === 'string') {
        last.content += '\n\n' + m.content
      } else {
        out.push({ role: 'user', content: m.content })
      }
    } else if (m.role === 'assistant') {
      const content = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const tc of m.tool_calls || []) {
        let input = {}
        try { input = JSON.parse(tc.function.arguments || '{}') } catch { /* 空参数 */ }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
      }
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '（空）' }] })
    } else if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content || '' }
      const last = out[out.length - 1]
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0] && last.content[0].type === 'tool_result') {
        last.content.push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
    }
  }
  return { system, messages: out }
}

async function anthropicStream(ai, messages, handlers, signal) {
  let base = (ai.baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('AI 配置缺少请求地址（baseUrl）')
  if (!base.endsWith('/messages')) base += '/v1/messages'

  const { system, messages: am } = toAnthropicMessages(messages)
  const payload = {
    model: ai.model,
    max_tokens: Number(ai.maxTokens) || 8192,
    stream: true,
    messages: am
  }
  if (system) payload.system = system
  payload.tools = TOOLS.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters
  }))

  const res = await fetch(base, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ai.apiKey || ''}`,
      'x-api-key': ai.apiKey || '',
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(payload),
    signal
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let msg = `AI 请求失败（HTTP ${res.status}）`
    try { msg = JSON.parse(text).error?.message || msg } catch { if (text) msg += '：' + text.slice(0, 200) }
    throw new Error(msg)
  }

  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) {
    const j = await res.json()
    if (j.error) throw new Error(j.error.message || String(j.error))
    let idx = 0
    for (const block of j.content || []) {
      if (block.type === 'text' && block.text) handlers.onDelta(block.text)
      else if (block.type === 'tool_use') {
        handlers.onToolCall({ index: idx++, id: block.id, name: block.name, argsFragment: JSON.stringify(block.input || {}) })
      }
    }
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payloadStr = line.slice(5).trim()
      if (!payloadStr) continue
      let ev
      try { ev = JSON.parse(payloadStr) } catch { continue }

      if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
        handlers.onToolCall({ index: ev.index, id: ev.content_block.id, name: ev.content_block.name, argsFragment: '' })
      } else if (ev.type === 'content_block_delta' && ev.delta) {
        if (ev.delta.type === 'text_delta' && ev.delta.text) handlers.onDelta(ev.delta.text)
        else if (ev.delta.type === 'input_json_delta' && ev.delta.partial_json) {
          handlers.onToolCall({ index: ev.index, argsFragment: ev.delta.partial_json })
        }
      } else if (ev.type === 'message_stop') {
        return
      } else if (ev.type === 'error') {
        throw new Error((ev.error && ev.error.message) || 'Anthropic 流错误')
      }
    }
  }
}

// ---------- OpenAI 兼容流式请求 ----------
// onDelta/onReasoning 增量回调；onToolCall 增量聚合（index/id/name/argsFragment）
// extraBody/extraHeaders：AI 配置的高级出口（DeepSeek thinking 参数、特殊网关头等）
async function openaiStream(ai, messages, handlers, signal) {
  let url = (ai.baseUrl || '').trim().replace(/\/+$/, '')
  if (!url) throw new Error('AI 配置缺少请求地址（baseUrl）')
  if (!url.endsWith('/chat/completions')) {
    url = /\/v\d+(beta)?$/.test(url) ? url + '/chat/completions' : url + '/v1/chat/completions'
  }

  const payload = { model: ai.model, stream: true, messages, tools: TOOLS, temperature: 0.4 }
  try {
    const b = ai.extraBody ? JSON.parse(ai.extraBody) : null
    if (b && typeof b === 'object') Object.assign(payload, b)
  } catch { /* 配置写错不阻塞请求 */ }
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${ai.apiKey || ''}` }
  try {
    const h = ai.extraHeaders ? JSON.parse(ai.extraHeaders) : null
    if (h && typeof h === 'object') Object.assign(headers, h)
  } catch { /* 同上 */ }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let msg = `AI 请求失败（HTTP ${res.status}）`
    try { msg = JSON.parse(text).error?.message || msg } catch { if (text) msg += '：' + text.slice(0, 200) }
    throw new Error(msg)
  }

  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) {
    // 中转站忽略 stream 参数的非流式兜底
    const j = await res.json()
    if (j.error) throw new Error(j.error.message || String(j.error))
    const m = j.choices && j.choices[0] && j.choices[0].message
    if (m) {
      if (m.reasoning_content || m.reasoning || m.thinking) {
        handlers.onReasoning(m.reasoning_content || m.reasoning || m.thinking)
      }
      if (m.content) handlers.onDelta(m.content)
      if (Array.isArray(m.tool_calls)) {
        for (const [i, tc] of m.tool_calls.entries()) {
          handlers.onToolCall({
            index: tc.index != null ? tc.index : i,
            id: tc.id,
            name: tc.function && tc.function.name,
            argsFragment: (tc.function && tc.function.arguments) || ''
          })
        }
      }
    }
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const chunk = JSON.parse(payload)
        const choice = chunk.choices && chunk.choices[0]
        if (!choice) continue
        const delta = choice.delta || {}
        // 思考字段三家并存：reasoning_content / reasoning / thinking（DeepSeek v4 思考模式）
        const reasoning = delta.reasoning_content || delta.reasoning || delta.thinking
        if (reasoning) handlers.onReasoning(reasoning)
        if (delta.content) handlers.onDelta(delta.content)
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
          for (const tc of delta.tool_calls) {
            handlers.onToolCall({
              index: tc.index,
              id: tc.id,
              name: tc.function && tc.function.name,
              argsFragment: tc.function && tc.function.arguments
            })
          }
        }
      } catch { /* 心跳等非 JSON 行忽略 */ }
    }
  }
}

// ---------- 会话循环 ----------
// text: 用户新消息；emit: SSE 事件出口；signal: 中断信号
async function runChat(text, emit, signal) {
  const cfg = store.loadConfig()
  const ai = (cfg && cfg.ai) || {}
  if (!ai.baseUrl && !ai.mock) {
    emit({ type: 'error', message: 'Agent 尚未配置 AI（部署时需在桌面端选择 AI 配置）' })
    return
  }

  const messages = store.loadChat()
  // system 提示始终保持在首位（历史按条数裁剪时可能把开头的 system 切掉）
  if (!messages.length || messages[0].role !== 'system') {
    messages.unshift({ role: 'system', content: systemPrompt() })
  }
  messages.push({ role: 'user', content: text })

  try {
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      // 增量聚合容器
      let content = ''
      let reasoning = ''
      const pendingCalls = []
      const handlers = {
        onDelta(t) { content += t; emit({ type: 'delta', text: t }) },
        onReasoning(t) { reasoning += t; emit({ type: 'reasoning', text: t }) },
        onToolCall(tc) {
          let cur = pendingCalls[tc.index]
          if (!cur) cur = pendingCalls[tc.index] = { id: '', name: '', argsJson: '' }
          if (tc.id) cur.id += tc.id
          if (tc.name) cur.name += tc.name
          if (tc.argsFragment) cur.argsJson += tc.argsFragment
        }
      }

      if (ai.mock) await mockStream(messages, handlers, signal)
      else if (ai.protocol === 'anthropic') await anthropicStream(ai, messages, handlers, signal)
      else await openaiStream(ai, messages, handlers, signal)

      // 组装 assistant 消息：思考内容必须随消息保存并回传（DeepSeek 强制要求）。
      // 关键：携带 tools 的请求里【每条】assistant 消息都要带 reasoning_content 字段
      // （无思考回传空串），缺字段必 400 "must be passed back"。
      // thinking 字段按配置携带（个别网关校验用；默认只带 reasoning_content）
      const assistant = { role: 'assistant', content: content || null }
      const fieldMode = ai.reasoningField || 'auto'
      if (ai.reasoningBack !== false) {
        if (fieldMode === 'reasoning_content' || fieldMode === 'auto' || fieldMode === 'both') {
          assistant.reasoning_content = reasoning || ''
        }
        if (fieldMode === 'thinking' || fieldMode === 'both') {
          assistant.thinking = reasoning || ''
        }
      }
      const calls = pendingCalls.filter(Boolean).map((c, i) => ({
        id: c.id || `call_${Date.now()}_${i}`,
        type: 'function',
        function: { name: c.name, arguments: c.argsJson || '{}' }
      }))
      if (calls.length) {
        assistant.tool_calls = calls
      } else if (!content) {
        // 只思考无正文无工具的轮次：双空会被 DeepSeek 拒（Invalid assistant message）
        assistant.content = ' '
      }
      messages.push(assistant)

      if (!calls.length) break // 纯回复，循环结束

      // 逐个执行工具，结果作为 tool 消息回填后继续下一轮
      for (const call of calls) {
        let args = {}
        try { args = JSON.parse(call.function.arguments || '{}') } catch { /* 参数坏按空处理 */ }
        emit({ type: 'tool', id: call.id, name: call.function.name, args, purpose: args.purpose || '' })
        const result = await execTool(call.function.name, args, emit)
        const brief = result.length > 4000 ? result.slice(0, 4000) + '…（已截断）' : result
        emit({ type: 'tool_result', id: call.id, brief })
        messages.push({ role: 'tool', tool_call_id: call.id, content: result })
      }
    }
    store.saveChat(messages)
    emit({ type: 'done' })
  } catch (err) {
    store.saveChat(messages) // 中断/报错也落盘，已生成的内容不丢
    if (err.name === 'AbortError') emit({ type: 'done', aborted: true })
    else emit({ type: 'error', message: err.message })
  }
}

function history() {
  const messages = store.loadChat()
  // 视图裁剪：system 不下发；tool 原始输出太长的裁短（完整版在 Agent 手里）
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'tool') {
        const brief = m.content && m.content.length > 1000 ? m.content.slice(0, 1000) + '…' : m.content
        return { role: 'tool', tool_call_id: m.tool_call_id, content: brief }
      }
      return m
    })
}

function clear() {
  store.clearChat()
}

module.exports = { runChat, history, clear }
