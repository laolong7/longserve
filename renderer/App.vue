<template>
  <div class="app-root">
    <TitleBar />
    <div class="app-main">
      <!-- 左栏：实例列表 + 监控仪表盘 + 服务面板（后两者可折叠） -->
      <div class="left-col" :style="{ width: leftW + 'px' }">
        <InstanceList @open-files="openFiles" />
        <MonitorPanel />
        <SystemdPanel />
        <button class="ghost settings-foot" @click="openSettings('instances')">⚙ 实例与 AI 设置</button>
      </div>
      <div class="splitter" @mousedown.prevent="startDrag('left', $event)"></div>

      <!-- 中栏：终端标签 + 终端 -->
      <div class="center-col">
        <TerminalTabs @open-files="openFiles" @open-logs="openLogs" @open-tunnels="openTunnels" />
        <div class="panes" :class="{ 'split-mode': !!store.split }" v-if="store.tabs.length">
          <TerminalPane
            v-for="tab in store.tabs"
            :key="tab.__uid"
            :tab="tab"
            :visible="store.isPaneVisible(tab)"
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

      <div class="splitter" @mousedown.prevent="startDrag('right', $event)"></div>

      <!-- 右栏：AI 副驾 -->
      <div class="right-col" :style="{ width: rightW + 'px' }">
        <AiChat @open-history="openHistory" @open-settings="openSettings('ai')" />
      </div>
    </div>

    <!-- 全局弹窗 -->
    <DialogHost />
    <SettingsDialog ref="settingsRef" />
    <FileTransferDialog ref="filesRef" />
    <HistoryDialog ref="historyRef" />
    <AboutDialog ref="aboutRef" />
    <TunnelDialog ref="tunnelsRef" />
    <LogViewer ref="logsRef" />
    <CastPlayerDialog ref="castRef" />
  </div>
</template>

<script setup>
import { ref, onMounted, provide, watch } from 'vue'
import TitleBar from './components/TitleBar.vue'
import InstanceList from './components/InstanceList.vue'
import MonitorPanel from './components/MonitorPanel.vue'
import SystemdPanel from './components/SystemdPanel.vue'
import TerminalTabs from './components/TerminalTabs.vue'
import TerminalPane from './components/TerminalPane.vue'
import AiChat from './components/AiChat.vue'
import DialogHost from './components/DialogHost.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import FileTransferDialog from './components/FileTransferDialog.vue'
import HistoryDialog from './components/HistoryDialog.vue'
import AboutDialog from './components/AboutDialog.vue'
import TunnelDialog from './components/TunnelDialog.vue'
import LogViewer from './components/LogViewer.vue'
import CastPlayerDialog from './components/CastPlayerDialog.vue'
import { useConfigStore } from './stores/config'
import { useTerminalStore } from './stores/terminals'
import { applyAppearance } from './utils/appearance'

const config = useConfigStore()
const store = useTerminalStore()

const settingsRef = ref(null)
const filesRef = ref(null)
const historyRef = ref(null)
const aboutRef = ref(null)
const tunnelsRef = ref(null)
const logsRef = ref(null)
const castRef = ref(null)
// action: { type:'new-instance' } | { type:'edit-instance', id } | undefined
const openSettings = (tabName, action) => settingsRef.value?.open(tabName, action)
const openFiles = () => filesRef.value?.open()
const openHistory = () => historyRef.value?.open()
const openAbout = () => aboutRef.value?.open('about')
const openGuide = () => aboutRef.value?.open('guide')
const openTunnels = () => tunnelsRef.value?.open(store.activeTab)
const openLogs = () => logsRef.value?.open()
const openCast = () => castRef.value?.open()
provide('openSettings', openSettings)
provide('openAbout', openAbout)
provide('openGuide', openGuide)
provide('openCast', openCast)

onMounted(async () => {
  await config.init()
  // 渲染按"实际生效"的窗口效果走：改效果选"下次打开时应用"时两者短暂不一致
  applyAppearance(config.appearance, config.runtimeEffect)
})
// 外观设置变化即时生效
watch(() => config.appearance, (a) => applyAppearance(a, config.runtimeEffect), { deep: true })

// ---------- 栏宽拖拽 ----------
const leftW = ref(240)
const rightW = ref(360)

// 侧边栏拖拽：以按下点为基准算 delta（旧实现从屏幕边缘算，会跳变乱跑）
function startDrag(side, e) {
  const startMouse = e.clientX
  const startW = side === 'left' ? leftW.value : rightW.value
  const move = (ev) => {
    const delta = ev.clientX - startMouse
    const max = Math.floor(window.innerWidth * 0.55) // 放宽上限：最大占视口 55%
    const w = Math.min(max, Math.max(160, side === 'left' ? startW + delta : startW - delta))
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
  flex-direction: column;
  height: 100%;
}
.app-main {
  flex: 1;
  min-height: 0;
  display: flex;
}
.left-col,
.right-col {
  flex-shrink: 0;
  background: var(--bg1);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.right-col { background: var(--bg1); } /* AI 区紫调由内部元素体现，背景跟随全局主题 */
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
  display: flex;
  flex-direction: column;
}
/* 并列模式：两个终端上下各占 1/2 */
.panes.split-mode .pane-wrap {
  flex: 1;
  min-height: 0;
  height: auto;
  border-bottom: 1px solid var(--border);
}
.panes.split-mode .pane-wrap:last-child { border-bottom: none; }
.splitter {
  width: 4px;
  cursor: col-resize;
  flex-shrink: 0;
  background: transparent;
  transition: background 0.15s;
}
.splitter:hover { background: var(--blue-dim); }
.settings-foot {
  border-top: 1px solid var(--border);
  border-radius: 0;
  text-align: left;
  padding: 9px 12px;
  font-size: 12px;
  flex-shrink: 0;
}
</style>
