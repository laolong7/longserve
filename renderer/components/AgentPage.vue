<template>
  <Teleport to="body">
    <div v-if="visible" class="agent-mask" @click.self="close">
      <div class="agent-page">
        <!-- 专属标题头 -->
        <div class="ap-head">
          <span class="ap-logo">📱</span>
          <span class="ap-title">手机控制</span>
          <span class="ap-sub faint">部署 Agent 到服务器，扫码后手机随时操控</span>
          <div class="grow"></div>
          <button class="ghost ap-close" title="关闭" @click="close">✕</button>
        </div>
        <!-- 量身定制的容器：比设置弹窗宽一截，连接地址/按钮不再被挤断 -->
        <AgentPanel class="ap-body" />
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref } from 'vue'
import AgentPanel from './AgentPanel.vue'

const visible = ref(false)

function open() {
  visible.value = true
}
function close() {
  visible.value = false
}

defineExpose({ open })
</script>

<style scoped>
.agent-mask {
  position: fixed;
  inset: 0;
  background: rgba(10, 11, 14, 0.55);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 120; /* 高于设置弹窗（100），独立页面压在最上层 */
}
.agent-page {
  width: min(94vw, 1000px);   /* 专属宽度：连接地址一行放得下 */
  height: min(86vh, 660px);
  background: var(--bg1);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: 0 18px 56px rgba(0, 0, 0, 0.55);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: slideUp 0.22s ease;
}
.ap-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.ap-logo { font-size: 15px; }
.ap-title { font-size: 14px; font-weight: 600; letter-spacing: 0.5px; }
.ap-sub { font-size: 11px; }
.ap-close { padding: 4px 10px; font-size: 12px; }
.ap-body { flex: 1; min-height: 0; }
</style>
