<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-mask" @click.self="close">
      <div class="modal hist-modal">
        <div class="hist-head">
          <span class="hist-title">AI 对话历史</span>
          <input v-model="keyword" placeholder="搜索标题或内容..." style="width:220px" />
          <select v-model="serverFilter">
            <option value="">全部服务器</option>
            <option v-for="s in serverNames" :key="s" :value="s">{{ s }}</option>
          </select>
          <div class="grow"></div>
          <button class="ghost" @click="close">✕</button>
        </div>

        <div class="hist-body">
          <!-- 左：会话列表（时间分组） -->
          <div class="hist-list">
            <template v-for="g in groups" :key="g.label">
              <div class="group-label">{{ g.label }}（{{ g.items.length }}）</div>
              <div
                v-for="s in g.items"
                :key="s.id"
                class="ses-item"
                :class="{ on: selected && selected.id === s.id }"
                @click="selected = s"
              >
                <div class="ses-title ellipsis">
                  <span v-if="s.hasDanger" class="danger-badge">危</span>
                  {{ s.title || '（无标题）' }}
                </div>
                <div class="ses-meta">
                  <span class="mono faint">{{ s.serverName }}</span>
                  <span class="faint">{{ fmtTime(s.updatedAt) }}</span>
                  <span class="faint">{{ (s.messages || []).length }} 条</span>
                </div>
              </div>
              <div v-if="!g.items.length" class="faint" style="padding:4px 12px; font-size:12px">无记录</div>
            </template>
            <div v-if="!filtered.length" class="empty-hint" style="padding:30px">
              <div>没有匹配的会话记录</div>
            </div>
          </div>

          <!-- 右：会话详情 -->
          <div class="hist-detail">
            <template v-if="selected">
              <div class="detail-head">
                <div>
                  <div class="detail-title">{{ selected.title }}</div>
                  <div class="faint" style="font-size:11.5px">
                    {{ selected.serverName }} {{ selected.host ? '· ' + selected.host : '' }} ·
                    {{ fmtTime(selected.createdAt) }}
                  </div>
                </div>
                <div style="display:flex; gap:6px">
                  <button class="primary" :disabled="aiRunning" @click="resume">继续此会话</button>
                  <button class="danger" @click="del">删除</button>
                </div>
              </div>
              <div class="detail-msgs selectable">
                <div v-for="(m, i) in selected.messages" :key="i" class="hmsg" :class="m.role">
                  <div class="hmsg-tag">{{ m.role === 'user' ? '牢笼' : 'AI' }}</div>
                  <div class="hmsg-body">
                    <div class="ellipsis-3">{{ m.content || '（工具调用）' }}</div>
                    <div v-for="(t, j) in m.tools || []" :key="j" class="htool mono">
                      {{ toolLabel(t.name) }} <span :class="'st-' + t.status">{{ t.status === 'denied' ? '已拒绝' : t.status === 'error' ? '失败' : '完成' }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </template>
            <div v-else class="empty-hint">
              <div class="big">📜</div>
              <div>选择左侧会话查看详情</div>
              <div class="faint">对话会按服务器与时间自动保存，可随时调取</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useAiStore } from '../stores/ai'
import { useDialogStore } from '../stores/dialog'

const ai = useAiStore()
const dialog = useDialogStore()
const visible = ref(false)
const sessions = ref([])
const keyword = ref('')
const serverFilter = ref('')
const selected = ref(null)

async function open() {
  visible.value = true
  sessions.value = await ai.loadSessions()
  selected.value = null
  keyword.value = ''
  serverFilter.value = ''
}
function close() {
  visible.value = false
}
defineExpose({ open })

const serverNames = computed(() => [...new Set(sessions.value.map((s) => s.serverName))])

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return sessions.value.filter((s) => {
    if (serverFilter.value && s.serverName !== serverFilter.value) return false
    if (!kw) return true
    if ((s.title || '').toLowerCase().includes(kw)) return true
    // 内容匹配：任一消息含关键词
    return (s.messages || []).some((m) => (m.content || '').toLowerCase().includes(kw))
  })
})

// 时间分组：今天 / 昨天 / 7 天内 / 更早
const groups = computed(() => {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayMs = 86400000
  const buckets = [
    { label: '今天', test: (t) => t >= startOfToday },
    { label: '昨天', test: (t) => t >= startOfToday - dayMs && t < startOfToday },
    { label: '7 天内', test: (t) => t >= startOfToday - 7 * dayMs && t < startOfToday - dayMs },
    { label: '更早', test: (t) => t < startOfToday - 7 * dayMs }
  ]
  return buckets.map((b) => ({
    label: b.label,
    items: filtered.value.filter((s) => b.test(s.updatedAt || s.createdAt)).sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))
  }))
})

function resume() {
  if (!selected.value) return
  ai.restoreSession(JSON.parse(JSON.stringify(selected.value)))
  close()
}
async function del() {
  if (!selected.value) return
  const ok = await dialog.askConfirm({
    title: '删除会话记录',
    message: `确定删除「${selected.value.title}」的历史记录？（不可恢复）`
  })
  if (!ok) return
  await ai.deleteSession(selected.value.id)
  sessions.value = await ai.loadSessions()
  selected.value = null
}

function toolLabel(name) {
  return { run_command: '$ 执行命令', read_terminal: '👁 读取终端', sftp_list: '▤ 查目录', list_local: '▤ 本机目录', read_local_file: '📄 读本机文件', write_local_file: '✏ 写本机文件', delete_local: '🗑 删本机', download_server_file: '⬇ 下载到本机', use_skill: '⚡ 技能' }[name] || name
}
function fmtTime(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<style scoped>
.hist-modal { width: 880px; height: 620px; }
.hist-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.hist-title { font-weight: 600; font-size: 14px; }
.hist-body { display: flex; flex: 1; min-height: 0; }

.hist-list {
  width: 300px;
  border-right: 1px solid var(--border);
  overflow-y: auto;
  padding: 8px;
  flex-shrink: 0;
}
.group-label {
  font-size: 11px;
  color: var(--text-faint);
  padding: 8px 6px 4px;
  letter-spacing: 1px;
}
.ses-item {
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  border: 1px solid transparent;
}
.ses-item:hover { background: var(--bg3); }
.ses-item.on { background: var(--bg3); border-color: var(--border-strong); }
.ses-title { font-size: 12.8px; display: flex; align-items: center; gap: 6px; }
.danger-badge {
  font-size: 10px;
  color: var(--red);
  background: var(--red-dim);
  border-radius: 3px;
  padding: 0 4px;
  flex-shrink: 0;
}
.ses-meta { display: flex; gap: 8px; margin-top: 3px; font-size: 11px; }

.hist-detail { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.detail-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.detail-title { font-size: 13.5px; font-weight: 600; margin-bottom: 3px; }
.detail-msgs { flex: 1; overflow-y: auto; padding: 10px 14px; }
.hmsg { margin-bottom: 10px; }
.hmsg-tag {
  display: inline-block;
  font-size: 10px;
  border-radius: 4px;
  padding: 1px 6px;
  margin-bottom: 3px;
  background: var(--bg3);
  color: var(--text-dim);
}
.hmsg.user .hmsg-tag { background: var(--blue-dim); color: var(--blue); }
.hmsg-body { font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.ellipsis-3 {
  display: -webkit-box;
  -webkit-line-clamp: 6;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.htool {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-faint);
}
.htool .st-denied { color: var(--text-faint); }
.htool .st-error { color: var(--red); }
.htool .st-done { color: var(--green); }
</style>
