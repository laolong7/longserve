<template>
  <div class="set-body">
    <!-- 左侧：部署记录 -->
    <div class="side-list">
      <button class="primary" style="width:100%" @click="startNew">＋ 部署到服务器</button>
      <div class="side-items">
        <div
          v-for="d in config.agentDeployments"
          :key="d.id"
          class="side-item"
          :class="{ on: currentId === d.id }"
          @click="select(d)"
        >
          <span class="ellipsis">{{ d.instanceName }}</span>
          <span class="faint mono" style="font-size:10px">{{ d.host }}:{{ d.port }}</span>
        </div>
      </div>
      <div class="faint" style="font-size:10.5px; line-height:1.6">
        部署后手机扫码即可远程操控服务器。Agent 独立端口运行，不影响服务器上已有服务。
      </div>
    </div>

    <!-- 右侧 -->
    <div class="form-panel">
      <!-- ===== 新部署表单 ===== -->
      <template v-if="mode === 'new'">
        <div class="form-row">
          <label>目标服务器（需先在主界面连接该服务器）</label>
          <select v-model="form.instanceId">
            <option value="" disabled>选择服务器实例…</option>
            <option v-for="inst in config.instances" :key="inst.id" :value="inst.id">
              {{ inst.name }}（{{ inst.host }}）{{ connState(inst.id) }}
            </option>
          </select>
          <div v-if="form.instanceId && !connOf(form.instanceId)" class="key-warn" style="margin-top:6px">
            该服务器尚未连接，请先到主界面连接后再部署
          </div>
        </div>
        <div class="form-row">
          <label>使用的 AI 配置（Agent 在服务器上直接调用它，密钥会写入服务器配置文件）</label>
          <select v-model="form.aiProviderId">
            <option value="" disabled>选择 AI 配置…</option>
            <option v-for="p in config.aiProviders" :key="p.id" :value="p.id">
              {{ p.name }}（{{ p.model || '未设模型' }}）
            </option>
          </select>
        </div>
        <div class="form-2col">
          <div class="form-row">
            <label>Agent 端口（独立监听，不占用现有服务）</label>
            <input v-model="form.port" class="mono" placeholder="37777" />
          </div>
          <div class="form-row">
            <label>&nbsp;</label>
            <div class="faint" style="font-size:11px; line-height:1.6; padding-top:4px">
              云服务器请在控制台安全组放行该端口，否则手机连不上
            </div>
          </div>
        </div>

        <!-- 部署进度：统一进度条 + 科幻动画 -->
        <div v-if="deploying || progress.percent >= 100" class="deploy-progress panel">
          <div class="dp-head">
            <span class="dp-phase">{{ progress.msg }}</span>
            <span class="mono dp-pct">{{ progress.percent }}%</span>
          </div>
          <div class="dp-bar">
            <div class="dp-fill" :style="{ width: progress.percent + '%' }"></div>
            <div class="dp-scan"></div>
          </div>
          <div class="dp-steps">
            <span
              v-for="s in PHASES"
              :key="s.id"
              class="dp-step"
              :class="{ done: progress.percent > s.at, active: currentPhase === s.id }"
            >{{ s.label }}</span>
          </div>
        </div>
        <div v-if="deployError" class="key-warn">
          {{ deployError }}
          <div v-if="/断开|ECONN|已关闭|上传失败/.test(deployError)" class="key-warn-sub">
            SSH 连接可能已断开或命令通道被占满，请回主界面重新连接该服务器后再点部署。
          </div>
        </div>
        <!-- AI 失败诊断：部署失败自动分析 journalctl 日志，给出根因与修法 -->
        <div v-if="diagLoading" class="ai-diag">
          <span class="ai-diag-title">🔍 AI 诊断中…</span>
          <span class="faint" style="font-size:11px">正在分析部署日志</span>
        </div>
        <div v-else-if="diag" class="ai-diag">
          <div class="ai-diag-title">
            🔍 AI 诊断<span v-if="diag.confidence === 'high'">（把握高）</span><span v-else-if="diag.confidence === 'medium'">（中等把握）</span><span v-else>（把握低，日志可能不足）</span>
          </div>
          <div v-if="diag.rootCause" class="ai-diag-row"><b>根因：</b>{{ diag.rootCause }}</div>
          <div v-if="diag.fix" class="ai-diag-row ai-diag-fix"><b>怎么修：</b><br>{{ diag.fix }}</div>
        </div>
        <div v-else-if="diagError" class="key-warn" style="font-size:11.5px">
          AI 诊断不可用：{{ diagError }}（不影响上方错误信息）
        </div>

        <div class="form-actions">
          <div class="grow"></div>
          <button class="primary" :disabled="deploying || !canDeploy" @click="deploy">
            {{ deploying ? '部署中…' : '开始部署' }}
          </button>
        </div>
      </template>

      <!-- ===== 已部署详情 ===== -->
      <template v-else-if="current">
        <!-- 详情子页签：连接 / 指令记录 / 聊天记录 -->
        <div class="sub-tabs">
          <div class="sub-tab" :class="{ on: detailTab === 'link' }" @click="detailTab = 'link'">连接</div>
          <div class="sub-tab" :class="{ on: detailTab === 'exec' }" @click="switchDetail('exec')">指令记录</div>
          <div class="sub-tab" :class="{ on: detailTab === 'chat' }" @click="switchDetail('chat')">聊天记录</div>
          <div class="grow"></div>
          <template v-if="detailTab !== 'link'">
            <span class="faint" style="font-size:10.5px">{{ recordsTimeText }}</span>
            <button class="ghost" style="margin-left:8px; font-size:11px; padding:3px 10px" :disabled="recordsLoading" @click="loadRecords">
              {{ recordsLoading ? '读取中…' : '↻ 刷新' }}
            </button>
          </template>
        </div>

        <!-- ---- 连接 ---- -->
        <template v-if="detailTab === 'link'">
          <div class="qr-wrap">
            <img v-if="qrDataUrl" :src="qrDataUrl" class="qr" alt="扫码绑定" />
            <div class="qr-hint">手机浏览器扫码 → 自动绑定</div>
          </div>
          <div class="form-row">
            <label>连接地址（含绑定密钥，请勿泄露）</label>
            <div class="link-row">
              <span class="mono link-text ellipsis selectable" :title="link">{{ link }}</span>
              <button class="link-copy" @click="copyLink">复制</button>
            </div>
          </div>
          <div class="form-2col">
            <div class="form-row">
              <label>服务器</label>
              <div class="ellipsis">{{ current.instanceName }}（<span class="mono">{{ current.host }}</span>）</div>
            </div>
            <div class="form-row">
              <label>端口</label>
              <div class="mono">{{ current.port }}</div>
            </div>
          </div>
          <div class="form-2col">
            <div class="form-row">
              <label>Agent 状态（需连接该服务器后查看）</label>
              <div>
                <span v-if="statusText" class="mono">{{ statusText }}</span>
                <button class="ghost" style="margin-left:8px" @click="refreshStatus" :disabled="checking">{{ checking ? '检测中…' : '刷新' }}</button>
              </div>
            </div>
            <div class="form-row">
              <label>部署时间</label>
              <div>{{ new Date(current.deployedAt).toLocaleString('zh-CN') }}</div>
            </div>
          </div>
          <div class="faint" style="margin-bottom:14px; font-size:11.5px; line-height:1.7">
            换绑/解绑手机：点「重新生成密钥」，旧二维码立即作废，全部手机解绑。<br>
            卸载会停止并删除服务器上的 Agent 与其数据（不影响其他服务）。
          </div>
          <div class="form-actions">
            <button class="danger" @click="undeploy" :disabled="undeploying">{{ undeploying ? '卸载中…' : '卸载' }}</button>
            <button @click="redeploy" title="原地重部署最新版：保留密钥，手机不用重新扫码">更新 Agent</button>
            <div class="grow"></div>
            <button class="regen-btn" @click="regenToken" :disabled="regening">{{ regening ? '生成中…' : '重新生成密钥' }}</button>
          </div>
        </template>

        <!-- ---- 指令记录（手机端磁盘存储 audit.jsonl） ---- -->
        <template v-else-if="detailTab === 'exec'">
          <div v-if="recordsError" class="key-warn">{{ recordsError }}</div>
          <div v-else-if="recordsLoading" class="empty-hint rec-empty"><div>正在读取服务器磁盘记录…</div></div>
          <div v-else-if="!execRecords.length" class="empty-hint rec-empty">
            <div class="big">❯</div>
            <div>暂无指令记录</div>
            <div class="faint">手机端执行过的指令都会记录在服务器磁盘上</div>
          </div>
          <div v-else class="rec-list">
            <div v-for="(r, i) in execRecords" :key="i" class="rec" :class="{ danger: r.danger, denied: r.approved === false }">
              <div class="rec-top">
                <span class="src" :class="r.source === 'ai' ? 'ai' : 'manual'">{{ r.source === 'ai' ? '✦ AI' : '❯ 手动' }}</span>
                <span v-if="r.danger" class="flag">{{ r.approved === false ? '已拒绝' : r.approved === true ? '已批准·危险' : r.note === '等待确认' ? '待确认' : '危险' }}</span>
                <span class="time mono">{{ recTime(r.time) }}</span>
              </div>
              <div class="rec-cmd mono">$ {{ r.command }}</div>
              <div v-if="r.note && r.note !== '等待确认'" class="rec-note">{{ r.note }}</div>
              <div v-if="r.output" class="rec-out mono">{{ r.output }}</div>
            </div>
          </div>
        </template>

        <!-- ---- 聊天记录（手机端磁盘存储 chat.json） ---- -->
        <template v-else>
          <div v-if="recordsError" class="key-warn">{{ recordsError }}</div>
          <div v-else-if="recordsLoading" class="empty-hint rec-empty"><div>正在读取服务器磁盘记录…</div></div>
          <div v-else-if="!chatRecords.length" class="empty-hint rec-empty">
            <div class="big">✦</div>
            <div>暂无聊天记录</div>
            <div class="faint">手机端与 AI 的对话都会保存在服务器磁盘上</div>
          </div>
          <div v-else class="rec-list">
            <template v-for="(m, i) in chatRecords" :key="i">
              <div v-if="m.role === 'user'" class="chat-row user">
                <div class="chat-role">牢笼</div>
                <div class="chat-bubble user-bubble">{{ m.content }}</div>
              </div>
              <div v-else-if="m.role === 'assistant' && (m.content || (m.tool_calls && m.tool_calls.length))" class="chat-row ai">
                <div class="chat-role">✦ AI</div>
                <div v-if="m.content" class="chat-bubble ai-bubble">{{ m.content }}</div>
                <div v-for="tc in (m.tool_calls || [])" :key="tc.id" class="chat-tool mono">
                  ▸ {{ (tc.function && tc.function.name) || 'tool' }} {{ toolBrief(tc) }}
                </div>
              </div>
            </template>
          </div>
        </template>
      </template>

      <div v-else class="empty-hint">
        <div class="big">📱</div>
        <div>部署 Agent 到服务器，用手机随时操控</div>
        <div class="faint">部署完成后生成二维码，手机扫码即用</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, inject, onUnmounted } from 'vue'
