<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-mask">
      <div class="modal ft-modal">
        <div class="ft-head">
          <span class="ft-title">文件传输</span>
          <span class="faint mono">{{ tabName }}</span>
          <div class="grow"></div>
          <button class="ghost" @click="close">✕ 关闭</button>
        </div>

        <div class="ft-panels">
          <!-- 本地面板 -->
          <div class="panel">
            <div class="panel-head">
              <span class="panel-tag">本机</span>
              <button class="ghost btn-xs" title="此电脑（磁盘列表）" @click="listLocal('__drives__')">🖥</button>
              <button class="ghost btn-xs" title="上级目录" @click="goUp(local)">↑</button>
              <input
                v-model="local.dirInput"
                class="path-input mono"
                @keydown.enter="listLocal(local.dirInput)"
              />
              <button class="ghost btn-xs" title="刷新" @click="refreshLocal">⟳</button>
            </div>
            <div class="panel-list" :class="{ dragging: dragOver === 'local' }">
              <div v-if="local.loading" class="panel-loading">读取中...</div>
              <div v-else-if="local.error" class="panel-error">{{ local.error }}</div>
              <div
                v-for="e in local.entries"
                :key="e.name"
                class="frow"
                :class="{ picked: local.selected.includes(e.name) }"
                :title="e.path"
              >
                <input
                  type="checkbox"
                  :checked="local.selected.includes(e.name)"
                  @click.stop="togglePick(local, e.name)"
                />
                <span class="ficon">{{ driveIcon(local, e) }}</span>
                <span class="fname ellipsis" @click="openEntry(local, 'local', e)">{{ e.name }}</span>
                <span class="fsize mono faint">{{ driveSize(local, e) || (e.isDir ? '' : fmtSize(e.size)) }}</span>
                <span class="fmtime mono faint">{{ fmtTime(e.mtime) }}</span>
              </div>
              <div v-if="!local.loading && !local.entries.length && !local.error" class="panel-loading">空目录</div>
            </div>
            <div class="panel-foot">
              <button class="btn-xs" @click="mkdir(local, 'local')">新建文件夹</button>
              <button class="btn-xs" @click="rename(local, 'local')">重命名</button>
              <button class="btn-xs danger" @click="del(local, 'local')">删除</button>
              <div class="grow"></div>
              <span class="faint" style="font-size:11px">已选 {{ local.selected.length }} 项</span>
            </div>
          </div>

          <!-- 中间传输按钮 -->
          <div class="ft-mid">
            <button class="mid-btn" :disabled="!local.selected.length || busy" title="本地选中项 → 远程当前目录" @click="doUpload">
              上传 →
            </button>
            <button class="mid-btn" :disabled="!remote.selected.length || busy" title="远程选中项 → 本地当前目录" @click="doDownload">
              ← 下载
            </button>
          </div>

          <!-- 远程面板 -->
          <div
            class="panel"
            @dragover.prevent="dragOver = 'remote'"
            @dragleave="dragOver === 'remote' && (dragOver = null)"
            @drop.prevent="onDrop"
          >
            <div class="panel-head">
              <span class="panel-tag remote">远程</span>
              <button class="ghost btn-xs" title="上级目录" @click="goUp(remote)">↑</button>
              <input
                v-model="remote.dirInput"
                class="path-input mono"
                @keydown.enter="listRemote(remote.dirInput)"
              />
              <button class="ghost btn-xs" title="刷新" @click="refreshRemote">⟳</button>
            </div>
            <div class="panel-list" :class="{ dragging: dragOver === 'remote' }">
              <div v-if="remote.loading" class="panel-loading">读取中...</div>
              <div v-else-if="remote.error" class="panel-error">{{ remote.error }}</div>
              <div
                v-for="e in remote.entries"
                :key="e.name"
                class="frow"
                :class="{ picked: remote.selected.includes(e.name) }"
                :title="e.path"
              >
                <input
                  type="checkbox"
                  :checked="remote.selected.includes(e.name)"
                  @click.stop="togglePick(remote, e.name)"
                />
                <span class="ficon">{{ e.isDir ? '📁' : '📄' }}</span>
                <span class="fname ellipsis" @click="openEntry(remote, 'remote', e)">{{ e.name }}</span>
                <span class="fsize mono faint">{{ e.isDir ? '' : fmtSize(e.size) }}</span>
                <span class="fmtime mono faint">{{ fmtTime(e.mtime) }}</span>
              </div>
              <div v-if="!remote.loading && !remote.entries.length && !remote.error" class="panel-loading">空目录</div>
              <div v-if="dragOver === 'remote'" class="drop-hint">松开鼠标上传到当前目录</div>
            </div>
            <div class="panel-foot">
              <button class="btn-xs" @click="mkdir(remote, 'remote')">新建文件夹</button>
              <button class="btn-xs" @click="rename(remote, 'remote')">重命名</button>
              <button class="btn-xs danger" @click="del(remote, 'remote')">删除</button>
              <div class="grow"></div>
              <span class="faint" style="font-size:11px">已选 {{ remote.selected.length }} 项 · 支持拖拽文件进来</span>
            </div>
          </div>
        </div>

        <!-- 传输任务 -->
        <div class="ft-tasks" v-if="transfers.length">
          <div class="tasks-head">传输任务</div>
          <div class="task" v-for="t in transfers" :key="t.taskId">
            <span class="task-kind">{{ t.kind === 'up' ? '↑' : '↓' }}</span>
            <span class="task-name ellipsis mono">{{ t.name }}</span>
            <div class="task-bar">
              <div class="task-bar-in" :class="t.status" :style="{ width: t.percent + '%' }"></div>
            </div>
            <span class="task-pct mono" :class="t.status">{{ taskStatusText(t) }}</span>
            <button
              v-if="t.status === 'running'"
              class="ghost btn-xs"
              @click="cancelTask(t)"
            >取消</button>
            <button v-else class="ghost btn-xs" @click="removeTask(t)">✕</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { useTerminalStore } from '../stores/terminals'
