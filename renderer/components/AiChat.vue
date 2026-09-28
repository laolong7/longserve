<template>
  <div class="ai-chat">
    <!-- 头部：模型选择 -->
    <div class="ai-head">
      <span class="ai-logo">◆</span>
      <span class="ai-title">AI 副驾</span>
      <select
        class="model-select"
        :value="config.activeAiProviderId || ''"
        @change="config.activeAiProviderId = $event.target.value; config.save()"
      >
        <option value="" disabled>选择 AI 配置</option>
        <option v-for="p in config.aiProviders" :key="p.id" :value="p.id">
          {{ p.name }}{{ p.model ? ' · ' + p.model : '' }}
        </option>
      </select>
      <button class="ghost icon-sm" title="AI 设置" @click="emit('open-settings')">⚙</button>
      <button class="ghost icon-sm" title="历史会话记录" @click="emit('open-history')">📜</button>
      <button class="ghost icon-sm" title="清空对话" :disabled="ai.running" @click="ai.clear()">🗑</button>
    </div>

    <!-- 消息流 -->
    <div class="ai-msgs" ref="msgsEl">
      <div v-if="!ai.messages.length" class="empty-hint" style="padding: 30px 20px">
        <div class="big" style="color: var(--violet)">◆</div>
        <div>连接服务器后，指挥我在终端里干活</div>
        <div class="quick-list">
          <div class="quick-item" v-for="q in QUICK" :key="q" @click="send(q)">{{ q }}</div>
        </div>
      </div>

      <template v-for="m in ai.messages" :key="m.id">
        <!-- 用户消息 -->
        <div v-if="m.role === 'user'" class="msg user selectable">
          <div class="bubble user-bubble">{{ m.content }}</div>
        </div>

        <!-- AI 消息 -->
        <div v-else class="msg assistant">
          <div class="assistant-tag">AI</div>
          <div class="bubble ai-bubble selectable">
            <div v-if="m.content" v-html="mdRender(m.content)"></div>
            <span v-if="m.status === 'streaming' && !m.toolCalls.length" class="caret"></span>

            <!-- 工具调用卡片 -->
            <div
              v-for="(tc, i) in m.toolCalls"
              :key="i"
              class="tool-card"
              :class="'st-' + tc.status"
            >
              <div class="tool-head" @click="tc.__open = !tc.__open">
                <span class="tool-icon mono">{{ TOOL_META[tc.name]?.icon || '⚙' }}</span>
                <span class="tool-name">{{ TOOL_META[tc.name]?.label || tc.name }}</span>
                <span class="tool-status">{{ statusText(tc.status) }}</span>
                <span class="tool-arrow">{{ tc.__open ? '▾' : '▸' }}</span>
              </div>
              <div v-if="tc.__open !== false && (tc.name === 'run_command' || tc.__open)" class="tool-body">
                <div v-if="parsedCmd(tc)" class="tool-cmd mono selectable">{{ parsedCmd(tc) }}</div>
                <div v-if="tc.result" class="tool-result selectable">{{ tc.result }}</div>
              </div>
            </div>

            <div v-if="ai.running && m.status === 'streaming'" class="thinking">…</div>
          </div>
        </div>
      </template>

      <div v-if="ai.lastError" class="ai-error">{{ ai.lastError }}</div>
    </div>

    <!-- 输入区 -->
    <div class="ai-input-wrap">
      <textarea
        ref="inputEl"
        v-model="draft"
        rows="2"
        placeholder="问问题，或指挥我操作服务器（Enter 发送 / Shift+Enter 换行）"
        @keydown.enter.exact.prevent="send(draft)"
      ></textarea>
      <button v-if="ai.running" class="stop-btn" @click="ai.abort()" title="停止">■ 停止</button>
      <button v-else class="primary send-btn" :disabled="!draft.trim()" @click="send(draft)">发送</button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, watch } from 'vue'
import { useConfigStore } from '../stores/config'
import { useAiStore } from '../stores/ai'

const emit = defineEmits(['open-settings', 'open-history'])
const config = useConfigStore()
const ai = useAiStore()

const draft = ref('')
const msgsEl = ref(null)
const inputEl = ref(null)

const QUICK = [
  '看看这台服务器的基本情况',
  '检查磁盘和内存占用',
  'nginx 状态怎么样',
  '最近有哪些登录记录'
]

const TOOL_META = {
  run_command: { icon: '$', label: '执行命令' },
  read_terminal: { icon: '👁', label: '读取终端' },
  sftp_list: { icon: '▤', label: '查看目录' }
}

function statusText(st) {
  return { pending: '等待', running: '执行中', done: '完成', denied: '已拒绝', error: '失败' }[st] || ''
}

function parsedCmd(tc) {
  try { return JSON.parse(tc.argsJson || '{}').command || '' } catch { return '' }
}

const lastAssistant = computed(() => {
  for (let i = ai.messages.length - 1; i >= 0; i--) {
    if (ai.messages[i].role === 'assistant') return ai.messages[i]
  }
  return null
})

async function send(text) {
  if (!text.trim() || ai.running) return
  draft.value = ''
  await ai.send(text)
}

// 自动滚底（仅当用户本就接近底部）
watch(() => ai.messages.length, scrollBottom)
watch(ai.messages, scrollBottom, { deep: true })
function scrollBottom() {
  nextTick(() => {
    const el = msgsEl.value
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) el.scrollTop = el.scrollHeight
  })
}

