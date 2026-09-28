<template>
  <div class="app-root">
    <!-- 左栏：实例列表 -->
    <div class="left-col" :style="{ width: leftW + 'px' }">
      <InstanceList @open-files="openFiles" />
    </div>
    <div class="splitter" @mousedown.prevent="startDrag('left')"></div>

    <!-- 中栏：终端标签 + 终端 -->
    <div class="center-col">
      <TerminalTabs @open-files="openFiles" />
      <div class="panes" v-if="store.tabs.length">
        <TerminalPane
          v-for="tab in store.tabs"
          :key="tab.__uid"
          :tab="tab"
          :active="tab.id === store.activeTabId"
        />
      </div>
      <div class="panes" v-else>
        <div class="empty-hint">
          <div class="big">⌘</div>
          <div>在左侧双击服务器实例即可建立连接</div>
          <div class="faint">支持多开：同一台服务器可同时建立多个连接</div>
        </div>
      </div>
    </div>

    <div class="splitter" @mousedown.prevent="startDrag('right')"></div>

    <!-- 右栏：AI 副驾 -->
    <div class="right-col" :style="{ width: rightW + 'px' }">
      <AiChat @open-settings="openSettings('ai')" />
    </div>

    <!-- 全局弹窗 -->
    <DialogHost />
    <SettingsDialog ref="settingsRef" />
    <FileTransferDialog ref="filesRef" />
  </div>
</template>

<script setup>
import { ref, onMounted, provide } from 'vue'
import InstanceList from './components/InstanceList.vue'
import TerminalTabs from './components/TerminalTabs.vue'
import TerminalPane from './components/TerminalPane.vue'
import AiChat from './components/AiChat.vue'
import DialogHost from './components/DialogHost.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import FileTransferDialog from './components/FileTransferDialog.vue'
import { useConfigStore } from './stores/config'
import { useTerminalStore } from './stores/terminals'

const config = useConfigStore()
const store = useTerminalStore()

const settingsRef = ref(null)
const filesRef = ref(null)
// action: { type:'new-instance' } | { type:'edit-instance', id } | undefined
const openSettings = (tabName, action) => settingsRef.value?.open(tabName, action)
const openFiles = () => filesRef.value?.open()
provide('openSettings', openSettings)

onMounted(() => config.init())

// ---------- 栏宽拖拽 ----------
const leftW = ref(240)
const rightW = ref(360)

function startDrag(side) {
  const startX = side === 'left' ? leftW.value : rightW.value
  const origin = side === 'left' ? 0 : window.innerWidth
  const move = (e) => {
    const delta = side === 'left' ? e.clientX - origin : origin - e.clientX
    const w = Math.min(520, Math.max(170, startX + delta))
    if (side === 'left') leftW.value = w
    else rightW.value = w
  }
  const up = () => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
  document.body.style.cursor = 'col-resize'
}
</script>

<style scoped>
.app-root {
  display: flex;
  height: 100%;
}
.left-col,
.right-col {
  flex-shrink: 0;
  background: var(--bg1);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.right-col { background: #1b1922; } /* AI 区暗紫基调 */
.center-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.panes {
  flex: 1;
  min-height: 0;
  position: relative;
}
.splitter {
  width: 4px;
  cursor: col-resize;
  flex-shrink: 0;
  background: transparent;
  transition: background 0.15s;
}
.splitter:hover { background: var(--blue-dim); }
</style>