import QRCode from 'qrcode'
import { useConfigStore } from '../stores/config'
import { useTerminalStore } from '../stores/terminals'
import { useDialogStore } from '../stores/dialog'

const config = useConfigStore()
const terminals = useTerminalStore()
const dialog = useDialogStore()

const mode = ref('empty') // 'new' | 'detail' | 'empty'
const currentId = ref(null)
const form = ref({ instanceId: '', aiProviderId: '', port: 37777 })
const deploying = ref(false)
const deployError = ref('')
const diagLoading = ref(false)
const diag = ref(null) // { rootCause, fix, confidence }
const diagError = ref('')
const progress = reactive({ phase: '', percent: 0, msg: '' })
const qrDataUrl = ref('')
const checking = ref(false)
const statusText = ref('')
const regening = ref(false)
const undeploying = ref(false)
let stepUnsub = null

// 详情子页签 + 磁盘记录（手机端指令/聊天记录，SSH 直读服务器磁盘）
const detailTab = ref('link') // 'link' | 'exec' | 'chat'
const records = ref({ audit: [], chat: [] })
const recordsLoading = ref(false)
const recordsError = ref('')
const recordsLoadedAt = ref(0)
const execRecords = computed(() => records.value.audit.slice().reverse()) // 新的在前
const chatRecords = computed(() => (records.value.chat || []).filter((m) => m.role === 'user' || m.role === 'assistant'))
const recordsTimeText = computed(() =>
  recordsLoadedAt.value ? '磁盘记录 · ' + new Date(recordsLoadedAt.value).toLocaleTimeString('zh-CN') : '磁盘记录'
)

