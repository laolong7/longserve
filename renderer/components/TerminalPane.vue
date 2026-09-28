<template>
  <div class="pane-wrap" v-show="active">
    <div ref="hostEl" class="term-host"></div>

    <!-- 连接中 / 断线覆盖层 -->
    <div v-if="tab.status !== 'connected'" class="pane-overlay">
      <template v-if="tab.status === 'connecting'">
        <div class="dot mid"></div>
        <div>正在连接 {{ tab.instance.host }}:{{ tab.instance.port }} ...</div>
      </template>
      <template v-else>
        <div class="overlay-title">{{ tab.error || '连接已断开' }}</div>
        <button class="primary" @click="store.reconnect(tab)">重新连接</button>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useTerminalStore } from '../stores/terminals'
import { useConfigStore } from '../stores/config'
import { applyAppearance } from '../utils/appearance'

const props = defineProps({
  tab: { type: Object, required: true },
  active: { type: Boolean, default: false }
})

const store = useTerminalStore()
const config = useConfigStore()
const hostEl = ref(null)

let term = null
let fitAddon = null
let resizeObserver = null
let unsubData = null
let unsubClose = null
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
  lastConnId = connId
  if (!connId || !connId.startsWith('conn_')) return

  ;(async () => {
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
// 外观设置变化：终端背景/前景/光标/字号实时跟随
watch(
  () => config.appearance,
  (a) => {
    if (!term) return
    const t = applyAppearance(a)
    if (t) {
      term.options.theme = { ...term.options.theme, background: t.background, foreground: t.foreground, cursor: t.cursor }
    } else {
      term.options.theme = { ...term.options.theme, background: '#14161b', foreground: '#d8dce4', cursor: '#3fdc97' }
    }
    const fs = a && a.termFontSize ? Number(a.termFontSize) : 14
    if (term.options.fontSize !== fs) {
      term.options.fontSize = fs
      nextTick(fit)
    }
  },
  { deep: true }
)

// 切换到该标签时重新适配尺寸（v-show 隐藏期间容器为 0 尺寸）
watch(
  () => props.active,
  (a) => {
    if (a) nextTick(() => { fit(); term && term.focus() })
  }
)
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
    theme: {
      background: '#14161b',
      foreground: '#d8dce4',
      cursor: '#3fdc97',
      cursorAccent: '#14161b',
      selectionBackground: 'rgba(110,168,254,0.30)',
      black: '#282c34',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#dcdfe4',
      brightBlack: '#5c6370',
      brightRed: '#f2777a',
      brightGreen: '#99cc99',
      brightYellow: '#ffcc66',
      brightBlue: '#6699cc',
      brightMagenta: '#c678dd',
      brightCyan: '#66cccc',
      brightWhite: '#ffffff'
    }
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
</style>
