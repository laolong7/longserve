<template>
  <div
    class="pane-wrap"
    v-show="visible"
    @mousedown="store.setActive(tab.id)"
    @dragover.prevent
    @drop.prevent="onDrop"
  >
    <div ref="hostEl" class="term-host"></div>

    <!-- 并列模式：本格独立关闭（不用去挤被遮住的标签栏） -->
    <button
      v-if="inSplitPane"
      class="pane-close"
      title="关闭这个并列终端"
      @mousedown.stop
      @click="store.closeSplitPane(props.tab)"
    >✕</button>

    <!-- Ctrl+F 搜索条 -->
    <div v-if="searchOpen" class="search-bar" @mousedown.stop>
      <input
        ref="searchInputEl"
        v-model="searchText"
        placeholder="搜索终端内容…（Enter 下一个）"
        @keydown.enter.prevent="doSearch(1)"
        @keydown.esc="closeSearch"
      />
      <span class="mono faint s-info">{{ searchInfo }}</span>
      <button class="ghost" title="上一个" @click="doSearch(-1)">↑</button>
      <button class="ghost" title="下一个" @click="doSearch(1)">↓</button>
      <button class="ghost" title="关闭 (Esc)" @click="closeSearch">✕</button>
    </div>

    <!-- 选中文字浮动按钮：一键带上下文问 AI -->
    <button v-if="hasSelection" class="ask-ai" @mousedown.stop @click="askAi">✦ 问 AI</button>

    <!-- 拖拽文件上传进度 -->
    <div v-if="upload" class="drop-upload">
      <div class="du-text">↑ {{ upload.name }} → {{ upload.to }}</div>
      <div class="du-bar"><div class="du-bar-in" :style="{ width: upload.pct + '%' }"></div></div>
    </div>

    <!-- 连接中 / 断线覆盖层 -->
    <div v-if="tab.status !== 'connected'" class="pane-overlay">
      <template v-if="tab.status === 'connecting'">
        <div class="conn-anim">
          <div class="conn-ring r1"></div>
          <div class="conn-ring r2"></div>
          <div class="conn-ring r3"></div>
          <div class="conn-core"></div>
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
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { useTerminalStore } from '../stores/terminals'
import { useConfigStore } from '../stores/config'
import { useAiStore } from '../stores/ai'
import { useDialogStore } from '../stores/dialog'
import { getTermTheme } from '../utils/appearance'

const props = defineProps({
  tab: { type: Object, required: true },
  visible: { type: Boolean, default: false } // 全屏模式=是否激活标签；并列模式=是否在并列两格中
})

const store = useTerminalStore()
const config = useConfigStore()
const ai = useAiStore()
const dialog = useDialogStore()
const hostEl = ref(null)

let term = null
let fitAddon = null
let searchAddon = null
let resizeObserver = null
let unsubData = null
let unsubClose = null
let unsubStage = null

// ---------- 搜索（Ctrl+F） ----------
const searchOpen = ref(false)
const searchText = ref('')
const searchInfo = ref('')
const searchInputEl = ref(null)
// ---------- 选中问 AI ----------
const hasSelection = ref(false)
// ---------- 拖拽上传 ----------
const upload = ref(null) // { name, to, pct, taskId }

function openSearch() {
  searchOpen.value = true
  nextTick(() => { searchInputEl.value?.focus(); searchInputEl.value?.select() })
}
function closeSearch() {
  searchOpen.value = false
  searchAddon?.clearDecorations()
  term?.focus()
}
function doSearch(dir) {
  if (!searchAddon || !searchText.value) return
  const opts = { decorations: { matchOverviewRuler: '#a78bfa', activeMatchColorOverviewRuler: '#3fdc97' } }
  if (dir > 0) searchAddon.findNext(searchText.value, opts)
  else searchAddon.findPrevious(searchText.value, opts)
}
function bindSearchEvents() {
  searchAddon.onDidChangeResults((r) => {
    searchInfo.value = r.resultCount ? `${r.resultIndex + 1}/${r.resultCount}` : (searchText.value ? '无结果' : '')
  })
}