import { useDialogStore } from '../stores/dialog'

const store = useTerminalStore()
const dialog = useDialogStore()
const visible = ref(false)
const connId = ref(null)
const tabName = ref('')
const dragOver = ref(null)
const busy = ref(false)
const transfers = reactive([])

function makePanel() {
  return reactive({ dir: '', dirInput: '', entries: [], selected: [], loading: false, error: '' })
}
const local = makePanel()
const remote = makePanel()

function taskStatusText(t) {
  if (t.status === 'done') return '完成'
  if (t.status === 'error') return '失败'
  if (t.status === 'cancelled') return '已取消'
  return t.percent + '%'
}

// ---------- 打开/关闭 ----------
async function open() {
  const tab = store.activeTab
  if (!tab || tab.status !== 'connected') {
    alert('请先连接一个服务器，再使用文件传输')
    return
  }
  connId.value = tab.id
  tabName.value = `${tab.name}（${tab.instance.username}@${tab.instance.host}）`
  visible.value = true
  transfers.length = 0

  await listLocal('__drives__') // 本机默认显示磁盘布局
  const res = await window.api.sftpHome(connId.value)
  await listRemote(res.ok ? res.path : '/')
}
function close() {
  visible.value = false
}
defineExpose({ open })

// ---------- 目录浏览 ----------
// dir === '__drives__' 时显示"此电脑"盘符视图
async function listLocal(dir) {
  local.loading = true
  local.error = ''
  if (dir === '__drives__') {
    const res = await window.api.localDrives()
    local.loading = false
    if (!res.ok) { local.error = res.error; return }
    local.dir = '__drives__'
    local.dirInput = '此电脑'
    local.entries = res.entries
    local.selected = []
    return
  }
  const res = await window.api.localList(dir)
  local.loading = false
  if (!res.ok) {
    local.error = res.error
    return
  }
  local.dir = dir
  local.dirInput = dir
  local.entries = res.entries
  local.selected = []
}
async function listRemote(dir) {
  remote.loading = true
  remote.error = ''
  const res = await window.api.sftpList(connId.value, dir)
  remote.loading = false
  if (!res.ok) {
    remote.error = res.error
    return
  }
  remote.dir = dir
  remote.dirInput = dir
  remote.entries = res.entries
  remote.selected = []
}
const refreshLocal = () => listLocal(local.dir)
const refreshRemote = () => listRemote(remote.dir)

function goUp(panel) {
  if (panel === local && panel.dir === '__drives__') return
  const cur = panel.dir.replace(/[\\/]+$/, '')
  const idx = Math.max(cur.lastIndexOf('/'), cur.lastIndexOf('\\'))
  const up = idx > 0 ? cur.slice(0, idx) : idx === 0 ? cur.slice(0, 1) : '/'
  panel === local ? listLocal(up) : listRemote(up)
}

// 单击行：目录进入，文件不动作（选取只认复选框）
function openEntry(panel, side, e) {
  if (!e.isDir) return
  side === 'local' ? listLocal(e.path) : listRemote(e.path)
}

// 选取只通过复选框
function togglePick(panel, name) {
  const i = panel.selected.indexOf(name)
  if (i >= 0) panel.selected.splice(i, 1)
  else panel.selected.push(name)
}

