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
            <option v-for="p in config.aiProviders" :key="p.id" :value="p.id" :disabled="p.protocol === 'anthropic'">
              {{ p.name }}（{{ p.model || '未设模型' }}）{{ p.protocol === 'anthropic' ? ' — 手机控制暂不支持' : '' }}
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

        <!-- 部署进度 -->
        <div v-if="steps.length" class="steps panel">
          <div v-for="(s, i) in steps" :key="i" class="step" :class="{ last: i === steps.length - 1 }">
            <span class="step-dot" :class="{ spinning: i === steps.length - 1 && deploying }"></span>
            {{ s }}
          </div>
        </div>
        <div v-if="deployError" class="key-warn">{{ deployError }}</div>

        <div class="form-actions">
          <div class="grow"></div>
          <button class="primary" :disabled="deploying || !canDeploy" @click="deploy">
            {{ deploying ? '部署中…' : '开始部署' }}
          </button>
        </div>
      </template>

      <!-- ===== 已部署详情 ===== -->
      <template v-else-if="current">
        <div class="qr-wrap">
          <img v-if="qrDataUrl" :src="qrDataUrl" class="qr" alt="扫码绑定" />
          <div class="qr-hint">手机浏览器扫码 → 自动绑定</div>
        </div>
        <div class="form-row">
          <label>连接地址（含绑定密钥，请勿泄露）</label>
          <div class="link-row">
            <span class="mono link-text ellipsis">{{ link }}</span>
            <button @click="copyLink">复制</button>
          </div>
        </div>
        <div class="form-2col">
          <div class="form-row">
            <label>服务器</label>
            <div>{{ current.instanceName }}（<span class="mono">{{ current.host }}</span>）</div>
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
          换绑/解绑手机：点「重新生成密钥」，旧二维码立即作废。<br>
          卸载会停止并删除服务器上的 Agent 与其数据（不影响其他服务）。
        </div>
        <div class="form-actions">
          <button class="danger" @click="undeploy">卸载</button>
          <div class="grow"></div>
          <button @click="regenToken" :disabled="regening">{{ regening ? '生成中…' : '重新生成密钥（解绑全部手机）' }}</button>
        </div>
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
import { ref, computed, inject, onUnmounted } from 'vue'
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
const steps = ref([])
const qrDataUrl = ref('')
const checking = ref(false)
const statusText = ref('')
const regening = ref(false)
let stepUnsub = null

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
  steps.value = []
  form.value = { instanceId: '', aiProviderId: '', port: 37777 }
}

async function select(d) {
  mode.value = 'detail'
  currentId.value = d.id
  qrDataUrl.value = await QRCode.toDataURL(link.value, { width: 220, margin: 1, color: { dark: '#0e1116', light: '#e8f6fa' } })
  statusText.value = ''
}

async function deploy() {
  const inst = config.instances.find((i) => i.id === form.value.instanceId)
  const provider = config.aiProviders.find((p) => p.id === form.value.aiProviderId)
  const conn = connOf(form.value.instanceId)
  if (!inst || !provider || !conn) return
  if (provider.protocol === 'anthropic') {
    deployError.value = '手机控制暂不支持 Anthropic 原生协议的 AI 配置，请选择 OpenAI 兼容配置'
    return
  }
  deploying.value = true
  deployError.value = ''
  steps.value = []
  // 订阅部署步骤事件
  if (stepUnsub) stepUnsub()
  stepUnsub = window.api.on(`agent:step:${conn.id}`, (msg) => {
    steps.value.push(msg)
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
  if (!window.confirm('重新生成密钥后，所有已绑定的手机都会失效（需要重新扫码）。继续？')) return
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
  const conn = connOf(current.value.instanceId)
  if (!conn) {
    dialog.showToast('请先连接该服务器再操作')
    return
  }
  if (!window.confirm(`确定卸载服务器「${current.value.instanceName}」上的 Agent？\n将停止服务并删除 /opt/longserve-agent（不影响其他服务）。`)) return
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
.form-panel { flex: 1; padding: 18px 20px; overflow-y: auto; }
.form-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-actions { display: flex; gap: 8px; margin-top: 6px; }
.key-warn {
  color: var(--amber);
  font-size: 12px;
  background: var(--amber-dim);
  border: 1px solid rgba(242, 177, 85, 0.35);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
}
.steps {
  padding: 10px 12px;
  max-height: 180px;
  overflow-y: auto;
  margin-bottom: 12px;
  font-size: 11.5px;
}
.step { display: flex; align-items: center; gap: 8px; padding: 3px 0; color: var(--text-dim); }
.step.last { color: var(--text); }
.step-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--cyan); flex-shrink: 0; }
.step-dot.spinning { animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }
.qr-wrap { text-align: center; margin-bottom: 16px; }
.qr {
  width: 180px; height: 180px;
  border-radius: 10px;
  border: 1px solid var(--border-strong);
  background: #e8f6fa;
  padding: 6px;
}
.qr-hint { font-size: 11px; color: var(--text-faint); margin-top: 6px; }
.link-row { display: flex; gap: 8px; align-items: center; }
.link-text {
  flex: 1;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  font-size: 11.5px;
}
.empty-hint { text-align: center; padding-top: 90px; }
.empty-hint .big { font-size: 40px; margin-bottom: 10px; }
.empty-hint .faint { margin-top: 6px; font-size: 11.5px; }
.faint { color: var(--text-faint); }
.grow { flex: 1; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
