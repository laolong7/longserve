// ============================================================
// AI 请求代理（OpenAI 兼容格式）
// 主进程发请求规避 CORS；SSE 流逐块转发给渲染层
// 事件约定（channel = `ai:${type}:${eventId}`）：
//   ai:delta:<id}      -> { content?, toolCalls? }  增量片段
//   ai:done:<id}       -> { usage? }
//   ai:error:<id}      -> { message }
// ============================================================

const active = new Map() // eventId -> AbortController

// 规范化 baseUrl：生成候选地址列表（按优先级）。
// 中转站路径变体多，404/405 时自动尝试下一个候选。
function chatUrlCandidates(raw) {
  const b = (raw || '').trim().replace(/\/+$/, '')
  if (!b) throw new Error('请求地址不能为空')
  if (b.endsWith('/chat/completions')) return [b]
  if (/\/v\d+(beta)?$/.test(b)) {
    // 已带版本号：主候选直接拼，兜底加 /api 前缀
    return [b + '/chat/completions', b.replace(/\/(v\d+(beta)?)$/, '/api/$1') + '/chat/completions']
  }
  return [
    b + '/v1/chat/completions',
    b + '/chat/completions',
    b + '/api/v1/chat/completions'
  ]
}

function modelsUrlCandidates(raw) {
  return chatUrlCandidates(raw).map((u) => u.replace(/\/chat\/completions$/, '/models'))
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
      // 网络层错误不重试（地址换了也没用），直接抛
      throw new Error('网络错误：' + err.message)
    }
    if (res.ok) return res
    const text = await res.text().catch(() => '')
    lastErr = { status: res.status, text: text.slice(0, 400), url }
    tried.push(url)
    // 404/405 说明路径不对，尝试下一个候选
    if (res.status === 404 || res.status === 405) continue
    // 其他状态码是鉴权/参数等问题，地址本身没错，直接报
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
    `请检查请求地址是否为 OpenAI 兼容接口的正确域名。`
  )
}

// SSE 流式对话
async function chatStream(opts, emit) {
  const { eventId, provider, body } = opts
  const ac = new AbortController()
  active.set(eventId, ac)

  let urls
  try {
    urls = chatUrlCandidates(provider.baseUrl)
  } catch (err) {
    emit('error', { message: err.message })
    active.delete(eventId)
    return
  }

  try {
    const res = await fetchWithFallback(urls, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey || ''}`
      },
      body: JSON.stringify({ model: provider.model, stream: true, ...body }),
      signal: ac.signal
    }, '对话接口')

    // 解析 SSE：按行拆 data: 前缀
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let usage = null

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
          if (choice.finish_reason) pieceFinish(choice.finish_reason)
        } catch { /* 非 JSON 行（如注释心跳），忽略 */ }
      }
    }
    // 流结束但没有 [DONE]（部分兼容端点如此）
    emit('done', { usage })
  } catch (err) {
    if (err.name === 'AbortError') {
      emit('done', { aborted: true })
    } else {
      emit('error', { message: '网络错误：' + err.message })
    }
  } finally {
    active.delete(eventId)
  }
}

function pieceFinish(_reason) { /* 保留扩展点：finish_reason 处理 */ }

function abort(eventId) {
  const ac = active.get(eventId)
  if (ac) ac.abort()
  active.delete(eventId)
}

// 拉取模型列表（GET /models，同样支持候选地址重试）
async function listModels(provider) {
  const urls = modelsUrlCandidates(provider.baseUrl)
  const res = await fetchWithFallback(urls, {
    headers: { Authorization: `Bearer ${provider.apiKey || ''}` }
  }, '模型列表接口')
  const j = await res.json()
  const list = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean)
  return list
}

module.exports = { chatStream, abort, listModels }
