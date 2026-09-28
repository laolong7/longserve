<template>
  <div class="tabbar">
    <div class="tabs">
      <div
        v-for="tab in store.tabs"
        :key="tab.__uid"
        class="tab"
        :class="{ active: tab.id === store.activeTabId }"
        @click="store.setActive(tab.id)"
        @auxclick="tab.id === store.activeTabId && close(tab)"
        :title="`${tab.instance.username}@${tab.instance.host}:${tab.instance.port}`"
      >
        <span class="dot" :class="tab.status === 'connected' ? 'on' : tab.status === 'connecting' ? 'mid' : 'off'"></span>
        <span class="tab-name ellipsis">{{ tab.name }}</span>
        <!-- 连接质量：每 10s 用 no-op 命令测往返，窗口内失败占比近似丢包 -->
        <span
          v-if="tab.status === 'connected' && qualityOf(tab)"
          class="rtt mono"
          :class="{ bad: qualityOf(tab).rtt == null || qualityOf(tab).loss >= 30, slow: qualityOf(tab).rtt > 300 }"
          :title="`延迟 ${qualityOf(tab).rtt == null ? '超时' : qualityOf(tab).rtt + 'ms'} · 近 2 分钟丢包约 ${qualityOf(tab).loss}%`"
        >{{ qualityOf(tab).rtt == null ? '✕' : qualityOf(tab).rtt + 'ms' }}</span>
        <span class="close" title="关闭连接" @click.stop="close(tab)">×</span>
      </div>
    </div>

    <div class="actions">
      <button
        v-if="store.activeTab && store.activeTab.status === 'connected'"
        class="ghost tb-ico"
        title="服务器日志（实时跟随）"
        @click="emit('open-logs')"
      >▤</button>
      <button
        v-if="store.activeTab && store.activeTab.status === 'connected'"
        class="ghost tb-ico"
        title="端口转发（本地 / 远程隧道）"
        @click="emit('open-tunnels')"
      >⇄</button>
      <button
        v-if="store.activeTab"
        class="ghost tb-ico"
        title="对当前服务器再开一个并行连接"
        @click="duplicate"
      >⧉</button>
      <button
        v-if="store.activeTab"
        class="ghost tb-ico"
        :class="{ on: store.split }"
        title="并列：选一台服务器与当前终端上下各占一半（最多两个）"
        @click="splitView"
      >◫</button>
      <button
        v-if="store.activeTab && store.activeTab.status === 'connected'"
        class="ghost tb-ico rec"
        :class="{ recording: !!store.recording }"
        :title="store.recording ? `停止录制并保存（正在录制 ${store.recording.tabName}）` : '录制当前终端会话（asciinema 格式）'"
        @click="toggleRecord"
      >⏺</button>
      <button
        v-if="store.activeTab && store.activeTab.status === 'connected'"
        class="ghost tb-ico"
        title="文件传输（SFTP）"
        @click="emit('open-files')"
      >⇅</button>
    </div>
  </div>
</template>

<script setup>
import { useTerminalStore } from '../stores/terminals'
import { useConfigStore } from '../stores/config'
import { useDialogStore } from '../stores/dialog'

const emit = defineEmits(['open-files', 'open-logs', 'open-tunnels'])
const store = useTerminalStore()
const config = useConfigStore()
const dialog = useDialogStore()

const qualityOf = store.qualityOf

function duplicate() {
  if (store.activeTab) store.openTab(store.activeTab.instance)
}
// 并列：先选要与当前终端并列的服务器（可以是当前这台，也可以是别的）
async function splitView() {
  if (!config.instances.length) {
    dialog.showToast('还没有添加服务器')
    return
  }
  const cur = store.activeTab
  const choice = await dialog.askChoice({
    title: '哪个服务器与当前终端并列？',
    message: `将与「${cur.name}」上下各占一半（选当前服务器则新开一条连接）。`,
    options: config.instances.map((i) => ({
      value: i.id,
      label: `${i.name}（${i.host}:${i.port}）${i.id === cur.instanceId ? ' ← 当前' : ''}`
    }))
  })
  if (!choice) return
  const inst = config.instances.find((i) => i.id === choice)
  if (!inst) return
  const r = await store.openSplit(inst)
  if (r === 'max') dialog.showToast('最多只能并列两个终端')
  else if (r === 'none') dialog.showToast('当前没有终端连接')
}
async function toggleRecord() {
  if (store.recording) {
    const r = await store.stopRecording()
    if (r.ok) dialog.showToast('已保存：' + r.path)
    else dialog.showToast(r.error)
    return
  }
  const r = store.startRecording(store.activeTab)
  if (r === 'ok') dialog.showToast('开始录制终端输出（asciinema 格式）')
  else if (r === 'busy') dialog.showToast('已有录制在进行')
  else dialog.showToast('当前没有已连接的终端')
}
function close(tab) {
  store.closeTab(tab.id)
}
</script>

<style scoped>
.tabbar {
  display: flex;
  align-items: stretch;
  background: var(--bg1);
  border-bottom: 1px solid var(--border);
  height: 36px;
  flex-shrink: 0;
}
.tabs {
  display: flex;
  flex: 1;
  overflow-x: auto;
  overflow-y: hidden;
}
.tabs::-webkit-scrollbar { height: 0; }
.tab {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 10px 0 12px;
  min-width: 120px;
  max-width: 220px;
  cursor: pointer;
  border-right: 1px solid var(--border);
  color: var(--text-dim);
  transition: background 0.1s;
}
.tab:hover { background: var(--bg2); }
.tab.active {
  background: var(--bg0);
  color: var(--text);
  box-shadow: inset 0 2px 0 var(--green);
}
.tab-name { flex: 1; font-size: 12.5px; }
.rtt { font-size: 10px; color: var(--text-faint); flex-shrink: 0; }
.rtt.slow { color: var(--amber); }
.rtt.bad { color: var(--red); }
.close {
  width: 16px;
  height: 16px;
  line-height: 14px;
  text-align: center;
  border-radius: 3px;
  font-size: 14px;
  opacity: 0;
  flex-shrink: 0;
}
.tab:hover .close { opacity: 0.7; }
.close:hover { background: var(--red-dim); color: var(--red); opacity: 1; }
.actions {
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 0 6px;
  border-left: 1px solid var(--border);
  flex-shrink: 0;
}
/* 图标化按钮：只留符号留 title，避免挤占标签栏把终端标签的关闭叉顶没 */
.actions .ghost.tb-ico {
  width: 30px;
  min-width: 30px;
  padding: 4px 0;
  font-size: 14px;
  text-align: center;
  white-space: nowrap;
}
.actions .ghost.on { color: var(--green); }
.actions .ghost.rec.recording { color: var(--red); animation: rec-blink 1.4s ease-in-out infinite; }
@keyframes rec-blink { 50% { opacity: 0.5; } }
</style>
