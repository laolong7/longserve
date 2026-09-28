<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-mask" @click.self="close">
      <div class="modal cast-modal">
        <div class="cast-head">
          <span class="cast-title">录制回放</span>
          <span v-if="curFile" class="mono faint ellipsis" style="max-width:320px">{{ curFile }}</span>
          <div class="grow"></div>
          <button class="ghost" @click="close">✕</button>
        </div>

        <div class="cast-body">
          <!-- 左：录制文件列表 -->
          <div class="cast-list">
            <div class="cast-list-head">
              <span>录制文件（.cast）</span>
              <button class="ghost" style="font-size:11px; padding:2px 8px" title="刷新列表" @click="loadList">⟳</button>
            </div>
            <div v-if="!files.length" class="faint" style="padding:14px 10px; font-size:11.5px; text-align:center">
              还没有录制文件<br>终端标签栏点 ⏺ 录制试试
            </div>
            <div
              v-for="f in files"
              :key="f.path"
              class="cast-item"
              :class="{ on: curFile === f.path }"
              :title="f.path"
              @click="loadCast(f.path)"
            >
              <span class="ellipsis">{{ f.name }}</span>
              <span class="mono faint" style="font-size:10px">{{ fmtSize(f.size) }}</span>
            </div>
          </div>

          <!-- 右：播放器 -->
          <div class="cast-play">
            <div v-if="!curFile" class="empty-hint">
              <div class="big">▶</div>
              <div>选择左侧录制文件开始回放</div>
            </div>
            <template v-else>
              <div ref="screenEl" class="cast-screen"></div>
              <div class="cast-ctrl">
                <button class="primary" style="min-width:64px" @click="togglePlay">{{ playing ? '⏸ 暂停' : (finished ? '⟲ 重播' : '▶ 播放') }}</button>
                <input
                  type="range"
                  min="0"
                  :max="Math.max(1, Math.round(duration))"
                  :value="Math.round(pos)"
                  style="flex:1"
                  @input="seek(+($event.target.value))"
                />
                <span class="mono faint" style="font-size:11px; width:86px; text-align:center">{{ fmtT(pos) }} / {{ fmtT(duration) }}</span>
                <select v-model.number="speed" style="width:64px" title="播放倍速">
                  <option :value="0.5">0.5x</option>
                  <option :value="1">1x</option>
                  <option :value="2">2x</option>
                  <option :value="4">4x</option>
                  <option :value="8">8x</option>
                </select>
                <button :disabled="recordingVideo" :title="recordingVideo ? '导出中…' : '把本次回放录成 WebM 视频文件'" @click="exportVideo">
                  {{ recordingVideo ? '导出中…' : '⬇ 导出视频' }}
                </button>
              </div>
              <div class="faint" style="font-size:11px; padding:2px 2px 0">
                导出 = 从头完整播放一遍并录成 WebM（时长=回放时长÷倍速），保存到录制文件同目录。
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
// 回放实现：解析 asciinema v2 格式（首行元信息 + [相对秒,"o",文本] 事件流），
// 用 canvas 渲染的 xterm 定时重放；导出视频 = canvas.captureStream + MediaRecorder 录 WebM。
import { ref, onBeforeUnmount, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { CanvasAddon } from '@xterm/addon-canvas'
import '@xterm/xterm/css/xterm.css'
import { getTermTheme } from '../utils/appearance'
import { useConfigStore } from '../stores/config'
import { useDialogStore } from '../stores/dialog'

const config = useConfigStore()
const dialog = useDialogStore()

const visible = ref(false)
const files = ref([])
const curFile = ref('')
const playing = ref(false)
const finished = ref(false)
const pos = ref(0)
const duration = ref(0)
const speed = ref(1)
const recordingVideo = ref(false)
const screenEl = ref(null)

let term = null
let canvasAddon = null
let allEvents = [] // [t, "o", text]（完整事件流，不消费）
let playIdx = 0 // 下一个待写入的事件下标
let playFrom = 0 // 起播的 t（秒）
let clockStart = 0 // performance.now 起点
let timer = null
let recorder = null
let chunks = []

async function open() {
  visible.value = true
  await loadList()
}
defineExpose({ open })

async function loadList() {
  let dir = config.recordDir
  if (!dir) {
    try { dir = await window.api.recordingsDefaultDir() } catch { dir = '' }
  }
  if (!dir) return
  const res = await window.api.localList(dir)
  files.value = res.ok
    ? res.entries.filter((e) => !e.isDir && e.name.endsWith('.cast')).map((e) => ({ path: e.path, name: e.name, size: e.size }))
    : []
}

async function loadCast(path) {
  stopPlay()
  curFile.value = path
  const res = await window.api.recordingsRead(path)
  if (!res.ok) return dialog.showToast('读取失败：' + res.error)
  const lines = res.content.split('\n')
  let header
  try { header = JSON.parse(lines[0]) } catch { return dialog.showToast('文件不是合法的 cast 格式') }
  if (header.version !== 2) return dialog.showToast('仅支持 version=2 的 cast 文件')
  allEvents = []
  for (const l of lines.slice(1)) {
    if (!l.trim()) continue
    try {
      const e = JSON.parse(l)
      if (e[1] === 'o' && typeof e[2] === 'string') allEvents.push(e)
    } catch { /* 坏行跳过 */ }
  }
  duration.value = allEvents.length ? allEvents[allEvents.length - 1][0] : 0
  pos.value = 0
  finished.value = false

  await nextTick()
  if (term) term.dispose()
  term = new Terminal({
    cols: header.width || 120,
    rows: header.height || 30,
    fontSize: 12,
    scrollback: 0,
    allowTransparency: true,
    theme: getTermTheme(config.appearance),
    convertEol: false
  })
  term.open(screenEl.value)
  try {
    canvasAddon = new CanvasAddon()
    term.loadAddon(canvasAddon)
  } catch { /* canvas 不可用时回退 DOM 渲染，仅影响导出视频 */ }
  playFrom = 0
}

function togglePlay() {
  if (playing.value) return pause()
  if (finished.value || pos.value >= duration.value) return play(0)
  play(pos.value)
}
// 从任意时刻起播：reset 后把 [0, fromT] 的事件瞬间写入（保证画面状态一致）
function play(fromT) {
  pause()
  term.reset()
  let idx = 0
  while (idx < allEvents.length && allEvents[idx][0] <= fromT) {
    term.write(allEvents[idx][2])
    idx++
  }
  playIdx = idx
  playFrom = fromT
  clockStart = performance.now()
  finished.value = false
  playing.value = true
  timer = setInterval(tick, 40)
}
function pause() {
  playing.value = false
  clearInterval(timer)
  timer = null
}
function stopPlay() {
  pause()
  pos.value = 0
  finished.value = false
}
function tick() {
  const elapsed = playFrom + ((performance.now() - clockStart) / 1000) * speed.value
  while (playIdx < allEvents.length && allEvents[playIdx][0] <= elapsed) {
    term.write(allEvents[playIdx][2])
    playIdx++
  }
  pos.value = Math.min(elapsed, duration.value)
  if (playIdx >= allEvents.length) {
    pause()
    pos.value = duration.value
    finished.value = true
    if (recordingVideo.value) finishExport()
  }
}
function seek(t) {
  play(t)
}

// ---------- 导出 WebM ----------
async function exportVideo() {
  if (!allEvents.length || recordingVideo.value) return
  const canvas = term.element && term.element.querySelector('canvas')
  if (!canvas || typeof MediaRecorder === 'undefined' || !canvas.captureStream) {
    dialog.showToast('当前环境不支持视频导出（需要 canvas 渲染）')
    return
  }
  recordingVideo.value = true
  chunks = []
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || ''
  recorder = new MediaRecorder(canvas.captureStream(30), mime ? { mimeType: mime } : undefined)
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  recorder.onstop = async () => {
    recordingVideo.value = false
    const blob = new Blob(chunks, { type: 'video/webm' })
    const b64 = await blobToBase64(blob)
    const out = curFile.value.replace(/\.cast$/, '') + '.webm'
    const res = await window.api.recordingsWriteBinary(out, b64)
    dialog.showToast(res.ok ? `视频已保存：${out}（${fmtSize(res.size)}）` : '导出失败：' + res.error)
  }
  recorder.start(200)
  play(0) // 从头播一遍，播完 tick 里自动 finishExport
}
function finishExport() {
  if (recorder && recorder.state !== 'inactive') recorder.stop()
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = reject
    r.readAsDataURL(blob)
  })
}

