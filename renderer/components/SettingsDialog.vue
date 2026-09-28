<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-mask" @click.self="close">
      <div class="modal settings-modal">
        <div class="set-tabs">
          <div class="set-tab" :class="{ on: tab === 'instances' }" @click="switchTab('instances')">服务器实例</div>
          <div class="set-tab" :class="{ on: tab === 'ai' }" @click="switchTab('ai')">AI 配置</div>
          <div class="grow"></div>
          <button class="ghost" @click="close">✕</button>
        </div>

        <!-- ================= 服务器实例 ================= -->
        <div v-if="tab === 'instances'" class="set-body">
          <div class="side-list">
            <button class="primary" style="width:100%" @click="newInstance">＋ 新增服务器</button>
            <div class="side-items">
              <div
                v-for="inst in config.instances"
                :key="inst.id"
                class="side-item"
                :class="{ on: editingId === inst.id }"
                @click="startEdit(inst)"
              >
                <span class="ellipsis">{{ inst.name }}</span>
                <span class="faint mono" style="font-size:10px">{{ inst.host }}</span>
              </div>
            </div>
          </div>

          <div class="form-panel">
            <template v-if="form">
              <div class="form-row">
                <label>服务器名称</label>
                <input v-model="form.name" placeholder="如：生产环境 / 测试机" />
              </div>
              <div class="form-2col">
                <div class="form-row">
                  <label>IP 地址</label>
                  <input v-model="form.host" class="mono" placeholder="1.2.3.4" />
                </div>
                <div class="form-row">
                  <label>端口</label>
                  <input v-model="form.port" class="mono" placeholder="22" />
                </div>
              </div>
              <div class="form-2col">
                <div class="form-row">
                  <label>用户名</label>
                  <input v-model="form.username" class="mono" placeholder="root" />
                </div>
                <div class="form-row">
                  <label>密码</label>
                  <input v-model="form.password" type="password" class="mono" placeholder="登录密码" />
                </div>
              </div>
              <div class="faint" style="margin-bottom:14px">密码使用系统级加密（DPAPI）存储在本机，不上传任何地方。</div>

              <div class="form-actions">
                <button class="danger" v-if="editingId" @click="removeInstanceCurrent">删除</button>
                <div class="grow"></div>
                <button class="primary" @click="saveInstance">保存</button>
              </div>
            </template>
            <div v-else class="empty-hint">
              <div class="big">﹢</div>
              <div>新增或在左侧选择一个实例进行编辑</div>
            </div>
          </div>
        </div>

        <!-- ================= AI 配置 ================= -->
        <div v-else class="set-body">
          <div class="side-list">
            <button class="primary" style="width:100%" @click="newProvider">＋ 新增 AI 配置</button>
            <div class="side-items">
              <div
                v-for="p in config.aiProviders"
                :key="p.id"
                class="side-item"
                :class="{ on: editingId === p.id }"
                @click="startEditProvider(p)"
              >
                <span class="ellipsis">{{ p.name }}</span>
                <span v-if="p.id === config.activeAiProviderId" class="use-badge">使用中</span>
              </div>
            </div>
          </div>

          <div class="form-panel">
            <template v-if="form">
              <div class="form-row">
                <label>配置名称</label>
                <input v-model="form.name" placeholder="如：DeepSeek / 中转站A" />
              </div>
              <div class="form-row">
                <label>请求地址（Base URL）</label>
                <input v-model="form.baseUrl" class="mono" placeholder="https://api.deepseek.com" />
                <div class="faint">OpenAI 兼容格式。填到域名或 /v1 即可，无需带 /chat/completions。</div>
              </div>
              <div class="form-row">
                <label>API Key</label>
                <input v-model="form.apiKey" type="password" class="mono" placeholder="sk-..." />
              </div>
              <div class="form-row">
                <label>模型</label>
                <div style="display:flex; gap:6px">
                  <input v-model="form.model" class="mono grow" placeholder="deepseek-chat" list="model-suggestions" />
                  <button @click="fetchModels" :disabled="fetchingModels">{{ fetchingModels ? '获取中...' : '获取列表' }}</button>
                </div>
                <datalist id="model-suggestions">
                  <option v-for="m in modelOptions" :key="m" :value="m"></option>
                </datalist>
              </div>

              <div class="form-actions">
                <button
                  v-if="editingId && editingId !== config.activeAiProviderId"
                  @click="setActive"
                >设为使用中</button>
                <div class="grow"></div>
                <button class="danger" v-if="editingId" @click="removeProviderCurrent">删除</button>
                <button class="primary" @click="saveProvider">保存</button>
              </div>
            </template>
            <div v-else class="empty-hint">
              <div class="big">﹢</div>
              <div>新增或在左侧选择一个 AI 配置进行编辑</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, reactive } from 'vue'
import { useConfigStore } from '../stores/config'

