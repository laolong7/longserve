// ============================================================
// AI 请求代理（OpenAI 兼容格式）
// 主进程发请求规避 CORS；SSE 流逐块转发给渲染层
// 事件约定（channel = `ai:${type}:${eventId}`）：
//   ai:delta:<id}      -> { content?, toolCalls? }  增量片段
//   ai:done:<id}       -> { usage? }
//   ai:error:<id}      -> { message }
// ============================================================

const active = new Map() // eventId -> AbortController

// 规范化 baseUrl：
//   已含 /chat/completions   -> 原样
//   以 /v1 /v2 /v3 /v4 /vN 结尾 -> 拼 /chat/completions
//   其余                     -> 拼 /v1/chat/completions
function buildChatUrl(raw) {
  let b = (raw || '').trim().replace(/\/+$/, '')
  if (!b) throw new Error('请求地址不能为空')
  if (b.endsWith('/chat/completions')) return b
  if (/\/v\d+(beta)?$/.test(b)) return b + '/chat/completions'
  return b + '/v1/chat/completions'
}

function modelsUrl(raw) {
  const b = (raw || '').trim().replace(/\/+$/, '')
  const chat = buildChatUrl(b)
  return chat.replace(/\/chat\/completions$/, '') + '/models'
}

// SSE 流式对话
async function chatStream(opts, emit) {
  const { eventId, provider, body } = opts
  const ac = new AbortController()
  active.set(eventId, ac)

  let url
  try {
    url = buildChatUrl(provider.baseUrl)
  } catch (err) {
    emit('error', { message: err.message })
    active.delete(eventId)
    return
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey || ''}`
      },
      body: JSON.stringify({ model: provider.model, stream: true, ...body }),
      signal: ac.signal
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let msg = `请求失败（HTTP ${res.status}）`
      try {
        const j = JSON.parse(text)
        msg = j.error?.message || j.message || msg
      } catch {
        if (text) msg += '：' + text.slice(0, 300)
      }
      emit('error', { message: msg })
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

// 拉取模型列表（GET /v1/models）
async function listModels(provider) {
  const res = await fetch(modelsUrl(provider.baseUrl), {
    headers: { Authorization: `Bearer ${provider.apiKey || ''}` }
  })
  if (!res.ok) {
    throw new Error(`获取模型列表失败（HTTP ${res.status}）`)
  }
  const j = await res.json()
  const list = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean)
  return list
}

module.exports = { chatStream, abort, listModels }