function recTime(t) {
  if (!t) return ''
  return new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// AI 工具调用简报（聊天记录里只留一行摘要）
function toolBrief(tc) {
  try {
    const args = JSON.parse((tc.function && tc.function.arguments) || '{}')
    const s = args.command || args.path || args.name || ''
    return s ? String(s).slice(0, 60) : ''
  } catch {
    return ''
  }
}

function switchDetail(tabName) {
  detailTab.value = tabName
  if (!recordsLoadedAt.value && !recordsLoading.value) loadRecords()
}

// 手机端记录：走 SSH 读 /opt/longserve-agent/data/ 下的 audit.jsonl / chat.json
async function loadRecords() {
  const conn = connOf(current.value.instanceId)
  if (!conn) {
    recordsError.value = '请先在主界面连接该服务器，再查看磁盘记录'
    return
  }
  recordsLoading.value = true
  recordsError.value = ''
  try {
    const r = await window.api.agentRecords(conn.id)
    if (r.ok) {
      records.value = { audit: r.audit || [], chat: r.chat || [] }
      recordsLoadedAt.value = Date.now()
    } else {
      recordsError.value = '读取失败：' + (r.error || '未知错误')
    }
  } catch (e) {
    recordsError.value = '读取失败：' + (e.message || String(e))
  } finally {
    recordsLoading.value = false
  }
}

// 部署阶段里程碑（与主进程 agent-deployer 的 percent 对齐）
const PHASES = [
  { id: 'check', label: '检查', at: 6 },
  { id: 'config', label: '配置', at: 15 },
  { id: 'upload', label: '上传', at: 86 },
  { id: 'service', label: '启动', at: 94 },
  { id: 'health', label: '体检', at: 100 }
]
const currentPhase = computed(() => {
  let cur = ''
  for (const s of PHASES) if (progress.percent >= s.at - 8) cur = s.id
  return cur
})

const current = computed(() => config.agentDeployments.find((d) => d.id === currentId.value) || null)
const link = computed(() => (current.value ? `http://${current.value.host}:${current.value.port}/?token=${current.value.token}` : ''))

const canDeploy = computed(() => {
  const f = form.value
  return f.instanceId && f.aiProviderId && connOf(f.instanceId) && Number(f.port) > 0
})

function connOf(instanceId) {
  const inst = config.instances.find((i) => i.id === instanceId)
  if (!inst) return null
  return (terminals.tabs || []).find((t) => t.instance && t.instance.id === instanceId && t.status === 'connected') || null
}
function connState(instanceId) {
  return connOf(instanceId) ? ' ✓ 已连接' : ''
}

function startNew() {
  mode.value = 'new'
  currentId.value = null
  deployError.value = ''
  diag.value = null
  diagError.value = ''
  diagLoading.value = false
  progress.phase = ''
  progress.percent = 0
  progress.msg = ''
  form.value = { instanceId: '', aiProviderId: '', port: 37777 }
}

// 部署失败后的 AI 诊断：用部署时所选的 AI 配置分析错误（含 journalctl 日志）
async function runDiagnose(provider, errorText) {
  diag.value = null
  diagError.value = ''
  diagLoading.value = true
  try {
    const r = await window.api.agentDiagnose(JSON.parse(JSON.stringify(provider)), errorText)
    if (r.ok) diag.value = r.diag
    else diagError.value = r.error
  } catch (e) {
    diagError.value = e.message || String(e)
  } finally {
    diagLoading.value = false
  }
}

async function select(d) {
  mode.value = 'detail'
  currentId.value = d.id
  detailTab.value = 'link'
  records.value = { audit: [], chat: [] }
  recordsError.value = ''
  recordsLoadedAt.value = 0
  qrDataUrl.value = await QRCode.toDataURL(link.value, { width: 220, margin: 1, color: { dark: '#0e1116', light: '#e8f6fa' } })
  statusText.value = ''
}

async function deploy() {
  const inst = config.instances.find((i) => i.id === form.value.instanceId)
  const provider = config.aiProviders.find((p) => p.id === form.value.aiProviderId)
  const conn = connOf(form.value.instanceId)
  if (!inst || !provider || !conn) return
  deploying.value = true
  deployError.value = ''
  progress.phase = 'check'
  progress.percent = 0
  progress.msg = '准备部署…'
  // 订阅部署进度事件（主进程推结构化 { phase, percent, msg }）
  if (stepUnsub) stepUnsub()
  stepUnsub = window.api.on(`agent:step:${conn.id}`, (p) => {
    progress.phase = p.phase
    progress.percent = Math.max(progress.percent, p.percent || 0)
    progress.msg = p.msg || progress.msg
  })
  const r = await window.api.agentDeploy({
    connId: conn.id,
    instance: { host: inst.host },
    aiProvider: JSON.parse(JSON.stringify(provider)),
    port: Number(form.value.port) || 37777
  })
  if (stepUnsub) { stepUnsub(); stepUnsub = null }
  deploying.value = false
  if (!r.ok) {
    deployError.value = r.error
    runDiagnose(provider, r.error) // 异步诊断，不阻塞错误展示
    return
  }
  // 保存部署记录
  const rec = {
    id: config.newDeployId(),
    instanceId: inst.id,
    instanceName: inst.name,
    host: inst.host,
    port: r.port,
    token: r.token,
    aiProviderId: provider.id,
    deployedAt: Date.now()
  }
  const idx = config.agentDeployments.findIndex((d) => d.instanceId === inst.id)
  if (idx >= 0) config.agentDeployments[idx] = rec
  else config.agentDeployments.push(rec)
  await config.save()
  dialog.showToast('部署成功，扫码即可绑定手机')
  select(rec)
}

async function refreshStatus() {
  const conn = connOf(current.value.instanceId)
  if (!conn) {
    statusText.value = '（未连接该服务器）'
    return
  }
  checking.value = true
  try {
    const r = await window.api.agentStatus(conn.id, current.value.port)
    statusText.value = r.ok
      ? `${r.active ? '服务运行中' : '服务未运行'}${r.active ? ' · ' + (r.healthy ? '接口正常 ✓' : '接口无响应') : ''}`
      : '（检测失败：' + r.error + '）'
  } finally {
    checking.value = false
  }
}

async function regenToken() {
  const conn = connOf(current.value.instanceId)
  if (!conn) {
    dialog.showToast('请先连接该服务器再操作')
    return
  }
  // 用应用内确认弹窗：Electron 无边框窗口里原生 window.confirm 会弹到窗口后面/无响应
  const okGo = await dialog.askConfirm({
    title: '重新生成密钥',
    message: '所有已绑定的手机都会失效（需要重新扫码）。继续？'
  })
  if (!okGo) return
  regening.value = true
  const r = await window.api.agentRegenToken(conn.id, current.value.port)
  regening.value = false
  if (!r.ok) {
    dialog.showToast('失败：' + r.error)
    return
  }
  current.value.token = r.token
  await config.save()
  select(current.value)
  dialog.showToast('已生成新密钥，请重新扫码')
}

async function undeploy() {
  if (undeploying.value) return
  const conn = connOf(current.value.instanceId)
  if (!conn) {
    dialog.showToast('请先连接该服务器再操作')
    return
  }
  const okGo = await dialog.askConfirm({
    title: '卸载 Agent',
    message: `确定卸载服务器「${current.value.instanceName}」上的 Agent？将停止服务并删除 /opt/longserve-agent（不影响其他服务）。`
  })
  if (!okGo) return
  undeploying.value = true
  try {
    const r = await window.api.agentUndeploy(conn.id)
    if (!r.ok) {
      dialog.showToast('卸载失败：' + r.error)
      return
    }
    config.agentDeployments = config.agentDeployments.filter((d) => d.id !== current.value.id)
    await config.save()
    mode.value = 'empty'
    currentId.value = null
    dialog.showToast('已卸载')
  } finally {
    undeploying.value = false
  }
}

// 更新 Agent（原地重部署，token 保留、手机不用重新扫码）：预填表单进入部署流程
function redeploy() {
  const d = current.value
  if (!d) return
  deployError.value = ''
  diag.value = null
  diagError.value = ''
  diagLoading.value = false
  progress.phase = ''
  progress.percent = 0
  progress.msg = ''
  form.value = {
    instanceId: d.instanceId || '',
    aiProviderId: d.aiProviderId || '',
    port: d.port || 37777
  }
  mode.value = 'new'
  currentId.value = d.id
}

function copyLink() {
  navigator.clipboard.writeText(link.value).then(() => dialog.showToast('已复制连接地址'))
}

onUnmounted(() => {
  if (stepUnsub) stepUnsub()
})
</script>

<style scoped>
.set-body { display: flex; flex: 1; min-height: 0; }
.side-list {
  width: 210px;
  border-right: 1px solid var(--border);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.side-items { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
.side-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  border: 1px solid transparent;
}
.side-item:hover { background: var(--bg3); }
.side-item.on { background: var(--bg3); border-color: var(--border-strong); }
.form-panel { flex: 1; min-width: 0; padding: 18px 20px; overflow-y: auto; }
/* 关键：grid/flex 子项默认 min-width:auto，长内容（URL/长按钮）会把布局撑破——统一压到 0 */
.form-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-2col > * { min-width: 0; }
.form-actions { display: flex; flex-wrap: wrap; gap: 8px; row-gap: 8px; margin-top: 6px; }
.key-warn {
  color: var(--amber);
  font-size: 12px;
  background: var(--amber-dim);
  border: 1px solid rgba(242, 177, 85, 0.35);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
}
/* ---------- 部署进度条 ---------- */
.deploy-progress {
  padding: 14px 16px;
  margin-bottom: 14px;
  position: relative;
  overflow: hidden;
}
.dp-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 9px; }
.dp-phase { font-size: 12px; color: var(--text); }
.dp-pct { font-size: 12px; color: var(--cyan); font-weight: 700; }
.dp-bar {
  position: relative;
  height: 10px;
  background: var(--bg0);
  border: 1px solid var(--border);
  border-radius: 5px;
  overflow: hidden;
}
.dp-fill {
  height: 100%;
  background: linear-gradient(90deg, #2b7f93, var(--cyan));
  border-radius: 5px;
  transition: width 0.4s ease;
  box-shadow: 0 0 10px rgba(92, 207, 230, 0.5);
  position: relative;
  overflow: hidden;
}
/* 流动的能量条纹 */
.dp-fill::after {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    115deg,
    transparent 0 10px,
    rgba(255, 255, 255, 0.22) 10px 14px
  );
  animation: dpflow 0.9s linear infinite;
}
@keyframes dpflow { to { transform: translateX(-24px); } }
/* 扫描光带（未满部分游走） */
.dp-scan {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 36px;
  background: linear-gradient(90deg, transparent, rgba(92, 207, 230, 0.35), transparent);
  animation: dpscan 1.6s ease-in-out infinite;
}
@keyframes dpscan {
  0% { left: -36px; }
  100% { left: 100%; }
}
.dp-steps { display: flex; gap: 14px; margin-top: 9px; }
.dp-step { font-size: 10.5px; color: var(--text-faint); position: relative; padding-left: 10px; }
.dp-step::before {
  content: '';
  position: absolute;
  left: 0;
  top: 4px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--bg3);
}
.dp-step.done { color: var(--cyan); }
.dp-step.done::before { background: var(--cyan); box-shadow: 0 0 5px var(--cyan); }
.dp-step.active { color: var(--text); }
.dp-step.active::before { background: var(--amber); animation: pulse 0.9s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
.key-warn-sub { margin-top: 6px; color: var(--text-dim); font-size: 11.5px; }
/* ---------- AI 失败诊断 ---------- */
.ai-diag {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text);
  background: var(--bg2);
  border: 1px solid var(--border-strong);
  border-left: 3px solid var(--cyan);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
}
.ai-diag-title { color: var(--cyan); font-weight: 600; margin-bottom: 4px; }
.ai-diag-row b { color: var(--text); }
.ai-diag-fix { white-space: pre-line; font-family: var(--mono, monospace); font-size: 11.5px; }
.qr-wrap { text-align: center; margin-bottom: 16px; }
.qr {
  width: 180px; height: 180px;
  border-radius: 10px;
  border: 1px solid var(--border-strong);
  background: #e8f6fa;
  padding: 6px;
}
.qr-hint { font-size: 11px; color: var(--text-faint); margin-top: 6px; }
.link-row { display: flex; gap: 8px; align-items: center; min-width: 0; }
.link-text {
  flex: 1;
  min-width: 0; /* 没有它 ellipsis 失效，长 URL 直接撑破子页面 */
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  font-size: 11.5px;
}
.link-copy { flex-shrink: 0; }
.regen-btn { max-width: 100%; white-space: nowrap; }

