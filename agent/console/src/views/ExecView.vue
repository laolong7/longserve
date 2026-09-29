<template>
  <div class="page">
    <!-- 终端头：与连接终端同观感的提示符 -->
    <div class="term-head mono">
      <span class="th-dot"></span>
      <span class="th-title">{{ hostname }}:~$</span>
      <div class="grow"></div>
      <button class="mini-btn" @click="pasteClip">粘贴</button>
      <button class="mini-btn" @click="reloadHistory" :disabled="loadingHist">{{ loadingHist ? '…' : '↻' }}</button>
      <button class="mini-btn" @click="clearScreen">清屏</button>
    </div>

    <div class="term panel" ref="termEl">
      <div v-if="!lines.length" class="term-empty">
        <div class="te-ico">❯</div>
        <div>手动指令通道 —— 不经 AI 直接执行</div>
        <div class="te-sub">输入命令回车执行，危险命令会先请求确认</div>
      </div>
      <template v-for="(l, i) in lines" :key="i">
        <div v-if="l.kind === 'cmd'" class="line cmd">
          <span class="prompt mono">{{ hostname }}:~$ </span><span class="mono">{{ l.text }}</span>
        </div>
        <div v-else class="line mono" :class="l.kind">{{ l.text }}</div>
      </template>
      <div v-if="running" class="line out mono blink">▚ 执行中…</div>
    </div>

    <!-- 危险确认条 -->
    <div v-if="confirming" class="confirm-strip">
      <div class="cs-title">⚠ 此命令存在风险，确认执行？</div>
      <ul><li v-for="r in confirming.reasons" :key="r">{{ r }}</li></ul>
      <div class="cs-btns">
        <button @click="confirming = null">取消</button>
        <button class="danger" @click="doSend(true)">仍要执行</button>
      </div>
    </div>

    <footer class="input-bar">
      <div class="input-wrap">
        <span class="dollar mono">$</span>
        <input
          ref="inputEl"
          v-model="draft"
          class="mono"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          placeholder="输入命令，回车执行"
          @keydown.enter="send"
          @keydown.up="historyNav(-1)"
          @keydown.down="historyNav(1)"
        />
      </div>
      <button class="send-btn" :disabled="running || !draft.trim()" @click="send">{{ running ? '…' : '↑' }}</button>
    </footer>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted, onUnmounted } from 'vue'
import { api } from '../api'

const props = defineProps({
  hostname: { type: String, default: 'server' }
})

const lines = ref([]) // { kind: 'cmd'|'out'|'err', text }
const draft = ref('')
const running = ref(false)
const confirming = ref(null) // { command, reasons }
const termEl = ref(null)
const inputEl = ref(null)
const localHistory = ref([])
const histIdx = ref(-1)
const loadingHist = ref(false)