// 盘符视图的图标与容量列
function driveIcon(panel, e) {
  if (panel === local && panel.dir === '__drives__') return '💾'
  return e.isDir ? '📁' : '📄'
}
function driveSize(panel, e) {
  if (panel === local && panel.dir === '__drives__' && e.size != null) {
    return fmtSize(e.free) + ' 可用'
  }
  return ''
}

// ---------- 文件操作 ----------
async function mkdir(panel, side) {
  const name = await dialog.askInput({ title: '新建文件夹', value: '' })
  if (!name) return
  const target = joinPath(side, panel.dir, name)
  const res = side === 'local'
    ? await window.api.localMkdir(target)
    : await window.api.sftpMkdir(connId.value, target)
  if (!res.ok) return alert('创建失败：' + res.error)
  side === 'local' ? refreshLocal() : refreshRemote()
}
async function rename(panel, side) {
  const sel = panel.selected
  if (sel.length !== 1) return alert('请勾选恰好一项进行重命名')
  const item = panel.entries.find((e) => e.name === sel[0])
  const newName = await dialog.askInput({ title: '重命名', value: item.name })
  if (!newName || newName === item.name) return
  const res = side === 'local'
    ? await window.api.localRename(item.path, joinPath(side, panel.dir, newName))
    : await window.api.sftpRename(connId.value, item.path, joinPath(side, panel.dir, newName))
  if (!res.ok) return alert('重命名失败：' + res.error)
  side === 'local' ? refreshLocal() : refreshRemote()
}
async function del(panel, side) {
  if (!panel.selected.length) return alert('请先勾选要删除的项')
  const ok = await dialog.askConfirm({
    title: '删除确认',
    message: `确定删除选中的 ${panel.selected.length} 项？（不可恢复）`
  })
  if (!ok) return
  for (const name of panel.selected) {
    const item = panel.entries.find((e) => e.name === name)
    if (!item) continue
    const res = side === 'local'
      ? await window.api.localDelete(item.path, item.isDir)
      : await window.api.sftpDelete(connId.value, item.path, item.isDir)
    if (!res.ok) alert(`删除 ${name} 失败：` + res.error)
  }
  side === 'local' ? refreshLocal() : refreshRemote()
}

function cancelTask(t) {
  window.api.sftpCancel(t.taskId)
}

// ---------- 传输 ----------
function bindProgress(task) {
  task._unsub = window.api.on(`sftp:progress:${task.taskId}`, (p) => {
    if (p.phase === 'done') {
      task.percent = 100
      task.status = 'done'
      task._unsub && task._unsub()
    } else if (p.phase === 'cancelled') {
      task.status = 'cancelled'
      task._unsub && task._unsub()
    } else if (p.phase === 'transferring') {
      task.percent = p.percent
    }
  })
}

async function runTransfer(direction, items) {
  // 下载目标必须是真实目录："此电脑"盘符视图没有落盘目录，历史版本会静默
  // 写到相对路径 __drives__\ 下（进度显示完成但找不到文件），这里直接拦住
  if (direction === 'download' && local.dir === '__drives__') {
    alert('请先在左侧进入一个具体的本机文件夹（如 D:\\downloads），再点下载')
    return
  }
  // 二次确认：明确列出传什么、传到哪
  const names = items.map((i) => i.name)
  const listText = names.length <= 5 ? names.join('、') : names.slice(0, 5).join('、') + ` 等 ${names.length} 项`
  const ok = await dialog.askConfirm({
    title: direction === 'upload' ? '确认上传' : '确认下载',
    message: direction === 'upload'
      ? `将 ${listText} 上传到服务器目录：\n${remote.dir}`
      : `将 ${listText} 下载到本机目录：\n${local.dir}${local.dir.endsWith('\\') || local.dir.endsWith('/') ? '' : '\\'}（${items.length === 1 ? items[0].name : items.length + ' 个文件'}）`
  })
  if (!ok) return

  busy.value = true
  try {
    for (const it of items) {
      const taskId = window.api.sftpNewTaskId()
      const task = reactive({ taskId, kind: direction === 'upload' ? 'up' : 'down', name: it.name, percent: 0, status: 'running' })
      transfers.push(task)
      bindProgress(task)
      const opts = {
        connId: connId.value,
        taskId,
        direction,
        localPath: direction === 'upload' ? it.path : joinPath('local', local.dir, it.name),
        remotePath: direction === 'upload' ? joinPath('remote', remote.dir, it.name) : it.path
      }
      const res = await window.api.sftpTransfer(opts)
      if (!res.ok && task.status === 'running') {
        task.status = 'error'
        task.error = res.error
        alert(`传输 ${it.name} 失败：` + res.error)
      }
    }
  } finally {
    busy.value = false
    await refreshRemote()
    await refreshLocal()
  }
}