/* ---------- 详情子页签 ---------- */
.sub-tabs {
  display: flex; align-items: center; gap: 4px;
  border-bottom: 1px solid var(--border);
  margin: -6px 0 14px;
  padding-bottom: 0;
}
.sub-tab {
  padding: 7px 12px;
  font-size: 12.5px;
  color: var(--text-dim);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.sub-tab:hover { color: var(--text); }
.sub-tab.on { color: var(--cyan); border-bottom-color: var(--cyan); }

/* ---------- 记录列表（指令/聊天共用骨架） ---------- */
.rec-list { display: flex; flex-direction: column; gap: 8px; padding-bottom: 12px; }
.rec {
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}
.rec.danger { border-color: rgba(242, 177, 85, 0.35); }
.rec.denied { opacity: 0.65; }
.rec-top { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.src { font-size: 10.5px; padding: 1px 8px; border-radius: 8px; }
.src.ai { color: var(--violet, #a78bfa); background: rgba(167, 139, 250, 0.12); }
.src.manual { color: var(--cyan, #5ccfe6); background: var(--cyan-dim, rgba(92, 207, 230, 0.14)); }
.flag { font-size: 10px; color: var(--amber); background: var(--amber-dim); padding: 1px 8px; border-radius: 8px; }
.rec.denied .flag { color: var(--red); background: var(--red-dim); }
.time { margin-left: auto; font-size: 10.5px; color: var(--text-faint); }
.rec-cmd { font-size: 12px; color: var(--text); word-break: break-all; }
.rec-note { font-size: 11px; color: var(--text-dim); margin-top: 4px; }
.rec-out {
  margin-top: 6px; padding-top: 6px;
  border-top: 1px dashed var(--border);
  font-size: 10.5px; color: var(--text-faint);
  white-space: pre-wrap; word-break: break-all;
  max-height: 120px; overflow: hidden;
}

/* ---------- 聊天气泡 ---------- */
.chat-row { display: flex; flex-direction: column; gap: 4px; }
.chat-role { font-size: 10.5px; color: var(--text-faint); }
.chat-row.user .chat-role { text-align: right; }
.chat-bubble {
  max-width: 92%;
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
.user-bubble {
  align-self: flex-end;
  background: var(--cyan-dim, rgba(92, 207, 230, 0.14));
  border: 1px solid var(--border-strong);
  color: var(--text);
}
.ai-bubble {
  align-self: flex-start;
  background: var(--bg2);
  border: 1px solid var(--border);
  color: var(--text);
}
.chat-tool {
  align-self: flex-start;
  font-size: 10.5px;
  color: var(--text-faint);
  background: var(--bg0);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 3px 8px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty-hint { text-align: center; padding-top: 90px; }
.empty-hint.rec-empty { padding-top: 46px; }
.empty-hint .big { font-size: 40px; margin-bottom: 10px; }
.empty-hint .faint { margin-top: 6px; font-size: 11.5px; }
.faint { color: var(--text-faint); }
.grow { flex: 1; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
