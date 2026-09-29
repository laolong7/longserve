<template>
  <div class="page">
    <div class="msgs" ref="msgsEl" @scroll="onScroll">
      <div v-if="!turns.length" class="empty">
        <div class="empty-ico">✦</div>
        <div>向 AI 下达服务器指令</div>
        <div class="empty-sub">例如：「看下磁盘占用」「nginx 挂了帮我排查」「重启 gunicorn」</div>
      </div>

      <template v-for="(t, i) in turns" :key="i">
        <!-- 用户消息 -->
        <div v-if="t.kind === 'user'" class="row user">
          <div class="bubble user-bubble">{{ t.text }}</div>
        </div>

        <!-- AI 消息 -->
        <div v-else class="row ai">
          <!-- 思考块 -->
          <div
            v-if="t.reasoning"
            class="think panel"
            :class="{ open: thinkOpen[i] !== false, busy: t.streaming && !t.text }"
            @click="thinkOpen[i] = thinkOpen[i] === false ? true : false"
          >
            <div class="think-head">
              <template v-if="t.streaming && !t.text">
                <span class="spark">✦</span>
                <span class="think-label">深度思考中</span>
                <span class="dots"><i></i><i></i><i></i></span>
              </template>
              <template v-else>
                <span class="spark done">✦</span>
                <span class="think-label">已深度思考（{{ t.reasoning.length }} 字）</span>
                <span class="fold">{{ thinkOpen[i] !== false ? '▾' : '▸' }}</span>
              </template>
            </div>
            <div class="think-body mono" v-show="thinkOpen[i] !== false">{{ t.reasoning }}<span v-if="t.streaming && !t.text" class="caret"></span></div>
            <div v-if="t.streaming && !t.text" class="think-scan"></div>
          </div>

          <!-- 工具调用卡片 -->
          <div v-for="tc in t.tools" :key="tc.id" class="tool panel" :class="tc.status">
            <div class="tool-head" @click="tc._open = tc._open === true ? false : true">
              <span class="tool-ico">{{ tc.status === 'running' ? '⟳' : tc.status === 'denied' ? '⛔' : tc.status === 'error' ? '⚠' : '▸' }}</span>
              <span class="tool-cmd mono ellipsis">{{ tc.name === 'run_command' ? (parseCmd(tc.args) || tc.name) : tc.name }}</span>
              <span class="tool-state">{{ tc.status === 'running' ? '执行中' : tc.status === 'denied' ? '已拒绝' : tc.status === 'error' ? '出错' : '完成' }}</span>
            </div>
            <div v-if="tc._open && tc.result" class="tool-result mono">{{ tc.result }}</div>
          </div>

          <!-- 正文 -->
          <div v-if="t.text" class="bubble ai-bubble" v-html="renderText(t.text)"></div>
          <div v-if="t.streaming && !t.text && !t.reasoning && !t.tools.length" class="wait">
            <span class="dots dark"><i></i><i></i><i></i></span>
          </div>
          <div v-if="t.error" class="err-line">✕ {{ t.error }}</div>
        </div>
      </template>
    </div>

    <!-- 危险命令确认弹层 -->
    <Teleport to="body">
      <div v-if="confirm" class="mask" @click.self="rejectConfirm">
        <div class="confirm panel">
          <div class="confirm-title">⚠ 危险命令确认</div>
          <div class="confirm-cmd mono">{{ confirm.command }}</div>
          <ul class="confirm-reasons">
            <li v-for="r in confirm.reasons" :key="r">{{ r }}</li>
          </ul>
          <div class="confirm-hint">AI 请求执行以上操作，请确认影响后再放行</div>
          <div class="confirm-btns">
            <button class="danger" @click="rejectConfirm">拒绝</button>
            <button class="primary" @click="approveConfirm">批准执行</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 输入区 -->
    <footer class="input-bar">
      <button class="ghost-btn" title="清空会话" @click="clearChat">⌫</button>
      <textarea
        ref="inputEl"
        v-model="draft"
        rows="1"
        placeholder="输入指令或问题…"
        @keydown.enter.exact.prevent="send"
      ></textarea>
      <button v-if="streaming" class="stop-btn" @click="stop">■ 停止</button>
      <button v-else class="send-btn" :disabled="!draft.trim()" @click="send">↑</button>
    </footer>
  </div>