function pushLine(kind, text) {
  lines.value.push({ kind, text })
  nextTick(() => {
    const el = termEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

// 磁盘历史重建：audit.jsonl → 终端转写（完成记录 + 拒绝记录）
async function reloadHistory() {
  loadingHist.value = true
  try {
    const r = await api.execHistory()
    if (r.ok) {
      const out = []
      for (const rec of r.records || []) {
        if (rec.command) out.push({ kind: 'cmd', text: rec.command })
        if (rec.approved === false && !rec.output) {
          out.push({ kind: 'err', text: '[已拒绝] ' + (rec.note || '命令未执行') })
        } else if (rec.output) {
          const kind = rec.code && rec.code !== 0 ? 'err' : 'out'
          for (const l of String(rec.output).split('\n')) out.push({ kind, text: l })
        }
      }
      lines.value = out
      nextTick(() => {
        const el = termEl.value
        if (el) el.scrollTop = el.scrollHeight
      })
    }
  } catch { /* 断线静默，顶栏已反映 */ }
  finally { loadingHist.value = false }
}

async function send() {
  if (confirming.value) return // 有待确认命令时先处理
  const command = draft.value.trim()
  if (!command || running.value) return
  draft.value = ''
  running.value = true
  pushLine('cmd', command)
  localHistory.value.unshift(command)
  histIdx.value = -1
  try {
    const r = await api.exec(command, false)
    if (r.needConfirm) {
      confirming.value = { command, reasons: r.reasons || [] }
    } else if (r.error) {
      pushLine('err', r.error)
    } else {
      if (r.output) for (const l of r.output.split('\n')) pushLine(r.code ? 'err' : 'out', l)
    }
  } catch (err) {
    pushLine('err', err.message || String(err))
  }
  running.value = false
}

async function doSend() {
  const command = confirming.value.command
  confirming.value = null
  running.value = true
  try {
    const r = await api.exec(command, true)
    if (r.error) pushLine('err', r.error)
    else if (r.output) for (const l of r.output.split('\n')) pushLine(r.code ? 'err' : 'out', l)
  } catch (err) {
    pushLine('err', err.message || String(err))
  }
  running.value = false
}

function historyNav(dir) {
  if (!localHistory.value.length) return
  histIdx.value = Math.min(Math.max(histIdx.value + dir, -1), localHistory.value.length - 1)
  draft.value = histIdx.value < 0 ? '' : localHistory.value[histIdx.value]
}

// 粘贴：读剪贴板进输入框（多行合并为空格分隔的单条命令）
async function pasteClip() {
  try {
    if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error('clipboard 不可用')
    const text = await navigator.clipboard.readText()
    if (!text) return
    const oneLine = text.replace(/\r?\n/g, ' ').trim()
    draft.value = draft.value ? draft.value + ' ' + oneLine : oneLine
    inputEl.value && inputEl.value.focus()
  } catch {
    // 非安全上下文（http 非 localhost）拿不到剪贴板 → 退回手动粘贴提示
    window.alert('浏览器禁止读取剪贴板，请长按输入框手动粘贴')
    inputEl.value && inputEl.value.focus()
  }
}

function clearScreen() {
  lines.value = []
}

onMounted(reloadHistory)
onUnmounted(() => {})
</script>

<style scoped>
.page { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.grow { flex: 1; }

/* ---------- 终端头（连接终端观感） ---------- */
.term-head {
  display: flex; align-items: center; gap: 7px;
  padding: 8px 12px;
  background: rgba(14, 17, 22, 0.9);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.th-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--green); box-shadow: 0 0 6px var(--green);
}
.th-title { font-size: 11.5px; color: var(--green); }
.mini-btn {
  font-size: 11px; padding: 3px 10px; border-radius: 6px;
  background: var(--bg2); border: 1px solid var(--border); color: var(--text-dim);
}
.mini-btn:disabled { opacity: 0.5; }

/* ---------- 终端主体 ---------- */
.term {
  flex: 1; margin: 12px; overflow-y: auto;
  background: var(--bg0);
  padding: 12px;
  font-size: 12px; line-height: 1.7;
}
.term-empty { color: var(--text-faint); text-align: center; padding-top: 52px; line-height: 2; }
.te-ico { font-size: 28px; color: var(--cyan); opacity: 0.55; margin-bottom: 6px; }
.te-sub { font-size: 11px; margin-top: 4px; }
.line { white-space: pre-wrap; word-break: break-all; }
.line.cmd { color: var(--text); margin-top: 6px; }
.line.cmd .prompt { color: var(--green); }
.line.err { color: var(--red); }
.line.out { color: var(--text-dim); }
.blink { animation: blink 1s step-start infinite; }
@keyframes blink { 50% { opacity: 0.3; } }

/* ---------- 危险确认条 ---------- */
.confirm-strip {
  margin: 0 12px 8px;
  border: 1px solid rgba(242, 177, 85, 0.4);
  background: var(--amber-dim);
  border-radius: 10px;
  padding: 12px 14px;
  animation: slideUp 0.2s ease;
}
.cs-title { color: var(--amber); font-size: 13px; font-weight: 600; }
.confirm-strip ul { margin: 6px 0 10px; padding-left: 20px; font-size: 11.5px; color: var(--amber); line-height: 1.7; }
.cs-btns { display: flex; gap: 8px; }
.cs-btns button { padding: 8px 14px; font-size: 12.5px; }

/* ---------- 输入栏 ---------- */
.input-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 12px calc(env(safe-area-inset-bottom, 0px) + 9px);
  border-top: 1px solid var(--border);
  background: rgba(14, 17, 22, 0.9);
  backdrop-filter: blur(8px);
  flex-shrink: 0;
}
.input-wrap {
  flex: 1; display: flex; align-items: center; gap: 6px;
  background: var(--bg1); border: 1px solid var(--border);
  border-radius: 8px; padding: 0 10px;
  min-width: 0;
}
.input-wrap:focus-within { border-color: var(--border-strong); }
.dollar { color: var(--green); font-size: 13px; }
.input-wrap input { flex: 1; border: none; background: transparent; padding: 10px 0; font-size: 13px; min-width: 0; }
.send-btn { width: 38px; height: 38px; padding: 0; border-radius: 50%; font-size: 17px; flex-shrink: 0; }
</style>
