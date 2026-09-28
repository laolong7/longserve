// ============================================================
// AI 请求代理：双协议（OpenAI 兼容 / Anthropic 原生 Messages）
// 主进程发请求规避 CORS；SSE 流逐块转发给渲染层
// 渲染层接口保持统一（delta/done/error 事件，OpenAI 风格增量），
// 协议差异在本文件内完成转换
// 超时看门狗：首响应/流空闲/总时长三重保险，杜绝"一直加载"
// ============================================================

const active = new Map() // eventId -> AbortController

// 超时默认值（毫秒）；chatStream 的 opts.timeouts 可覆盖（测试用）
const DEFAULT_TIMEOUTS = {
  first: 30000, // 首响应：连接网关到收到第一个数据块
  idle: 60000, // 流空闲：相邻数据块之间
  total: 300000 // 总时长上限
}

// store.js 解密失败哨兵（避免把废密文当 key 发出去）
function assertUsableKey(provider) {
  const k = provider.apiKey || ''
  if (k.includes('DECRYPT_FAILED')) {
    throw new Error('API Key 解密失败（原密文已失效），请到 AI 设置重新填写 API Key')
  }
  if (!k.trim()) {
    throw new Error('API Key 为空，请到 AI 设置填写 API Key')
  }
}

// ---------- 候选地址 ----------
// OpenAI 兼容：中转站路径变体多，404/405 时自动尝试下一个候选
function chatUrlCandidatesOpenAI(raw) {
  const b = (raw || '').trim().replace(/\/+$/, '')
  if (!b) throw new Error('请求地址不能为空')
  if (b.endsWith('/chat/completions')) return [b]
  if (/\/v\d+(beta)?$/.test(b)) {
    return [b + '/chat/completions', b.replace(/\/(v\d+(beta)?)$/, '/api/$1') + '/chat/completions']
  }
  return [
    b + '/v1/chat/completions',
    b + '/chat/completions',
    b + '/api/v1/chat/completions'
  ]
}

// Anthropic 原生：{base}/v1/messages
function chatUrlCandidatesAnthropic(raw) {
  const b = (raw || '').trim().replace(/\/+$/, '')
  if (!b) throw new Error('请求地址不能为空')
  if (b.endsWith('/messages')) return [b]
  return [b + '/v1/messages', b + '/messages', b + '/api/v1/messages']
}

// 带候选重试的请求：404/405 换下一个地址，其他错误直接抛
async function fetchWithFallback(urls, init, ctxLabel) {
  let lastErr = null
  const tried = []
  for (const url of urls) {
    let res
    try {
      res = await fetch(url, init)
    } catch (err) {
      if (err.name === 'AbortError') throw err
      if (err.name === 'TimeoutError') throw new Error(`请求超时：服务器 20 秒内未响应（${ctxLabel}）`)
      throw new Error('网络错误：' + err.message)
    }
    if (res.ok) return res
    const text = await res.text().catch(() => '')
    lastErr = { status: res.status, text: text.slice(0, 400), url }
    tried.push(url)
    if (res.status === 404 || res.status === 405) continue
    let msg = `请求失败（HTTP ${res.status}）`
    try {
      const j = JSON.parse(text)
      msg = j.error?.message || j.message || msg
    } catch {
      if (text) msg += '：' + text.slice(0, 300)
    }
    throw new Error(msg)
  }
  throw new Error(
    `请求失败：已尝试 ${tried.length} 个地址均返回 ${lastErr.status}（${ctxLabel}）。\n` +
    `最后请求：${lastErr.url}\n` +
    `服务器返回：${lastErr.text || '（空）'}\n` +
    `请检查「接口协议」选择与请求地址是否匹配（OpenAI 兼容填域名即可；Anthropic 原生填到 /anthropic 这类端点）。`
  )
}

// 中转站可能忽略 stream 参数、或用 200 + JSON 返回错误：
// 按 OpenAI / Anthropic 两种形态归一化成 delta/done，不让请求卡死或空回
function emitJsonOnce(j, emit) {
  if (j && j.error) {
    throw new Error((j.error.message || j.error.type || j.error) + '')
  }
  // Anthropic 形态：{ content: [{type:'text'|'tool_use',...}], usage }
  if (j && Array.isArray(j.content)) {
    let idx = 0
    for (const block of j.content) {
      if (block.type === 'text' && block.text) emit('delta', { content: block.text })
      else if (block.type === 'tool_use') {
        emit('delta', {
          toolCalls: [{ index: idx++, id: block.id, name: block.name, argsFragment: JSON.stringify(block.input || {}) }]
        })
      }
    }
    emit('done', { usage: j.usage || null })
    return
  }
  // OpenAI 形态：{ choices: [{ message: { content, tool_calls } }] }
  const msg = j && j.choices && j.choices[0] && j.choices[0].message
  if (msg) {
    if (msg.content) emit('delta', { content: msg.content })
    if (msg.tool_calls && msg.tool_calls.length) {
      emit('delta', {
        toolCalls: msg.tool_calls.map((tc, i) => ({
          index: tc.index != null ? tc.index : i,
          id: tc.id,
          name: tc.function && tc.function.name,
          argsFragment: (tc.function && tc.function.arguments) || ''
        }))
      })
    }
    emit('done', { usage: j.usage || null })
    return
  }
  emit('done', { usage: (j && j.usage) || null })
}