</template>

<script setup>
import { ref, reactive, nextTick, onMounted, onActivated } from 'vue'
import { api, chatStream } from '../api'

const emit = defineEmits(['pending'])

const turns = reactive([])
const thinkOpen = reactive({})
const draft = ref('')
const streaming = ref(false)
const confirm = ref(null) // { id, command, reasons }
const msgsEl = ref(null)
const inputEl = ref(null)
let ctrl = null
let stickBottom = true

// ---------- 历史恢复 ----------
async function loadHistory() {
  try {
    const r = await api.history()
    if (!r.ok) return
    turns.length = 0
    let curAi = null
    for (const m of r.messages || []) {
      if (m.role === 'user') {
        turns.push({ kind: 'user', text: m.content })
        curAi = null
      } else if (m.role === 'assistant') {
        curAi = { kind: 'ai', reasoning: m.reasoning_content || '', text: m.content || '', tools: [], streaming: false }
        for (const tc of m.tool_calls || []) {
          let args = {}
          try { args = JSON.parse(tc.function.arguments || '{}') } catch { /* 忽略 */ }
          curAi.tools.push({ id: tc.id, name: tc.function.name, args, status: 'done', result: '', _open: false })
        }
        turns.push(curAi)
      } else if (m.role === 'tool' && curAi) {
        const tc = curAi.tools.find((x) => x.id === m.tool_call_id)
        if (tc) {
          tc.result = m.content || ''
          if (tc.result.startsWith('[已拒绝]')) tc.status = 'denied'
          if (tc.result.startsWith('[错误]')) tc.status = 'error'
        }
      }
    }
    scrollBottom(true)
  } catch { /* 首次无历史 */ }
}

// ---------- 发送与流式 ----------
function send() {
  const text = draft.value.trim()
  if (!text || streaming.value) return
  draft.value = ''
  autoGrow()
  turns.push({ kind: 'user', text })
  const live = reactive({ kind: 'ai', reasoning: '', text: '', tools: [], streaming: true, error: '' })
  turns.push(live)
  streaming.value = true
  stickBottom = true
  scrollBottom(true)

  let pendingTool = null
  const onEvent = (evt) => {
    if (evt.type === 'reasoning') {
      live.reasoning += evt.text
    } else if (evt.type === 'delta') {
      live.text += evt.text
    } else if (evt.type === 'tool') {
      pendingTool = { id: evt.id, name: evt.name, args: evt.args || {}, status: 'running', result: '', _open: false }
      live.tools.push(pendingTool)
    } else if (evt.type === 'tool_result') {
      if (pendingTool && pendingTool.id === evt.id) {
        pendingTool.result = evt.brief || ''
        if (pendingTool.result.startsWith('[已拒绝]')) pendingTool.status = 'denied'
        else if (pendingTool.result.startsWith('[错误]')) pendingTool.status = 'error'
        else pendingTool.status = 'done'
      }
    } else if (evt.type === 'confirm') {
      confirm.value = { id: evt.id, command: evt.command, reasons: evt.reasons || [] }
    } else if (evt.type === 'done') {
      live.streaming = false
      streaming.value = false
      confirm.value = null
    } else if (evt.type === 'error') {
      live.streaming = false
      streaming.value = false
      live.error = evt.message
      confirm.value = null
    } else if (evt.type === '__end') {
      live.streaming = false
      streaming.value = false
      emit('pending')
    }
    scrollBottom()
    if (live.text || live.reasoning) scrollBottom()
  }
  ctrl = chatStream(text, onEvent)
}

function stop() {
  if (ctrl) ctrl.abort()
  api.abort().catch(() => {})
  streaming.value = false
}

async function approveConfirm() {
  const c = confirm.value
  confirm.value = null
  if (c) await api.confirm(c.id, true).catch(() => {})
  emit('pending')
}
async function rejectConfirm() {
  const c = confirm.value
  confirm.value = null
  if (c) await api.confirm(c.id, false).catch(() => {})
  emit('pending')
}

async function clearChat() {
  if (streaming.value) return
  if (!window.confirm('清空全部 AI 会话历史？')) return
  try {
    await api.clearChat()
    turns.length = 0
  } catch (err) {
    alert(err.message)
  }
}

