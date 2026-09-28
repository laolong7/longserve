<template>
  <div class="ai-chat">
    <!-- 头部：模型选择 -->
    <div class="ai-head">
      <span class="ai-logo">◆</span>
      <span class="ai-title">AI 副驾</span>
      <select
        class="model-select"
        :value="config.activeAiProviderId || ''"
        @change="onSelectChange"
        title="选择使用的 AI 配置"
      >
        <option value="__add__">＋ 添加模型…</option>
        <option v-for="p in config.aiProviders" :key="p.id" :value="p.id">
          {{ p.name }}
        </option>
      </select>
      <button class="ghost icon-sm" title="本会话文件快照（AI 改动安全网）" @click="showSnapshots">⟲</button>
      <button class="ghost icon-sm" title="运行技能流水线" @click="runPipeline">▶</button>
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

        <!-- 命令模式消息：自然语言直译的纯指令卡片（若干条，逐条/一键执行） -->
        <div v-else-if="m.kind === 'cmd'" class="msg assistant">
          <div class="assistant-tag">{{ m.model || 'AI' }}</div>
          <div class="bubble ai-bubble selectable">
            <div class="cmd-q faint">「{{ m.prompt }}」</div>
            <template v-if="m.cmds && m.cmds.length">
              <div v-for="(c, i) in m.cmds" :key="i" class="cmd-row">
                <span class="cmd-idx mono">{{ i + 1 }}</span>
                <div class="cmd-out mono selectable">{{ c.text }}</div>
                <button v-if="!c.done" class="ghost btn-xs" title="执行这条指令" @click="ai.executeCmd(m, i)">▶</button>
                <span v-else class="faint cmd-ok" title="已输入终端执行">✓</span>
              </div>
              <div class="cmd-foot">
                <button v-if="m.cmds.some((c) => !c.done)" class="primary" @click="ai.executeAllCmds(m)">▶ 全部顺序执行</button>
                <span v-else class="faint" style="font-size:11px">✓ 已全部输入终端执行</span>
                <span class="faint" style="font-size:11px">危险指令会先弹窗确认</span>
              </div>
            </template>
            <div v-else-if="m.status === 'done'" class="faint" style="font-size:12px">{{ m.content || '（没有给出指令）' }}</div>
            <span v-if="m.status === 'streaming'" class="caret"></span>
          </div>
        </div>

        <!-- AI 消息 -->
        <div v-else class="msg assistant">
          <div class="assistant-tag" :title="m.model || 'AI'">{{ m.model || 'AI' }}</div>
          <div
            class="bubble ai-bubble selectable"
            :class="{ loading: m.status === 'streaming' && !m.content && !m.reasoning && !m.toolCalls.length }"
          >
            <!-- 思考过程：流式展开，完成后默认收起，可点开回看 -->
            <div v-if="m.reasoning" class="reas" :class="{ open: reasOpen(m) }">
              <div class="reas-head" @click="toggleReas(m)">
                <span class="reas-icon">✦</span>
                <span class="reas-title">思考过程</span>
                <span v-if="m.status === 'streaming' && !m.content" class="reas-live">流式中</span>
                <span class="tool-arrow">{{ reasOpen(m) ? '▾' : '▸' }}</span>
              </div>
              <div v-show="reasOpen(m)" class="reas-body selectable">{{ m.reasoning }}</div>
            </div>

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

            <!-- 等待首字：光带贯穿整个气泡高度巡回 + 模型名 -->
            <div v-if="m.status === 'streaming' && !m.content && !m.reasoning && !m.toolCalls.length" class="thinking">
              <div class="th-sweep"></div>
              <div class="th-caption">
                <span class="th-dot"></span><span class="th-dot"></span><span class="th-dot"></span>
                <span class="th-text">{{ m.model || 'AI' }} 思考中…</span>
              </div>
            </div>
          </div>
        </div>
      </template>

      <div v-if="ai.lastError" class="ai-error">{{ ai.lastError }}</div>
    </div>

    <!-- 输入区 -->
    <div class="ai-input-wrap">
      <div class="mode-row">
        <button
          class="mode-pill"
          :class="{ on: !ai.cmdMode }"
          title="副驾模式：正常对话，AI 自己动手操作（执行命令、读写文件）"
          @click="ai.cmdMode = false"
        >◆ 副驾模式</button>
        <button
          class="mode-pill"
          :class="{ on: ai.cmdMode }"
          title="命令模式：输入自然语言，AI 直译成若干条纯指令（不走工具、逐条或一键执行）"
          @click="ai.cmdMode = true"
        >⚡ 命令模式</button>
        <span class="faint" style="font-size:10.5px">{{ ai.cmdMode ? '需求直译为若干条纯指令' : '' }}</span>
      </div>
      <textarea
        ref="inputEl"
        v-model="draft"
        rows="2"
        :placeholder="ai.cmdMode ? '如：清理 nginx 日志并重载（会拆成多条纯指令）' : '问问题，或指挥我操作服务器（Enter 发送 / Shift+Enter 换行）'"
        @keydown.enter.exact.prevent="send(draft)"
      ></textarea>
      <button v-if="ai.running" class="stop-btn" @click="ai.abort()" title="停止">■ 停止</button>
      <button v-else class="primary send-btn" :disabled="!draft.trim()" @click="send(draft)">{{ ai.cmdMode ? '转指令' : '发送' }}</button>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, nextTick, watch } from 'vue'
