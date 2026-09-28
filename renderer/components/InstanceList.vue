<template>
  <div class="inst-list">
    <div class="col-head">
      <span class="col-title">服务器</span>
      <button class="ghost icon-btn" title="新增服务器" @click="addInstance">＋</button>
    </div>

    <div class="items">
      <div
        v-for="inst in config.instances"
        :key="inst.id"
        class="item"
        :class="{ live: isLive(inst.id) }"
        @dblclick="connect(inst)"
        @contextmenu.prevent="showMenu($event, inst)"
        :title="`${inst.username}@${inst.host}:${inst.port}（双击连接）`"
      >
        <span class="dot" :class="dotClass(inst.id)"></span>
        <div class="item-text">
          <div class="name ellipsis">{{ inst.name }}</div>
          <div class="addr mono ellipsis">{{ inst.host }}:{{ inst.port }}</div>
        </div>
        <span v-if="connCount(inst.id) > 1" class="multi mono" :title="`该服务器有 ${connCount(inst.id)} 个连接`">×{{ connCount(inst.id) }}</span>
      </div>

      <div v-if="!config.instances.length" class="empty-hint" style="padding: 40px 16px">
        <div class="faint" style="text-align:center">还没有服务器实例<br />点右上角 ＋ 添加</div>
      </div>
    </div>

    <!-- 右键菜单 -->
    <Teleport to="body">
      <div v-if="menu.visible" class="ctx-mask" @click="menu.visible = false" @contextmenu.prevent="menu.visible = false">
        <div class="ctx-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
          <div class="ctx-item" @click="connect(menu.inst)">连接</div>
          <div class="ctx-item" @click="connectNew(menu.inst)">多开一个连接</div>
          <div class="ctx-sep"></div>
          <div class="ctx-item" @click="editInstance(menu.inst)">编辑</div>
          <div class="ctx-item danger" @click="removeInstance(menu.inst)">删除</div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { reactive, inject } from 'vue'
import { useConfigStore } from '../stores/config'
import { useTerminalStore } from '../stores/terminals'
import { useDialogStore } from '../stores/dialog'

const openSettings = inject('openSettings', () => {})

const config = useConfigStore()
const store = useTerminalStore()
const dialog = useDialogStore()

const menu = reactive({ visible: false, x: 0, y: 0, inst: null })

function isLive(instanceId) {
  return store.tabs.some((t) => t.instanceId === instanceId && t.status === 'connected')
}
function connCount(instanceId) {
  return store.tabs.filter((t) => t.instanceId === instanceId).length
}
function dotClass(instanceId) {
  const tabs = store.tabs.filter((t) => t.instanceId === instanceId)
  if (!tabs.length) return ''
  if (tabs.some((t) => t.status === 'connected')) return 'on'
  if (tabs.some((t) => t.status === 'connecting')) return 'mid'
  return 'off'
}

function connect(inst) {
  menu.visible = false
  store.openTab(inst)
}
function connectNew(inst) {
  menu.visible = false
  store.openTab(inst)
}

function showMenu(e, inst) {
  menu.x = Math.min(e.clientX, window.innerWidth - 150)
  menu.y = Math.min(e.clientY, window.innerHeight - 160)
  menu.inst = inst
  menu.visible = true
}

function addInstance() {
  openSettings('instances', { type: 'new-instance' })
}
function editInstance(inst) {
  menu.visible = false
  openSettings('instances', { type: 'edit-instance', id: inst.id })
}
async function removeInstance(inst) {
  menu.visible = false
  const ok = await dialog.askConfirm({
    title: '删除服务器实例',
    message: `确定删除「${inst.name}」（${inst.host}:${inst.port}）？只删除本工具里的记录，不会影响服务器本身。`
  })
  if (!ok) return
  // 关闭该实例的所有连接标签
  for (const t of [...store.tabs]) {
    if (t.instanceId === inst.id) store.closeTab(t.id)
  }
  config.instances = config.instances.filter((i) => i.id !== inst.id)
  config.save()
}
</script>

<style scoped>
.inst-list { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.col-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--border);
}
.col-title { font-size: 12px; color: var(--text-dim); letter-spacing: 2px; }
.icon-btn { padding: 2px 8px; font-size: 14px; }
.items { flex: 1; overflow-y: auto; padding: 6px; }
.item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.1s;
}
.item:hover { background: var(--bg3); }
.item-text { min-width: 0; flex: 1; }
.name { font-size: 13px; }
.addr { font-size: 11px; color: var(--text-faint); margin-top: 1px; }
.multi {
  font-size: 10px;
  color: var(--green);
  background: var(--green-dim);
  border-radius: 8px;
  padding: 1px 6px;
}
.col-foot {
  border-top: 1px solid var(--border);
  padding: 6px;
}
.ctx-mask { position: fixed; inset: 0; z-index: 200; }
.ctx-menu {
  position: fixed;
  min-width: 140px;
  background: var(--bg2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  padding: 4px;
  z-index: 201;
}
.ctx-item {
  padding: 6px 12px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12.5px;
}
.ctx-item:hover { background: var(--bg3); }
.ctx-item.danger { color: var(--red); }
.ctx-sep { height: 1px; background: var(--border); margin: 3px 6px; }
</style>