// ---------- 展示辅助 ----------
function parseCmd(tcArgs) {
  return tcArgs && tcArgs.command ? '$ ' + tcArgs.command : ''
}

// 轻量渲染：代码块/行内代码等宽高亮，其余转义后按行
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function renderText(raw) {
  const parts = String(raw).split(/```/)
  return parts
    .map((seg, i) => {
      if (i % 2 === 1) {
        const body = seg.replace(/^\w*\n/, '')
        return `<pre class="code">${esc(body)}</pre>`
      }
      return esc(seg)
        .replace(/`([^`]+)`/g, '<code class="inline">$1</code>')
        .replace(/\n/g, '<br>')
    })
    .join('')
}

function onScroll() {
  const el = msgsEl.value
  if (!el) return
  stickBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
}
function scrollBottom(force = false) {
  if (!stickBottom && !force) return
  nextTick(() => {
    const el = msgsEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}
function autoGrow() {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 96) + 'px'
}

onMounted(() => {
  loadHistory()
  // 断线重连后可能有挂起的确认（如 AI 危险命令等待裁决），拉一次
  api.pending().then((r) => {
    if (r.ok && r.pending.length) {
      const p = r.pending[r.pending.length - 1]
      confirm.value = { id: p.id, command: p.command, reasons: p.reasons }
    }
  }).catch(() => {})
})
defineExpose({ focus: () => inputEl.value && inputEl.value.focus() })
</script>

<style scoped>
.page { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.msgs { flex: 1; overflow-y: auto; padding: 14px 12px 8px; }
.empty { text-align: center; padding: 70px 20px 0; color: var(--text-dim); }
.empty-ico { font-size: 34px; color: var(--violet); text-shadow: 0 0 14px var(--violet); margin-bottom: 10px; }
.empty-sub { font-size: 11.5px; color: var(--text-faint); margin-top: 6px; line-height: 1.7; }

.row { margin-bottom: 14px; }
.row.user { display: flex; justify-content: flex-end; }
.bubble { max-width: 84%; padding: 9px 13px; border-radius: 12px; font-size: 14px; line-height: 1.65; word-break: break-word; }
.user-bubble {
  background: linear-gradient(135deg, rgba(92, 207, 230, 0.2), rgba(92, 207, 230, 0.08));
  border: 1px solid var(--border-strong);
  border-bottom-right-radius: 3px;
}
.ai-bubble {
  background: var(--bg1);
  border: 1px solid var(--border);
  border-top-left-radius: 3px;
}
.bubble :deep(.code) {
  display: block; overflow-x: auto;
  background: var(--bg0); border: 1px solid var(--border);
  border-radius: 8px; padding: 9px 11px;
  font-family: var(--font-mono); font-size: 12px; margin: 7px 0;
  color: #9fe8f5;
}
.bubble :deep(.inline) {
  font-family: var(--font-mono); font-size: 12px;
  background: var(--bg3); border-radius: 4px; padding: 1px 5px;
}

/* ---------- 思考块 ---------- */
.think { margin-bottom: 8px; overflow: hidden; cursor: pointer; position: relative; }
.think.busy { border-color: rgba(167, 139, 250, 0.4); }
.think-head { display: flex; align-items: center; gap: 7px; padding: 8px 12px; }
.spark { color: var(--violet); font-size: 13px; text-shadow: 0 0 8px var(--violet); animation: breathe 1.6s ease-in-out infinite; }
.spark.done { animation: none; }
.think-label { font-size: 11.5px; color: var(--violet); }
.fold { margin-left: auto; color: var(--text-faint); font-size: 11px; }
.think-body {
  padding: 0 12px 10px;
  font-size: 11.5px; line-height: 1.7; color: var(--text-dim);
  white-space: pre-wrap; word-break: break-word;
  max-height: 180px; overflow-y: auto;
}
.think:not(.busy) .think-body { color: var(--text-faint); }
.caret { display: inline-block; width: 7px; height: 13px; background: var(--violet); vertical-align: -2px; margin-left: 2px; animation: breathe 1s steps(2) infinite; }
.think-scan {
  position: absolute; bottom: 0; left: 0; right: 0; height: 2px;
  background: linear-gradient(90deg, transparent, var(--violet), transparent);
  background-size: 40% 100%;
  animation: scan 1.4s linear infinite;
}
@keyframes scan {
  from { background-position: -40% 0; }
  to { background-position: 140% 0; }
}

/* ---------- 工具卡片 ---------- */
.tool { margin-bottom: 8px; overflow: hidden; }
.tool-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; }
.tool-ico { font-size: 12px; color: var(--cyan); width: 14px; }
.tool.running .tool-ico { display: inline-block; animation: spin 1s linear infinite; }
.tool.denied .tool-ico { color: var(--red); }
.tool.error .tool-ico { color: var(--amber); }
.tool-cmd { flex: 1; font-size: 12px; color: var(--text); }
.tool-state { font-size: 10px; color: var(--text-faint); flex-shrink: 0; }
.tool.running .tool-state { color: var(--cyan); }
.tool.denied .tool-state { color: var(--red); }
.tool-result {
  padding: 8px 12px 10px;
  border-top: 1px solid var(--border);
  font-size: 11px; line-height: 1.6; color: var(--text-dim);
  white-space: pre-wrap; word-break: break-word;
  max-height: 220px; overflow-y: auto;
}
@keyframes spin { to { transform: rotate(360deg); } }

.err-line { color: var(--red); font-size: 12px; padding: 4px 2px; }
.wait { padding: 6px 2px; }

/* 三点跳动 */
.dots { display: inline-flex; gap: 4px; }
.dots i {
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--violet);
  animation: hop 1.2s ease-in-out infinite;
}
.dots i:nth-child(2) { animation-delay: 0.15s; }
.dots i:nth-child(3) { animation-delay: 0.3s; }
.dots.dark i { background: var(--text-dim); }
@keyframes hop {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-4px); opacity: 1; }
}

