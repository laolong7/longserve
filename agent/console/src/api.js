// ============================================================
// 控制台 API 封装：token 管理 + REST + SSE 流式
// token 从扫码链接 ?token= 取得，存 localStorage（绑定一次，之后免输）
// ============================================================

const TOKEN_KEY = 'ls_agent_token'

let token = ''
try { token = localStorage.getItem(TOKEN_KEY) || '' } catch { /* 隐私模式 */ }

export function setToken(t) {
  token = (t || '').trim()
  try { localStorage.setItem(TOKEN_KEY, token) } catch { /* 忽略 */ }
}

export function getToken() { return token }

export function hasToken() { return !!token }

export function forgetToken() {
  token = ''
  try { localStorage.removeItem(TOKEN_KEY) } catch { /* 忽略 */ }
}

async function req(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      ...(opts.headers || {})
    }
  })
  const j = await res.json().catch(() => ({}))
  if (res.status === 401) {
    const err = new Error(j.error || '未绑定或密钥无效')
    err.code = 401
    throw err
  }
  return j
}

export const api = {
  health: () => req('/api/health'),
  bind: () => req('/api/bind', { method: 'POST' }),
  status: () => req('/api/status'),
  history: () => req('/api/chat/history'),
  clearChat: () => req('/api/chat/clear', { method: 'POST' }),
  abort: () => req('/api/chat/abort', { method: 'POST' }),
  pending: () => req('/api/pending'),
  confirm: (id, approve) => req('/api/confirm', { method: 'POST', body: JSON.stringify({ id, approve }) }),
  exec: (command, confirmed) => req('/api/exec', { method: 'POST', body: JSON.stringify({ command, confirmed }) }),
  audit: () => req('/api/audit')
}

// SSE 流式对话。返回 AbortController（停止按钮用）
export function chatStream(text, onEvent) {
  const ctrl = new AbortController()
  fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ text }),
    signal: ctrl.signal
  })
    .then(async (res) => {
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}))
        onEvent({ type: 'error', message: j.error || 'HTTP ' + res.status })
        onEvent({ type: '__end' })
        return
      }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          try { onEvent(JSON.parse(line.slice(5).trim())) } catch { /* 非法行忽略 */ }
        }
      }
      onEvent({ type: '__end' })
    })
    .catch((err) => {
      if (err.name !== 'AbortError') onEvent({ type: 'error', message: '连接中断：' + err.message })
      onEvent({ type: '__end' })
    })
  return ctrl
}
