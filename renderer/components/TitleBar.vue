<template>
  <div class="title-bar" @dblclick="toggleMax">
    <div class="tb-drag">
      <span class="tb-logo">◆</span>
      <span class="tb-title">Longserve</span>
    </div>
    <div class="tb-actions">
      <button class="tb-btn tb-about" title="使用指南" @click="openGuide()">📖</button>
      <button class="tb-btn tb-about" title="关于系统" @click="openAbout()">ⓘ</button>
      <button class="tb-btn" title="最小化" @click="api.winMinimize()">─</button>
      <button class="tb-btn" :title="maximized ? '还原' : '最大化'" @click="toggleMax">
        {{ maximized ? '❐' : '▢' }}
      </button>
      <button class="tb-btn tb-close" title="关闭" @click="api.winClose()">✕</button>
    </div>
  </div>
</template>

<script setup>
import { ref, inject, onMounted, onBeforeUnmount } from 'vue'

const api = window.api
const openAbout = inject('openAbout', () => {})
const openGuide = inject('openGuide', () => {})
const maximized = ref(false)
let unsub = null

function toggleMax() {
  api.winMaximize()
}

onMounted(async () => {
  try { maximized.value = await api.winIsMaximized() } catch { /* 首次查询失败按未最大化 */ }
  unsub = api.onWinMaximizeChanged((v) => { maximized.value = v })
})
onBeforeUnmount(() => { if (unsub) unsub() })
</script>

<style scoped>
.title-bar {
  display: flex;
  align-items: stretch;
  height: 34px;
  flex-shrink: 0;
  background: var(--bg1);
  border-bottom: 1px solid var(--border);
  user-select: none;
}
.tb-drag {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  -webkit-app-region: drag;
}
.tb-logo { color: var(--green); font-size: 12px; }
.tb-title { color: var(--text-faint); font-size: 12px; letter-spacing: 0.4px; }
.tb-actions {
  display: flex;
  -webkit-app-region: no-drag;
}
.tb-btn {
  width: 42px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  cursor: default;
  border-radius: 0;
}
.tb-btn:hover { background: var(--bg3); color: var(--text); }
.tb-about { font-size: 13px; }
.tb-close:hover { background: var(--red); color: #fff; }
</style>
<style>
/* 全局：按钮基础样式在此组件里不继承 button.primary 等，单独声明 */
</style>
