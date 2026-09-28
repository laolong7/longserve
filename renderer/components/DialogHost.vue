<template>
  <Teleport to="body">
    <!-- 确认框（含危险命令样式） -->
    <div v-if="dlg.confirmVisible" class="modal-mask">
      <div class="modal confirm-modal">
        <div class="confirm-head">
          <span class="warn-icon">⚠</span>
          <span>{{ dlg.confirmTitle }}</span>
        </div>
        <div class="confirm-body">
          <div v-if="dlg.confirmMessage" class="msg-text">{{ dlg.confirmMessage }}</div>
          <div v-if="dlg.confirmCommand" class="cmd-box mono selectable">{{ dlg.confirmCommand }}</div>
          <ul v-if="dlg.confirmReasons.length" class="reasons">
            <li v-for="(r, i) in dlg.confirmReasons" :key="i">{{ r }}</li>
          </ul>
        </div>
        <div class="confirm-foot">
          <button @click="dlg.answerConfirm(false)">取消</button>
          <button class="danger" @click="dlg.answerConfirm(true)">确认</button>
        </div>
      </div>
    </div>

    <!-- 输入框 -->
    <div v-if="dlg.promptVisible" class="modal-mask" @click.self="dlg.answerInput(null)">
      <div class="modal prompt-modal">
        <div class="confirm-head plain">
          <span>{{ dlg.promptTitle }}</span>
        </div>
        <div class="confirm-body">
          <input
            ref="promptInputEl"
            v-model="dlg.promptValue"
            class="mono"
            style="width:100%"
            @keydown.enter="dlg.answerInput(dlg.promptValue)"
            @keydown.esc="dlg.answerInput(null)"
          />
        </div>
        <div class="confirm-foot">
          <button @click="dlg.answerInput(null)">取消</button>
          <button class="primary" @click="dlg.answerInput(dlg.promptValue)">确定</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue'
import { useDialogStore } from '../stores/dialog'

const dlg = useDialogStore()
const promptInputEl = ref(null)

// 弹出输入框时自动聚焦全选
watch(() => dlg.promptVisible, (v) => {
  if (v) nextTick(() => { promptInputEl.value?.focus(); promptInputEl.value?.select() })
})
</script>

<style scoped>
.confirm-modal { width: 460px; }
.prompt-modal { width: 400px; }
.confirm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  font-size: 14px;
  border-bottom: 1px solid var(--border);
  color: var(--amber);
}
.confirm-head.plain { color: var(--text); }
.warn-icon { font-size: 16px; }
.confirm-body { padding: 14px 16px; }
.msg-text { font-size: 13px; line-height: 1.6; margin-bottom: 8px; }
.cmd-box {
  background: var(--bg0);
  border: 1px solid rgba(242, 85, 90, 0.35);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  font-size: 13px;
  color: var(--text);
  word-break: break-all;
  max-height: 140px;
  overflow-y: auto;
  white-space: pre-wrap;
}
.reasons {
  margin: 10px 0 0;
  padding-left: 18px;
  color: var(--amber);
  font-size: 12.5px;
  line-height: 1.7;
}
.confirm-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
</style>