function close() {
  pause()
  if (recorder && recorder.state !== 'inactive') recorder.stop()
  visible.value = false
}
function fmtT(s) {
  const m = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  return `${m}:${String(ss).padStart(2, '0')}`
}
function fmtSize(b) {
  if (b == null) return ''
  if (b < 1024) return b + 'B'
  if (b < 1048576) return (b / 1024).toFixed(1) + 'K'
  return (b / 1048576).toFixed(1) + 'M'
}

onBeforeUnmount(() => {
  pause()
  if (term) term.dispose()
})
</script>

<style scoped>
.cast-modal { width: 860px; height: 600px; }
.cast-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.cast-title { font-weight: 600; font-size: 14px; }
.cast-body { display: flex; flex: 1; min-height: 0; }
.cast-list {
  width: 220px;
  border-right: 1px solid var(--border);
  overflow-y: auto;
  padding: 8px;
  flex-shrink: 0;
}
.cast-list-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11.5px;
  color: var(--text-dim);
  padding: 2px 4px 8px;
}
.cast-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12px;
  border: 1px solid transparent;
  margin-bottom: 2px;
}
.cast-item:hover { background: var(--bg3); }
.cast-item.on { background: var(--bg3); border-color: var(--border-strong); }
.cast-play {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 10px 12px;
}
.cast-screen {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--bg0);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.cast-screen :deep(.xterm) { padding: 6px; }
.cast-ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 10px;
}
</style>
