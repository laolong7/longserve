<template>
  <div class="pane-wrap" v-show="visible" @mousedown="store.setActive(tab.id)">
    <div ref="hostEl" class="term-host"></div>

    <!-- 连接中 / 断线覆盖层 -->
    <div v-if="tab.status !== 'connected'" class="pane-overlay">
      <template v-if="tab.status === 'connecting'">
        <div class="conn-anim">
          <div class="conn-ring"></div>
          <div class="conn-ring delay"></div>
        </div>
        <div class="conn-title">正在连接 {{ tab.instance.host }}:{{ tab.instance.port }}</div>
        <!-- 真实连接阶段日志（来自 ssh2 事件流） -->
        <div class="conn-log">
          <div v-for="(line, i) in connLog" :key="i" class="conn-line" :class="{ last: i === connLog.length - 1 }">
            <span class="conn-tick">{{ i === connLog.length - 1 && tab.status === 'connecting' ? '›' : '✓' }}</span>{{ line }}
          </div>
          <div v-if="!connLog.length" class="conn-line faint">初始化…</div>
        </div>
      </template>
      <template v-else>
        <div class="overlay-title">{{ tab.error || '连接已断开' }}</div>
        <button class="primary" @click="store.reconnect(tab)">重新连接</button>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useTerminalStore } from '../stores/terminals'
import { useConfigStore } from '../stores/config'
import { getTermTheme } from '../utils/appearance'

const props = defineProps({
  tab: { type: Object, required: true },
  visible: { type: Boolean, default: false } // 全屏模式=是否激活标签；并列模式=是否在并列两格中
})

const store = useTerminalStore()
const config = useConfigStore()
const hostEl = ref(null)

let term = null
let fitAddon = null
let resizeObserver = null
let unsubData = null
let unsubClose = null
let unsubStage = null
// 连接阶段日志（ssh2 真实事件流，连接动画里滚动展示）
const connLog = ref([])
let lastConnId = null

// ---------- 环形缓冲：AI 读取的兜底通道（保留最近输出，剥离 ANSI） ----------
const RING_MAX_LINES = 500
const RING_MAX_BYTES = 64 * 1024
const ring = { lines: [], bytes: 0 }

function stripAnsi(s) {
  return s.replace(
    /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()][0-9A-B]|\x1b[=>]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g,
    ''
  )
}

// 渲染层没有 Buffer：跨进程传来的二进制是 Uint8Array，统一转换
const decoder = new TextDecoder('utf8')
function toU8(d) {
  if (d instanceof Uint8Array) return d
  if (typeof d === 'string') return new TextEncoder().encode(d)
  return new Uint8Array(d || [])
}

function ringPush(chunk) {
  const clean = stripAnsi(decoder.decode(toU8(chunk)))
  const parts = clean.split('\n')
  // 首段拼接到最后一行
  if (ring.lines.length && parts[0]) {
    ring.bytes += parts[0].length
    ring.lines[ring.lines.length - 1] += parts[0]
  } else if (parts[0]) {
    ring.lines.push(parts[0])
    ring.bytes += parts[0].length
  }
  for (let i = 1; i < parts.length; i++) {
    const line = parts[i]
    ring.lines.push(line)
    ring.bytes += line.length + 1
  }
  // 裁剪
  while (ring.lines.length > RING_MAX_LINES) {
    ring.bytes -= ring.lines.shift().length + 1
  }
  while (ring.bytes > RING_MAX_BYTES && ring.lines.length > 1) {
    ring.bytes -= ring.lines.shift().length + 1
  }
}

// ---------- AI 读屏：xterm buffer 主通道 + 环形缓冲兜底 ----------
function readScreen() {
  if (!term) return '[错误] 终端未就绪'
  const buf = term.buffer.active
  const isAlt = buf.type === 'alternate'
  const total = buf.length
  const MAX_LINES = 400
  const start = Math.max(0, total - MAX_LINES)
  const lines = []
  for (let y = start; y < total; y++) {
    const line = buf.getLine(y)
    lines.push(line ? line.translateToString(true) : '')
  }
  while (lines.length && !lines[0].trim()) lines.shift()
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()

  let out = `屏幕模式：${isAlt ? '全屏程序（alternate buffer，如 vim/htop）' : '普通 shell'}\n`
  out += `--- 终端屏幕内容（${lines.length} 行）---\n`
  out += lines.join('\n')
  const recent = ring.lines.slice(-80).filter((l) => l.trim()).join('\n')
  if (recent) {
    out += `\n\n--- 最近输出流（最多 80 行，可能含已滚出屏幕的内容）---\n${recent}`
  }
  return out
}

function fit() {
  if (!term || !hostEl.value) return
  try {
    fitAddon.fit()
  } catch { /* 容器尺寸为 0 时跳过 */ }
}