// ============================================================
// OpenAI 兼容协议
// ============================================================
async function chatOpenAI(provider, body, emit, ac, ctx) {
  const urls = chatUrlCandidatesOpenAI(provider.baseUrl)
  const res = await fetchWithFallback(urls, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey || ''}`
    },
    body: JSON.stringify({ model: provider.model, stream: true, ...body }),
    signal: ac.signal
  }, '对话接口')

  ctx.setStage('接收回复')
  // 非流式 JSON 兜底（中转站忽略 stream 参数的情况）
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    emitJsonOnce(await res.json(), emit)
    return
  }

  // 解析 SSE：按行拆 data: 前缀
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let usage = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    ctx.touch() // 每收到一个数据块喂一次看门狗
    buf += decoder.decode(value, { stream: true })

    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') {
        emit('done', { usage })
        return
      }
      try {
        const chunk = JSON.parse(payload)
        if (chunk.usage) usage = chunk.usage
        const choice = chunk.choices && chunk.choices[0]
        if (!choice) continue
        const delta = choice.delta || {}
        const piece = {}
        if (delta.content) piece.content = delta.content
        if (delta.tool_calls && delta.tool_calls.length) {
          piece.toolCalls = delta.tool_calls.map((tc) => ({
            index: tc.index,
            id: tc.id,
            name: tc.function && tc.function.name,
            argsFragment: tc.function && tc.function.arguments
          }))
        }
        if (piece.content || piece.toolCalls) emit('delta', piece)
      } catch { /* 非 JSON 行（如注释心跳），忽略 */ }
    }
  }
  // 流结束但没有 [DONE]（部分兼容端点如此）
  emit('done', { usage })
}

// ============================================================
// Anthropic 原生 Messages 协议
// 外部接口与 OpenAI 分支完全一致：emit 统一的 delta/done/error
// ============================================================

// OpenAI 风格 messages -> Anthropic 风格（system 提顶层、tool 调用/结果转块、连续 user 合并）
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
        last.content += '\n\n' + m.content // Anthropic 要求交替，连续 user 合并
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
        last.content.push(block) // 多个工具结果合并进同一条 user 消息
      } else {
        out.push({ role: 'user', content: [block] })
      }
    }
  }
  return { system, messages: out }
}

// OpenAI tools -> Anthropic tools
function toAnthropicTools(openAiTools) {
  if (!openAiTools || !openAiTools.length) return undefined
  return openAiTools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters
  }))
}

async function chatAnthropic(provider, body, emit, ac, ctx) {
  const urls = chatUrlCandidatesAnthropic(provider.baseUrl)
  const { system, messages } = toAnthropicMessages(body.messages || [])
  const payload = {
    model: provider.model,
    max_tokens: Number(provider.maxTokens) || 8192,
    stream: true,
    messages
  }
  if (system) payload.system = system
  const tools = toAnthropicTools(body.tools)
  if (tools) payload.tools = tools
  if (body.temperature != null) payload.temperature = body.temperature

  const res = await fetchWithFallback(urls, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // ANTHROPIC_AUTH_TOKEN 走 Bearer，官方走 x-api-key：两个都发，最大化网关兼容
      Authorization: `Bearer ${provider.apiKey || ''}`,
      'x-api-key': provider.apiKey || '',
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(payload),
    signal: ac.signal
  }, '对话接口（Anthropic）')

  ctx.setStage('接收回复')
  // 非流式 JSON 兜底（中转站忽略 stream 参数的情况）
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    emitJsonOnce(await res.json(), emit)
    return
  }

  // 解析 Anthropic SSE 事件流，转成渲染层的统一增量格式
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let usage = null
  const toolBlocks = new Map() // content 索引 -> { id, name }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    ctx.touch() // 每收到一个数据块喂一次看门狗
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

      if (ev.type === 'content_block_start' && ev.content_block) {
        if (ev.content_block.type === 'tool_use') {
          toolBlocks.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name })
          emit('delta', {
            toolCalls: [{ index: ev.index, id: ev.content_block.id, name: ev.content_block.name, argsFragment: '' }]
          })
        }
      } else if (ev.type === 'content_block_delta' && ev.delta) {
        if (ev.delta.type === 'text_delta' && ev.delta.text) {
          emit('delta', { content: ev.delta.text })
        } else if (ev.delta.type === 'input_json_delta' && ev.delta.partial_json) {
          emit('delta', { toolCalls: [{ index: ev.index, argsFragment: ev.delta.partial_json }] })
        }
      } else if (ev.type === 'message_delta') {
        if (ev.usage) usage = { ...usage, ...ev.usage }
      } else if (ev.type === 'message_start' && ev.message && ev.message.usage) {
        usage = { ...usage, ...ev.message.usage }
      } else if (ev.type === 'message_stop') {
        emit('done', { usage })
        return
      } else if (ev.type === 'error') {
        emit('error', { message: (ev.error && ev.error.message) || 'Anthropic 流错误' })
        return
      }
    }
  }
  emit('done', { usage })
}

// ---------- 统一分发入口 ----------
async function chatStream(opts, emit) {
  const { eventId, provider } = opts
  const ac = new AbortController()
  active.set(eventId, ac)

  // 超时看门狗：首响应/流空闲/总时长任一命中即中断请求，
  // 把"永远转圈"变成一条明确的超时错误
  const limits = { ...DEFAULT_TIMEOUTS, ...(opts.timeouts || {}) }
  const startedAt = Date.now()
  let lastActivity = startedAt
  let gotFirstData = false // 收到首块后才计空闲超时（首块前计 first 超时）
  let timedOut = false
  let stage = '连接网关'
  const ctx = {
    setStage(s) { stage = s; lastActivity = Date.now() },
    touch() { gotFirstData = true; lastActivity = Date.now() }
  }
  const watchdog = setInterval(() => {
    const now = Date.now()
    const idleLimit = gotFirstData ? limits.idle : limits.first
    if (now - lastActivity > idleLimit || now - startedAt > limits.total) {
      timedOut = true
      ac.abort()
    }
  }, 1000)

  try {
    assertUsableKey(provider)
    if (provider.protocol === 'anthropic') {
      await chatAnthropic(provider, opts.body, emit, ac, ctx)
    } else {
      await chatOpenAI(provider, opts.body, emit, ac, ctx)
    }
  } catch (err) {
    if (timedOut) {
      const waited = Math.round((Date.now() - startedAt) / 1000)
      emit('error', {
        message:
          `AI 响应超时：${stage}阶段 ${waited} 秒未收到有效响应，已自动中断。\n` +
          '请稍后重试；若持续超时，请到 AI 设置点「测试连接」检查地址与密钥。'
      })
    } else if (err.name === 'AbortError') {
      emit('done', { aborted: true })
    } else {
      emit('error', { message: err.message })
    }
  } finally {
    clearInterval(watchdog)
    active.delete(eventId)
  }
}

function abort(eventId) {
  const ac = active.get(eventId)
  if (ac) ac.abort()
  active.delete(eventId)
}

// ---------- 模型列表 ----------
async function listModels(provider) {
  assertUsableKey(provider)
  const b = (provider.baseUrl || '').trim().replace(/\/+$/, '')
  if (!b) throw new Error('请求地址不能为空')
  const isAnthropic = provider.protocol === 'anthropic'
  // 模型列表路径各家网关不统一：有的挂在对话同级（/anthropic/v1/models），
  // 有的挂在域名根（https://host/v1/models，如 mimo 中转）——逐个候选都试
  let origin = ''
  try { origin = new URL(b).origin } catch { /* 相对地址不追加根候选 */ }
  const rootCandidates = origin ? [origin + '/v1/models', origin + '/models'] : []
  const raw = b.endsWith('/models')
    ? [b]
    : isAnthropic
      ? [b + '/v1/models', b + '/models', ...rootCandidates]
      : [b.replace(/\/chat\/completions$/, '') + '/models', b + '/v1/models', b + '/models', ...rootCandidates]
  const candidates = [...new Set(raw)]

  const headers = isAnthropic
    ? {
        Authorization: `Bearer ${provider.apiKey || ''}`,
        'x-api-key': provider.apiKey || '',
        'anthropic-version': '2023-06-01'
      }
    : { Authorization: `Bearer ${provider.apiKey || ''}` }

  // 单独给模型列表一个 20 秒硬超时，测试连接按钮不会永远转圈
  const res = await fetchWithFallback(candidates, { headers, signal: AbortSignal.timeout(20000) }, '模型列表接口')
  const j = await res.json()
  const list = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean)
  return list
}

module.exports = { chatStream, abort, listModels }
