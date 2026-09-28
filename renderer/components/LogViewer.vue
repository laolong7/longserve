<template>
  <Teleport to="body">
    <!-- 浮窗本体：Teleport 到 body 但用 fixed 定位，坐标换算成视口坐标 -->
    <div
      v-if="visible"
      class="log-win"
      :style="{ left: pos.x + 'px', top: pos.y + 'px', width: pos.w + 'px', height: pos.h + 'px' }"
    >
      <div class="log-head" @mousedown.prevent="startDrag">
        <span class="log-title ellipsis" :title="`${srvName} · ${file}`">{{ srvName }} 日志</span>
        <span class="mono faint log-file ellipsis">{{ file }}</span>
        <span class="grow"></span>
        <input v-model="kw" class="log-kw mono" placeholder="关键字过滤/高亮…" @mousedown.stop />
        <button class="ghost icon-xs" title="清空显示" @click="lines = []">⌫</button>
        <button class="ghost icon-xs" title="关闭日志窗口" @click="close">✕</button>
      </div>
      <div class="log-body" ref="bodyEl">
        <div v-if="truncated" class="log-trunc">（显示区已达上限，仅展示最近 {{ MAX_LINES }} 行，输入关键字过滤）</div>
        <div v-for="(l, i) in shown" :key="i" class="log-line mono" v-html="hl(l)"></div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
// 数据源：目标服务器的 SSH 连接跑 tail -n 200 -F <file>，
// 数据经 log:data:{streamId} 事件流回，行缓冲上限 5000。
// 未连接的服务器会自动建立一条专用日志连接，关窗时一并断开。
import { ref, reactive, computed, nextTick } from 'vue'
import { useConfigStore } from '../stores/config'
import { useTerminalStore } from '../stores/terminals'
import { useDialogStore } from '../stores/dialog'

const config = useConfigStore()
const store = useTerminalStore()
const dialog = useDialogStore()

const visible = ref(false)
const srvName = ref('')
const file = ref('')
const kw = ref('')
const lines = ref([])
const bodyEl = ref(null)
const MAX_LINES = 5000
let streamId = null
let unsub = null
let ownConnId = null // 专用日志连接（关闭时断开）
let halfLine = ''
let anchor = null // 拖动锚点

const pos = reactive({ x: 0, y: 0, w: 720, h: 260 })

const shown = computed(() => {
  const k = kw.value.trim()
  let arr = k ? lines.value.filter((l) => l.includes(k)) : lines.value
  if (arr.length > 1000) arr = arr.slice(-1000)
  return arr
})
const truncated = computed(() => (kw.value.trim() ? false : lines.value.length >= MAX_LINES))

// 关键字高亮（先转义再包 mark，防注入）
function hl(line) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const k = kw.value.trim()
  const safe = esc(line)
  if (!k) return safe
  try {
    return safe.replace(new RegExp(esc(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`)
  } catch {
    return safe
  }
}

async function open() {
  if (!config.instances.length) {
    dialog.showToast('还没有添加服务器，先到左下角设置里添加')
    return
  }
  const choice = await dialog.askChoice({
    title: '查看哪台服务器的日志？',
    message: '未连接的服务器会自动建立一条专用日志连接。',
    options: config.instances.map((i) => ({ value: i.id, label: `${i.name}（${i.host}:${i.port}）` }))
  })
  if (!choice) return
  const inst = config.instances.find((i) => i.id === choice)
  if (!inst) return
  const file2 = await dialog.askInput({ title: '日志文件路径', value: '/var/log/syslog' })
  if (!file2 || !file2.trim()) return

  // 复用已连接的 tab；否则建专用连接
  const tab = store.tabs.find((t) => t.instanceId === inst.id && t.status === 'connected')
  let connId
  if (tab) {
    connId = tab.id
  } else {
    dialog.showToast('正在建立日志连接…')
    const r = await window.api.sshConnect(JSON.parse(JSON.stringify(inst)))
    if (!r.ok) {
      dialog.showToast('日志连接失败：' + r.error)
      return
    }
    connId = r.connId
    ownConnId = connId
  }

  const res = await window.api.logStart(connId, file2.trim())
  if (!res.ok) {
    dialog.showToast('打开日志失败：' + res.error)
    if (ownConnId) { window.api.sshClose(ownConnId); ownConnId = null }
    return
  }
  streamId = res.streamId
  file.value = file2.trim()
  srvName.value = inst.name
  lines.value = []
  halfLine = ''
  kw.value = ''
  visible.value = true
  // 初始位置：视口右下，宽 min(720, 视口-左侧栏)
  pos.w = Math.min(720, window.innerWidth - 280)
  pos.h = Math.min(280, Math.round(window.innerHeight / 3))
  pos.x = window.innerWidth - pos.w - 12
  pos.y = window.innerHeight - pos.h - 12

  unsub = window.api.on(`log:data:${streamId}`, (text) => {
    halfLine += text
    const parts = halfLine.split('\n')
    halfLine = parts.pop() || ''
    if (parts.length) {
      lines.value.push(...parts)
      if (lines.value.length > MAX_LINES) lines.value.splice(0, lines.value.length - MAX_LINES)
      scrollBottom()
    }
  })
}

function scrollBottom() {
  nextTick(() => {
    const el = bodyEl.value
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTop = el.scrollHeight
  })
}

function close() {
  visible.value = false
  if (unsub) { unsub(); unsub = null }
  if (streamId) { window.api.logStop(streamId); streamId = null }
  if (ownConnId) { window.api.sshClose(ownConnId); ownConnId = null }
}

// 标题栏拖动（视口坐标）
function startDrag(e) {
  anchor = { mx: e.clientX - pos.x, my: e.clientY - pos.y }
  const move = (ev) => {
    pos.x = Math.max(0, Math.min(window.innerWidth - 200, ev.clientX - anchor.mx))
    pos.y = Math.max(0, Math.min(window.innerHeight - 60, ev.clientY - anchor.my))
  }
  const up = () => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
}

defineExpose({ open })
</script>

<style scoped>
.log-win {
  position: fixed;
  display: flex;
  flex-direction: column;
  background: var(--bg0);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55);
  z-index: 90;
  min-width: 320px;
  min-height: 120px;
}
.log-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg1);
  cursor: move;
  user-select: none;
  flex-shrink: 0;
  border-radius: var(--radius) var(--radius) 0 0;
}
.log-title { font-size: 12.5px; font-weight: 600; flex-shrink: 0; }
.log-file { font-size: 10.5px; max-width: 200px; }
.log-kw {
  width: 150px;
  font-size: 11px;
  padding: 3px 8px;
  flex-shrink: 0;
}
.icon-xs { font-size: 11px; padding: 2px 6px; flex-shrink: 0; }
.log-body {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 6px 10px;
  user-select: text;
}
.log-line {
  font-size: 11.3px;
  line-height: 1.55;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-all;
}
.log-line :deep(mark) {
  background: rgba(242, 177, 85, 0.35);
  color: var(--text);
  border-radius: 2px;
  padding: 0 1px;
}
.log-trunc { font-size: 11px; color: var(--amber); padding-bottom: 6px; }
</style>
