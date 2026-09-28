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
        <span class="close" title="关闭连接" @click.stop="close(tab)">×</span>
      </div>
    </div>

    <div class="actions">
      <button
        v-if="store.activeTab"
        class="ghost"
        title="对当前服务器再开一个并行连接"
        @click="duplicate"
      >⧉ 多开</button>
      <button
        v-if="store.activeTab"
        class="ghost"
        :class="{ on: store.split }"
        title="与当前终端上下并列一条新连接（最多两个）"
        @click="splitView"
      >◫ 并列</button>
      <button
        v-if="store.activeTab && store.activeTab.status === 'connected'"
        class="ghost"
        title="文件传输（SFTP）"
        @click="emit('open-files')"
      >⇅ 文件</button>
    </div>
  </div>
</template>

<script setup>
import { useTerminalStore } from '../stores/terminals'
import { useDialogStore } from '../stores/dialog'

const emit = defineEmits(['open-files'])
const store = useTerminalStore()
const dialog = useDialogStore()

function duplicate() {
  if (store.activeTab) store.openTab(store.activeTab.instance)
}
async function splitView() {
  const r = await store.openSplit()
  if (r === 'max') dialog.showToast('最多只能并列两个终端')
  else if (r === 'none') dialog.showToast('当前没有终端连接')
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
  max-width: 200px;
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
  gap: 2px;
  padding: 0 8px;
  border-left: 1px solid var(--border);
}
.actions .ghost { font-size: 12px; padding: 4px 9px; }
.actions .ghost.on { color: var(--green); }
</style>