// ---------- 选中问 AI ----------
function askAi() {
  const sel = term && term.hasSelection() ? term.getSelection() : ''
  term && term.clearSelection()
  if (!sel.trim()) return
  const screen = term ? term.buffer.active : null
  let screenText = ''
  if (screen) {
    const rows = []
    for (let y = Math.max(0, screen.length - 30); y < screen.length; y++) {
      const l = screen.getLine(y)
      rows.push(l ? l.translateToString(true) : '')
    }
    screenText = rows.join('\n').slice(0, 1500)
  }
  ai.askSelection(sel, screenText, `${tab.value.instance.username}@${tab.value.instance.host}`)
    .catch((e) => dialog.showToast('发送失败：' + e.message))
}

// ---------- 拖拽本地文件上传 ----------
async function onDrop(e) {
  const tabv = props.tab
  if (!tabv.id.startsWith('conn_')) return
  const files = [...(e.dataTransfer?.files || [])]
  const paths = files.map((f) => window.api.filePathForDrop(f)).filter(Boolean)
  if (!paths.length) return
  const home = await window.api.sftpHome(tabv.id)
  const to = await dialog.askInput({
    title: `上传 ${paths.length} 个文件到服务器`,
    value: home.ok ? home.path : '/root/'
  })
  if (!to || !to.trim()) return
  const dest = to.trim().replace(/\/+$/, '') + '/'
  for (const p of paths) {
    const name = p.replace(/^.*[\\/]/, '')
    const taskId = window.api.sftpNewTaskId()
    upload.value = { name, to: dest, pct: 0, taskId }
    const unsubP = window.api.on(`sftp:progress:${taskId}`, (prog) => {
      if (upload.value && upload.value.taskId === taskId && prog.phase === 'transferring') {
        upload.value.pct = prog.percent
      }
    })
    try {
      const res = await window.api.sftpTransfer({
        connId: tabv.id, taskId, direction: 'upload', localPath: p, remotePath: dest + name
      })
      dialog.showToast(res.ok ? `已上传 ${name} → ${dest}` : `上传 ${name} 失败：` + res.error)
    } finally {
      unsubP()
      if (upload.value && upload.value.taskId === taskId) upload.value = null
    }
  }
}
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
  if (!connId) return

  // 本地终端（local_）：数据走 local:data / local:close，无连接阶段日志
  if (connId.startsWith('local_')) {
    ;(async () => {
      unsubData = window.api.on(`local:data:${connId}`, (data) => {
        const u8 = toU8(data)
        term.write(u8)
        ringPush(u8)
        store.recordChunk(connId, u8)
      })
      unsubClose = window.api.on(`local:close:${connId}`, () => {
        if (props.tab.status === 'connected') {
          props.tab.status = 'closed'
          term.writeln('\r\n\x1b[33m※ 本地终端已关闭\x1b[0m')
        }
      })
      const pending = await window.api.localAttach(connId)
      if (pending) {
        const u8 = toU8(pending)
        term.write(u8)
        ringPush(u8)
      }
      fit()
      term.focus()
    })()
    return
  }
  if (!connId.startsWith('conn_')) return

  ;(async () => {
    unsubStage = window.api.on(`conn:stage:${connId}`, (msg) => {
      connLog.value.push(msg)
    })
    // 先订阅事件再 attach：attach 返回的缓冲之后不会有重复数据
    unsubData = window.api.on(`term:data:${connId}`, (data) => {
      const u8 = toU8(data)
      term.write(u8)
      ringPush(u8)
      store.recordChunk(connId, u8) // 会话录制（未录制时是空操作）
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
// 本格是否处于上下并列中（显示独立关闭叉）
const inSplitPane = computed(() => {
  const s = store.split
  return !!s && (props.tab === s.top || props.tab === s.bottom)
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
  searchAddon = new SearchAddon()
  term.loadAddon(searchAddon)
  bindSearchEvents()
  // Ctrl+F 打开搜索（拦住不让字符进终端）
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
      openSearch()
      return false
    }
    return true
  })
  // 有选中文字时显示"问 AI"浮钮
  term.onSelectionChange(() => { hasSelection.value = !!(term && term.hasSelection()) })
  term.open(hostEl.value)
  fit()

  // 键盘输入 -> 服务器（与手敲完全一致）
  term.onData((d) => {
    if (props.tab.id.startsWith('conn_')) window.api.sshWrite(props.tab.id, d)
    else if (props.tab.id.startsWith('local_')) window.api.localWrite(props.tab.id, d)
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

// props.tab 在模板/script 里都要用（askAi / onDrop 引用实例数据）
const tab = computed(() => props.tab)
</script>

<style scoped>
.pane-wrap {
  position: relative;
  height: 100%;
  /* 不画底：xterm 主题背景本身就是半透明的（跟随全局/自定义都带 alpha），
     这里再垫一层 --bg0 会多叠一层导致终端比面板明显发黑，直接透出统一底色 */
  background: transparent;
}
.term-host { height: 100%; padding: 4px 6px 2px; }
/* Ctrl+F 搜索条：右上角浮层 */
.search-bar {
  position: absolute;
  top: 6px;
  right: 10px;
  display: flex;
  align-items: center;
  gap: 5px;
  background: var(--bg2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 5px 8px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  z-index: 20;
}
.search-bar input { width: 170px; font-size: 12px; padding: 3px 8px; }
.search-bar .ghost { font-size: 11px; padding: 2px 7px; }
.s-info { font-size: 11px; min-width: 40px; }
/* 选中文字后的"问 AI"浮钮 */
.ask-ai {
  position: absolute;
  right: 16px;
  bottom: 18px;
  background: var(--violet-dim);
  border: 1px solid rgba(167, 139, 250, 0.45);
  color: var(--violet);
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 14px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  z-index: 20;
}
.ask-ai:hover { background: rgba(167, 139, 250, 0.25); }
/* 拖拽上传进度浮条 */
.drop-upload {
  position: absolute;
  right: 12px;
  bottom: 14px;
  width: 240px;
  background: var(--bg2);
  border: 1px solid rgba(63, 220, 151, 0.45);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  z-index: 20;
}
.du-text { font-size: 11.5px; color: var(--green); margin-bottom: 5px; word-break: break-all; }
.du-bar { height: 5px; background: var(--bg0); border-radius: 3px; overflow: hidden; }
.du-bar-in { height: 100%; background: var(--green); transition: width 0.2s; }
/* 并列格独立关闭叉 */
.pane-close {
  position: absolute;
  top: 6px;
  right: 8px;
  width: 22px;
  height: 22px;
  line-height: 20px;
  text-align: center;
  padding: 0;
  font-size: 12px;
  color: var(--text-faint);
  background: rgba(20, 22, 27, 0.55);
  border: 1px solid var(--border);
  border-radius: 50%;
  z-index: 20;
}
.pane-close:hover {
  color: #fff;
  background: var(--red);
  border-color: var(--red);
}
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

/* 连接动画：三环相位差旋转 + 辉光 + 中心脉冲光核 */
.conn-anim {
  position: relative;
  width: 52px;
  height: 52px;
}
.conn-ring {
  position: absolute;
  border-radius: 50%;
  border: 2px solid transparent;
}
.conn-ring.r1 {
  inset: 0;
  border-top-color: var(--green);
  border-right-color: rgba(92, 207, 230, 0.25);
  filter: drop-shadow(0 0 4px rgba(92, 207, 230, 0.45));
  animation: conn-spin 1.1s linear infinite;
}
.conn-ring.r2 {
  inset: 7px;
  border-top-color: var(--blue);
  border-left-color: rgba(110, 168, 254, 0.22);
  filter: drop-shadow(0 0 3px rgba(110, 168, 254, 0.4));
  animation: conn-spin 1.6s linear infinite reverse;
}
.conn-ring.r3 {
  inset: 14px;
  border-top-color: var(--amber);
  filter: drop-shadow(0 0 3px rgba(242, 177, 85, 0.4));
  animation: conn-spin 0.8s linear infinite;
}
.conn-core {
  position: absolute;
  inset: 21px;
  border-radius: 50%;
  background: var(--green);
  animation: conn-core 1.2s ease-in-out infinite;
}
@keyframes conn-core {
  0%, 100% { transform: scale(0.55); opacity: 0.55; }
  50% { transform: scale(1); opacity: 1; }
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