import { useConfigStore } from '../stores/config'
import { useAiStore } from '../stores/ai'
import { useDialogStore } from '../stores/dialog'

const emit = defineEmits(['open-settings', 'open-history'])
const config = useConfigStore()
const ai = useAiStore()
const dialog = useDialogStore()

const draft = ref('')
const msgsEl = ref(null)
const inputEl = ref(null)

// 模型下拉：顶部固定"添加模型"入口，选择它直接打开设置→AI 配置
function onSelectChange(e) {
  if (e.target.value === '__add__') {
    e.target.value = config.activeAiProviderId || '' // 回弹到当前配置，不改变选择
    emit('open-settings')
    return
  }
  config.activeAiProviderId = e.target.value
  config.save()
}

// ---------- 思考过程折叠 ----------
// 流式中默认展开；完成后没手动动过就收起。用户点击后以手动状态为准
const reasManual = reactive({})
function reasOpen(m) {
  return reasManual[m.id] ?? (m.status === 'streaming')
}
function toggleReas(m) {
  reasManual[m.id] = !reasOpen(m)
}

const QUICK = [
  '看看这台服务器的基本情况',
  '检查磁盘和内存占用',
  'nginx 状态怎么样',
  '最近有哪些登录记录'
]

const TOOL_META = {
  run_command: { icon: '$', label: '执行命令' },
  read_terminal: { icon: '👁', label: '读取终端' },
  sftp_list: { icon: '▤', label: '查看目录' },
  list_local: { icon: '▣', label: '查看本机目录' },
  read_local_file: { icon: '📄', label: '读取本机文件' },
  write_local_file: { icon: '✏', label: '写入本机文件' },
  delete_local: { icon: '🗑', label: '删除本机文件' },
  download_server_file: { icon: '⬇', label: '下载服务器文件' },
  use_skill: { icon: '⚡', label: '加载技能' },
  backup_file: { icon: '⟲', label: '备份文件（安全网）' },
  restore_file: { icon: '⏪', label: '还原文件' },
  list_snapshots: { icon: '🗒', label: '查看快照' }
}