// ---------- 连接事件绑定（connId 变化时重新绑定，支持重连） ----------
function bindConn(connId) {
  if (unsubData) { unsubData(); unsubData = null }
  if (unsubClose) { unsubClose(); unsubClose = null }
  if (unsubStage) { unsubStage(); unsubStage = null }
  connLog.value = []
  lastConnId = connId
  if (!connId || !connId.startsWith('conn_')) return

  ;(async () => {
    unsubStage = window.api.on(`conn:stage:${connId}`, (msg) => {
      connLog.value.push(msg)
    })
    // 先订阅事件再 attach：attach 返回的缓冲之后不会有重复数据
    unsubData = window.api.on(`term:data:${connId}`, (data) => {
      const u8 = toU8(data)
      term.write(u8)
      ringPush(u8)
    })
    unsubClose = window.api.on(`term:close:${connId}`, (info) => {
      // 同步 store 状态（此前断线后 status 卡在 connected 的 bug）
      if (props.tab.status === 'connected') {
        props.tab.status = 'closed'
        props.tab.error = info && info.reason && info.reason !== '会话已结束' ? info.reason : null
        term.writeln('\r\n\x1b[33m※ 连接已断开\x1b[0m')
        // 非主动断开：自动重连（最多 3 次，间隔 3s）
        if (!info || !info.intentional) store.scheduleReconnect(props.tab)
      }
    })
    const pending = await window.api.sshAttach(connId)
    if (pending) {
      const u8 = toU8(pending)
      term.write(u8)
      ringPush(u8)
    }
    fit()
    term.focus()
  })()
}

watch(
  () => props.tab.id,
  (newId, oldId) => {
    if (newId !== lastConnId && newId) bindConn(newId)
  }
)
// 外观设置变化：终端背景/前景/光标/选区/字号实时跟随
watch(
  () => config.appearance,
  (a) => {
    if (!term) return
    term.options.theme = getTermTheme(a)
    const fs = a && a.termFontSize ? Number(a.termFontSize) : 14
    if (term.options.fontSize !== fs) {
      term.options.fontSize = fs
      nextTick(fit)
    }
  },
  { deep: true }
)

// 面板变为可见时重新适配尺寸（v-show 隐藏期间容器为 0 尺寸）
watch(
  () => props.visible,
  (a) => {
    if (a) nextTick(() => { fit() })
  }
)
// 激活标签（含并列模式点击某格）：聚焦该终端，键盘输入直达
const isActive = computed(() => store.activeTabId === props.tab.id)
watch(isActive, (a) => {
  if (a && props.visible) nextTick(() => term && term.focus())
})
watch(
  () => props.tab.status,
  (st) => {
    if (st === 'connected') {
      // 重连成功：清屏重新开始，视觉上干净
      if (term && ring.lines.length) {
        term.reset()
        ring.lines = []
        ring.bytes = 0
      }
    }
  }
)

onMounted(() => {
  term = new Terminal({
    fontSize: (config.appearance && config.appearance.termFontSize) || 14,
    fontFamily: "'Cascadia Mono', 'Consolas', monospace",
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    allowTransparency: true, // 不开这个 xterm 会把半透明背景强制画成不透明（终端不透明的根因）
    theme: getTermTheme(config.appearance) // 主题由外观系统统一生成（背景吃色相与透明度）
  })
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(hostEl.value)
  fit()

  // 键盘输入 -> 服务器（与手敲完全一致）
  term.onData((d) => {
    if (props.tab.id.startsWith('conn_')) window.api.sshWrite(props.tab.id, d)
  })
  // 尺寸变化 -> 同步远端 pty
  term.onResize(({ rows, cols }) => {
    if (props.tab.id.startsWith('conn_')) window.api.sshResize(props.tab.id, rows, cols)
  })

  resizeObserver = new ResizeObserver(() => fit())
  resizeObserver.observe(hostEl.value)

  // 注册给 store（AI 读写当前终端用；key 用 tab 对象引用，重连换 id 不失效）
  store.registerPane(props.tab, {
    get term() { return term },
    readScreen
  })

  bindConn(props.tab.id)
  // 连接建立后主动对齐一次实际尺寸
  if (props.tab.id.startsWith('conn_')) {
    window.api.sshResize(props.tab.id, term.rows, term.cols)
  }
  term.focus()
})

onBeforeUnmount(() => {
  store.unregisterPane(props.tab)
  if (unsubData) unsubData()
  if (unsubClose) unsubClose()
  if (unsubStage) unsubStage()
  if (resizeObserver) resizeObserver.disconnect()
  if (term) term.dispose()
})
</script>

<style scoped>
.pane-wrap {
  position: relative;
  height: 100%;
  background: var(--bg0);
}
.term-host { height: 100%; padding: 4px 6px 2px; }
.pane-overlay {
  position: absolute;
  inset: 0;
  background: rgba(20, 22, 27, 0.82);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--text-dim);
  font-size: 14px;
}
.overlay-title { color: var(--red); font-size: 15px; margin-bottom: 2px; }

/* 连接动画：双环呼吸旋转 */
.conn-anim {
  position: relative;
  width: 44px;
  height: 44px;
}
.conn-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 2px solid transparent;
  border-top-color: var(--green);
  animation: conn-spin 1s linear infinite;
}
.conn-ring.delay {
  inset: 8px;
  border-top-color: var(--blue);
  animation-duration: 1.5s;
  animation-direction: reverse;
}
@keyframes conn-spin { to { transform: rotate(360deg); } }
.conn-title { color: var(--text); font-size: 14px; }
.conn-log {
  margin-top: 10px;
  max-width: 420px;
  max-height: 160px;
  overflow-y: auto;
  font-family: 'Cascadia Mono', 'Consolas', monospace;
  font-size: 11.5px;
  text-align: left;
}
.conn-line {
  color: var(--text-dim);
  padding: 1px 0;
  display: flex;
  gap: 6px;
}
.conn-line.last { color: var(--green); animation: conn-pulse 1.4s ease-in-out infinite; }
.conn-line.faint { color: var(--text-faint); }
.conn-tick { width: 12px; flex-shrink: 0; }
@keyframes conn-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
</style>