/* ---------- 确认弹层 ---------- */
.mask {
  position: fixed; inset: 0; z-index: 50;
  background: rgba(6, 8, 11, 0.72);
  display: flex; align-items: flex-end;
  animation: fadeIn 0.15s ease;
}
@keyframes fadeIn { from { opacity: 0; } }
.confirm {
  width: 100%;
  border-radius: 16px 16px 0 0;
  border-bottom: none;
  padding: 20px 18px calc(env(safe-area-inset-bottom, 0px) + 18px);
  animation: slideUp 0.22s ease;
}
.confirm-title { font-size: 15px; font-weight: 700; color: var(--amber); margin-bottom: 12px; }
.confirm-cmd {
  background: var(--bg0); border: 1px solid rgba(242, 85, 90, 0.35);
  border-radius: 8px; padding: 10px 12px;
  font-size: 12.5px; color: #ffb3b5;
  white-space: pre-wrap; word-break: break-all;
}
.confirm-reasons { margin: 10px 0 4px; padding-left: 20px; color: var(--amber); font-size: 12px; line-height: 1.8; }
.confirm-hint { color: var(--text-dim); font-size: 11.5px; margin-bottom: 14px; }
.confirm-btns { display: flex; gap: 10px; }
.confirm-btns button { flex: 1; padding: 12px; }

/* ---------- 输入区 ---------- */
.input-bar {
  display: flex; align-items: flex-end; gap: 8px;
  padding: 9px 10px calc(env(safe-area-inset-bottom, 0px) + 9px);
  border-top: 1px solid var(--border);
  background: rgba(14, 17, 22, 0.9);
  backdrop-filter: blur(8px);
  flex-shrink: 0;
}
.ghost-btn {
  background: transparent; border-color: transparent;
  color: var(--text-faint); font-size: 15px; padding: 8px 6px;
}
textarea { flex: 1; resize: none; line-height: 1.5; max-height: 96px; padding: 9px 12px; }
.send-btn, .stop-btn {
  width: 40px; height: 40px; padding: 0;
  border-radius: 50%; font-size: 17px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
}
.send-btn { font-size: 19px; }
.stop-btn { width: auto; border-radius: 20px; font-size: 12.5px; padding: 0 14px; color: var(--red); background: var(--red-dim); border-color: rgba(242, 85, 90, 0.4); }
.ellipsistext { overflow: hidden; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