// ---------- 快照 / 流水线入口 ----------
async function showSnapshots() {
  if (!ai.snapshots.length) {
    dialog.showToast('本会话还没有文件快照（AI 修改文件前会自动备份）')
    return
  }
  const choice = await dialog.askChoice({
    title: '本会话文件快照',
    message: 'AI 改动前自动备份的原文件，可一键还原。',
    options: [
      ...ai.snapshots.map((s, i) => ({
        value: String(i),
        label: `[${s.server}] ${s.path}（${new Date(s.time).toLocaleTimeString()} 备份）`
      })),
      { value: '__none__', label: '— 关闭，不还原 —' }
    ]
  })
  if (choice == null || choice === '__none__') return
  await ai.restoreSnapshot(ai.snapshots[Number(choice)])
}
async function runPipeline() {
  const config = useConfigStore()
  if (!config.pipelines.length) {
    dialog.showToast('还没有流水线，到 设置→流水线 里把技能串起来')
    return
  }
  const choice = await dialog.askChoice({
    title: '运行哪条流水线？',
    message: '按步骤依次执行技能，检查点处会暂停等你确认。',
    options: config.pipelines.map((p) => ({ value: p.id, label: `${p.name}（${p.steps.length} 步）` }))
  })
  if (!choice) return
  const pl = config.pipelines.find((p) => p.id === choice)
  if (pl) await ai.runPipeline(pl)
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

// 自动滚底（仅当用户本就接近底部）；思考块展开时同步滚其内部到底
watch(() => ai.messages.length, scrollBottom)
watch(ai.messages, scrollBottom, { deep: true })
function scrollBottom() {
  nextTick(() => {
    const el = msgsEl.value
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) el.scrollTop = el.scrollHeight
    // 流式思考块跟随滚动（仅当该块处于展开态）
    el.querySelectorAll('.reas.open .reas-body').forEach((b) => { b.scrollTop = b.scrollHeight })
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
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
  font-family: var(--font-mono);
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
/* 命令模式消息卡片（若干条纯指令） */
.cmd-q { font-size: 11.5px; margin-bottom: 6px; }
.cmd-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.cmd-idx { width: 14px; text-align: right; flex-shrink: 0; font-size: 10.5px; color: var(--text-faint); }
.cmd-out {
  flex: 1;
  min-width: 0;
  background: var(--bg0);
  border: 1px solid var(--border);
  border-left: 3px solid var(--violet);
  border-radius: 4px;
  padding: 5px 9px;
  font-size: 12px;
  color: var(--green);
  white-space: pre-wrap;
  word-break: break-all;
}
.cmd-row .btn-xs { flex-shrink: 0; }
.cmd-ok { color: var(--green); width: 20px; text-align: center; flex-shrink: 0; font-size: 11px; }
.cmd-foot { display: flex; align-items: center; gap: 8px; margin-top: 7px; }
.cmd-foot .primary { font-size: 11.5px; padding: 3px 10px; }
/* 命令模式开关 */
.mode-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.mode-pill {
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 12px;
  background: transparent;
  color: var(--text-faint);
  border: 1px dashed var(--border-strong);
}
.mode-pill.on {
  color: var(--violet);
  border: 1px solid rgba(167, 139, 250, 0.5);
  background: var(--violet-dim);
}
/* 思考动画：光带贯穿整个气泡高度上下巡回（新颖+明显+简洁） */
.ai-bubble.loading {
  position: relative;
  min-height: 76px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  overflow: hidden;
}
.thinking {
  position: absolute;
  inset: 0;
  overflow: hidden;
  border-radius: inherit;
  display: flex;
  align-items: center;
  pointer-events: none;
}
.th-sweep {
  position: absolute;
  left: 0;
  right: 0;
  top: -60%;
  height: 60%;
  background: linear-gradient(
    180deg,
    transparent 0%,
    rgba(167, 139, 250, 0.10) 30%,
    rgba(167, 139, 250, 0.26) 50%,
    rgba(167, 139, 250, 0.10) 70%,
    transparent 100%
  );
  animation: th-sweep 1.5s cubic-bezier(0.45, 0, 0.55, 1) infinite;
}
@keyframes th-sweep {
  0% { top: -60%; }
  100% { top: 100%; }
}
.th-caption {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  padding-left: 4px;
}
.th-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--violet);
  animation: th-bounce 1.2s ease-in-out infinite;
}
.th-dot:nth-child(2) { animation-delay: 0.15s; opacity: 0.75; }
.th-dot:nth-child(3) { animation-delay: 0.3s; opacity: 0.5; }
.th-text {
  color: var(--text-faint);
  font-size: 11px;
  margin-left: 3px;
  animation: th-fade 1.6s ease-in-out infinite;
  font-family: var(--font-mono);
}
@keyframes th-bounce {
  0%, 60%, 100% { transform: translateY(0); }
  30% { transform: translateY(-3px); }
}
@keyframes th-fade {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}

/* 思考过程：可折叠灰字块，流式时内部滚动 */
.reas {
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg0);
  margin-bottom: 7px;
  overflow: hidden;
}
.reas-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text-dim);
  cursor: pointer;
  user-select: none;
}
.reas-head:hover { color: var(--text); }
.reas-icon { color: var(--violet); font-size: 10px; }
.reas-title { font-weight: 600; }
.reas-live {
  font-size: 10px;
  color: var(--violet);
  animation: th-fade 1.6s ease-in-out infinite;
}
.reas-body {
  max-height: 150px;
  overflow-y: auto;
  padding: 6px 9px;
  font-size: 11.3px;
  line-height: 1.6;
  color: var(--text-faint);
  white-space: pre-wrap;
  word-break: break-word;
  border-top: 1px solid var(--border);
}

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