// ---------- 轻量 markdown 渲染（代码块/行内码/加粗/标题/列表） ----------
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function mdRender(text) {
  if (!text) return ''
  const blocks = []
  let t = text.replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, (_m, _lang, code) => {
    blocks.push(`<pre class="md-pre"><code>${esc(code)}</code></pre>`)
    return `\u0000${blocks.length - 1}\u0000`
  })
  t = esc(t)
  t = t.replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>')
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  t = t.replace(/^#{1,4} (.*)$/gm, '<div class="md-h">$1</div>')
  t = t.replace(/^\s*[-*] (.*)$/gm, '<div class="md-li">• $1</div>')
  t = t.replace(/\n/g, '<br>')
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[+i])
  return t
}
</script>

<style scoped>
.ai-chat {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.ai-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.ai-logo { color: var(--violet); font-size: 14px; }
.ai-title { font-size: 13px; font-weight: 600; margin-right: 2px; }
.model-select {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  padding: 4px 6px;
  background: var(--bg2);
}
.icon-sm { padding: 3px 7px; font-size: 13px; }

.ai-msgs { flex: 1; overflow-y: auto; padding: 12px; }

.msg { margin-bottom: 14px; }
.msg.user { display: flex; justify-content: flex-end; }
.bubble {
  max-width: 92%;
  border-radius: 8px;
  padding: 8px 11px;
  font-size: 12.8px;
  line-height: 1.65;
  word-break: break-word;
}
.user-bubble {
  background: var(--blue-dim);
  border: 1px solid rgba(110, 168, 254, 0.3);
  white-space: pre-wrap;
}
.assistant-tag {
  display: inline-block;
  font-size: 10px;
  color: var(--violet);
  background: var(--violet-dim);
  border-radius: 4px;
  padding: 1px 6px;
  margin-bottom: 5px;
}
.ai-bubble {
  background: var(--bg2);
  border: 1px solid var(--border);
}
.ai-bubble :deep(.md-pre) {
  background: var(--bg0);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 8px 10px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 11.8px;
  margin: 6px 0;
}
.ai-bubble :deep(.md-code) {
  font-family: var(--font-mono);
  font-size: 11.8px;
  background: var(--bg0);
  border-radius: 3px;
  padding: 1px 5px;
}
.ai-bubble :deep(.md-h) { font-weight: 600; margin: 4px 0 2px; }
.ai-bubble :deep(.md-li) { padding-left: 8px; }
.caret {
  display: inline-block;
  width: 7px;
  height: 14px;
  background: var(--violet);
  vertical-align: text-bottom;
  animation: blink 0.9s infinite;
  margin-left: 2px;
}
@keyframes blink { 50% { opacity: 0; } }
.thinking { color: var(--text-faint); font-size: 11.5px; margin-top: 6px; }

/* 工具卡片 */
.tool-card {
  border: 1px solid var(--border);
  border-left: 3px solid var(--text-faint);
  border-radius: 5px;
  margin-top: 8px;
  background: var(--bg1);
  overflow: hidden;
}
.tool-card.st-running { border-left-color: var(--amber); }
.tool-card.st-done { border-left-color: var(--green); }
.tool-card.st-denied { border-left-color: var(--text-faint); }
.tool-card.st-error { border-left-color: var(--red); }
.tool-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 9px;
  cursor: pointer;
  font-size: 12px;
}
.tool-icon { color: var(--text-dim); }
.tool-name { font-weight: 600; }
.tool-status { flex: 1; text-align: right; font-size: 11px; color: var(--text-faint); }
.st-running .tool-status { color: var(--amber); }
.st-done .tool-status { color: var(--green); }
.st-denied .tool-status { color: var(--text-faint); }
.st-error .tool-status { color: var(--red); }
.tool-arrow { font-size: 10px; color: var(--text-faint); }
.tool-body { padding: 0 9px 8px; }
.tool-cmd {
  background: var(--bg0);
  border-radius: 4px;
  padding: 6px 9px;
  font-size: 11.8px;
  color: var(--green);
  white-space: pre-wrap;
  word-break: break-all;
}
.tool-result {
  margin-top: 5px;
  font-size: 11.5px;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 180px;
  overflow-y: auto;
}

.ai-error {
  color: var(--red);
  font-size: 12px;
  padding: 6px 10px;
  border-top: 1px solid var(--border);
}

/* 快捷指令 */
.quick-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  max-width: 240px;
  margin-top: 8px;
}
.quick-item {
  padding: 7px 12px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
  text-align: center;
  transition: all 0.12s;
}
.quick-item:hover { border-color: var(--violet); color: var(--violet); }

/* 输入区 */
.ai-input-wrap {
  position: relative;
  padding: 10px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.ai-input-wrap textarea {
  width: 100%;
  resize: none;
  font-size: 12.8px;
  line-height: 1.5;
  background: var(--bg0);
  padding-right: 64px;
}
.send-btn, .stop-btn {
  position: absolute;
  right: 18px;
  bottom: 18px;
  padding: 4px 12px;
  font-size: 12px;
}
.stop-btn {
  background: var(--red-dim);
  border-color: rgba(242, 85, 90, 0.4);
  color: var(--red);
}
</style>