const config = useConfigStore()
const visible = ref(false)
const tab = ref('instances')
const editingId = ref(null)
const form = ref(null)
const fetchingModels = ref(false)
const modelOptions = ref([])

// 打开弹窗：tabName 'instances' | 'ai'，action 可选
function open(tabName, action) {
  visible.value = true
  tab.value = tabName || 'instances'
  editingId.value = null
  form.value = null
  if (action && action.type === 'new-instance') newInstance()
  if (action && action.type === 'edit-instance') {
    const inst = config.instances.find((i) => i.id === action.id)
    if (inst) startEdit(inst)
  }
}
function close() {
  visible.value = false
}
defineExpose({ open })

// 切 tab 必须重置表单：否则上一 tab 的表单数据会泄漏到下一 tab
function switchTab(name) {
  tab.value = name
  editingId.value = null
  form.value = null
  modelOptions.value = []
}

// ---------- 实例 ----------
function newInstance() {
  editingId.value = null
  form.value = { id: null, name: '', host: '', port: 22, username: 'root', password: '' }
}
function startEdit(inst) {
  editingId.value = inst.id
  form.value = { ...inst }
}
async function saveInstance() {
  const f = form.value
  if (!f.name || !f.host) {
    alert('名称和 IP 地址不能为空')
    return
  }
  const data = {
    id: f.id || config.newInstanceId(),
    name: f.name.trim(),
    host: f.host.trim(),
    port: Number(f.port) || 22,
    username: (f.username || 'root').trim(),
    password: f.password || ''
  }
  const idx = config.instances.findIndex((i) => i.id === data.id)
  if (idx >= 0) config.instances[idx] = data
  else config.instances.push(data)
  await config.save()
  editingId.value = data.id
  form.value = { ...data }
}
function removeInstanceCurrent() {
  const id = editingId.value
  if (!id) return
  if (!confirm('确定删除该配置？')) return
  config.instances = config.instances.filter((i) => i.id !== id)
  config.save()
  form.value = null
  editingId.value = null
}

// ---------- AI ----------
function newProvider() {
  editingId.value = null
  modelOptions.value = []
  form.value = { id: null, name: '', baseUrl: '', apiKey: '', model: '' }
}
function startEditProvider(p) {
  editingId.value = p.id
  modelOptions.value = p.model ? [p.model] : []
  form.value = { ...p }
}
async function saveProvider() {
  const f = form.value
  if (!f.name || !f.baseUrl) {
    alert('名称和请求地址不能为空')
    return
  }
  const data = {
    id: f.id || config.newProviderId(),
    name: f.name.trim(),
    baseUrl: f.baseUrl.trim(),
    apiKey: f.apiKey || '',
    model: (f.model || '').trim()
  }
  const idx = config.aiProviders.findIndex((p) => p.id === data.id)
  if (idx >= 0) config.aiProviders[idx] = data
  else {
    config.aiProviders.push(data)
    // 第一个配置自动设为使用中
    if (!config.activeAiProviderId) config.activeAiProviderId = data.id
  }
  await config.save()
  editingId.value = data.id
  form.value = { ...data }
}
function removeProviderCurrent() {
  const id = editingId.value
  if (!id) return
  if (!confirm('确定删除该 AI 配置？')) return
  config.aiProviders = config.aiProviders.filter((p) => p.id !== id)
  if (config.activeAiProviderId === id) {
    config.activeAiProviderId = config.aiProviders[0]?.id || null
  }
  config.save()
  form.value = null
  editingId.value = null
}
function setActive() {
  if (editingId.value) {
    config.activeAiProviderId = editingId.value
    config.save()
  }
}
async function fetchModels() {
  const f = form.value
  if (!f.baseUrl) {
    alert('请先填写请求地址')
    return
  }
  fetchingModels.value = true
  try {
    const res = await window.api.aiListModels({ baseUrl: f.baseUrl, apiKey: f.apiKey })
    if (res.ok) {
      modelOptions.value = res.models
      if (!res.models.length) alert('该服务未返回模型列表')
    } else {
      alert('获取失败：' + res.error)
    }
  } catch (err) {
    alert('获取失败：' + err.message)
  } finally {
    fetchingModels.value = false
  }
}
</script>

<style scoped>
.settings-modal { width: 720px; height: 520px; }
.set-tabs {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border);
  padding: 0 10px;
  flex-shrink: 0;
}
.set-tab {
  padding: 11px 16px;
  font-size: 13px;
  color: var(--text-dim);
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.set-tab.on { color: var(--text); border-bottom-color: var(--green); }
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
.use-badge {
  align-self: flex-start;
  font-size: 10px;
  color: var(--violet);
  background: var(--violet-dim);
  border-radius: 8px;
  padding: 1px 7px;
}
.form-panel { flex: 1; padding: 18px 20px; overflow-y: auto; }
.form-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-actions { display: flex; gap: 8px; margin-top: 6px; }
</style>
