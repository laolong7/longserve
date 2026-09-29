<template>
  <div class="page">
    <div class="term panel" ref="termEl">
      <div v-if="!lines.length" class="term-empty">手动指令通道 —— 不经 AI 直接执行<br>危险命令会先请求确认</div>
      <div v-for="(l, i) in lines" :key="i" class="line" :class="l.kind">
        <span v-if="l.kind === 'cmd'" class="prompt mono">$ </span><span class="mono">{{ l.text }}</span>
      </div>
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
          v-model="draft"
          class="mono"
          spellcheck="false"
          autocomplete="off"
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
import { ref, nextTick } from 'vue'
import { api } from '../api'

const lines = ref([]) // { kind: 'cmd'|'out'|'err', text }
const draft = ref('')
const running = ref(false)
const confirming = ref(null) // { command, reasons }
const termEl = ref(null)
const localHistory = ref([])
const histIdx = ref(-1)

function pushLine(kind, text) {
  lines.value.push({ kind, text })
  nextTick(() => {
    const el = termEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
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
      if (r.output) for (const l of r.output.split('\n')) pushLine('out', l)
    }
  } catch (err) {
    pushLine('err', err.message)
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
    else if (r.output) for (const l of r.output.split('\n')) pushLine('out', l)
  } catch (err) {
    pushLine('err', err.message)
  }
  running.value = false
}

function historyNav(dir) {
  if (!localHistory.value.length) return
  histIdx.value = Math.min(Math.max(histIdx.value + dir, -1), localHistory.value.length - 1)
  draft.value = histIdx.value < 0 ? '' : localHistory.value[histIdx.value]
}
</script>

<style scoped>
.page { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.term {
  flex: 1; margin: 12px; overflow-y: auto;
  background: var(--bg0);
  padding: 12px;
  font-size: 12px; line-height: 1.7;
}
.term-empty { color: var(--text-faint); text-align: center; padding-top: 60px; line-height: 2; }
.line { white-space: pre-wrap; word-break: break-all; }
.line.cmd .prompt { color: var(--cyan); }
.line.err { color: var(--red); }
.line.out { color: var(--text-dim); }

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
}
.input-wrap:focus-within { border-color: var(--border-strong); }
.dollar { color: var(--cyan); font-size: 13px; }
.input-wrap input { flex: 1; border: none; background: transparent; padding: 10px 0; font-size: 13px; }
.send-btn { width: 38px; height: 38px; padding: 0; border-radius: 50%; font-size: 17px; }
</style>