function doUpload() {
  const items = local.entries.filter((e) => local.selected.includes(e.name))
  if (items.length) runTransfer('upload', items)
}
function doDownload() {
  const items = remote.entries.filter((e) => remote.selected.includes(e.name))
  if (items.length) runTransfer('download', items)
}

// 拖拽上传（支持文件夹递归）
function onDrop(e) {
  dragOver.value = null
  const files = [...(e.dataTransfer?.files || [])]
  const paths = files.map((f) => window.api.filePathForDrop(f)).filter(Boolean)
  if (!paths.length) return
  const items = paths.map((p) => ({ path: p, name: p.replace(/^.*[\\/]/, '') }))
  runTransfer('upload', items)
}

function removeTask(t) {
  t._unsub && t._unsub()
  const i = transfers.indexOf(t)
  if (i >= 0) transfers.splice(i, 1)
}

// ---------- 工具 ----------
function joinPath(side, dir, name) {
  if (side === 'remote') {
    return (dir === '/' ? '' : dir.replace(/\/+$/, '')) + '/' + name
  }
  return dir.replace(/[\\/]+$/, '') + '\\' + name
}
function fmtSize(bytes) {
  if (bytes == null) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB'
  return (bytes / 1073741824).toFixed(2) + ' GB'
}
function fmtTime(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<style scoped>
.ft-modal { width: 92vw; max-width: 1100px; height: 78vh; }
.ft-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.ft-title { font-weight: 600; font-size: 14px; }

.ft-panels { display: flex; flex: 1; min-height: 0; padding: 10px; gap: 8px; }
.panel {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg0);
  overflow: hidden;
  position: relative;
}
.panel-head {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 7px 8px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.panel-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 8px;
  background: var(--blue-dim);
  color: var(--blue);
  flex-shrink: 0;
}
.panel-tag.remote { background: var(--green-dim); color: var(--green); }
.path-input { flex: 1; min-width: 0; font-size: 11.5px; padding: 4px 8px; }
.btn-xs { font-size: 11.5px; padding: 3px 8px; flex-shrink: 0; }

.panel-list { flex: 1; overflow-y: auto; position: relative; }
.panel-list.dragging { outline: 2px dashed var(--green); outline-offset: -4px; }
.frow {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 10px;
  cursor: default;
  font-size: 12.3px;
}
.frow:hover { background: var(--bg2); }
.frow.picked { background: var(--blue-dim); }
.frow input[type='checkbox'] { cursor: pointer; }
.frow input[type='checkbox'] { flex-shrink: 0; }
.ficon { flex-shrink: 0; }
.fname { flex: 1; min-width: 0; cursor: pointer; }
.fsize { width: 70px; text-align: right; flex-shrink: 0; }
.fmtime { width: 118px; flex-shrink: 0; }
.panel-loading, .panel-error {
  padding: 20px;
  text-align: center;
  color: var(--text-faint);
}
.panel-error { color: var(--red); word-break: break-all; }
.drop-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--green-dim);
  color: var(--green);
  font-size: 14px;
  pointer-events: none;
}
.panel-foot {
  display: flex;
  gap: 5px;
  padding: 6px 8px;
  border-top: 1px solid var(--border);
  align-items: center;
  flex-shrink: 0;
}

.ft-mid {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
  width: 84px;
  flex-shrink: 0;
}
.mid-btn {
  padding: 8px 6px;
  font-size: 12px;
  white-space: nowrap;
}

.ft-tasks {
  max-height: 130px;
  overflow-y: auto;
  border-top: 1px solid var(--border);
  padding: 8px 14px;
  flex-shrink: 0;
}
.tasks-head { font-size: 11px; color: var(--text-dim); margin-bottom: 6px; }
.task {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 5px;
  font-size: 12px;
}
.task-kind { color: var(--green); }
.task-name { width: 200px; flex-shrink: 0; }
.task-bar {
  flex: 1;
  height: 6px;
  background: var(--bg0);
  border-radius: 3px;
  overflow: hidden;
}
.task-bar-in { height: 100%; background: var(--green); transition: width 0.15s; }
.task-bar-in.error { background: var(--red); }
.task-bar-in.cancelled { background: var(--text-faint); }
.task-pct { width: 48px; text-align: right; }
.task-pct.error { color: var(--red); }
</style>
