<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-mask" @click.self="close">
      <div class="modal settings-modal">
        <div class="set-tabs">
          <div class="set-tab" :class="{ on: tab === 'instances' }" @click="switchTab('instances')">服务器实例</div>
          <div class="set-tab" :class="{ on: tab === 'ai' }" @click="switchTab('ai')">AI 配置</div>
          <div class="set-tab" :class="{ on: tab === 'skills' }" @click="switchTab('skills')">AI 技能</div>
          <div class="set-tab" :class="{ on: tab === 'pipelines' }" @click="switchTab('pipelines')">流水线</div>
          <div class="set-tab" :class="{ on: tab === 'appearance' }" @click="switchTab('appearance')">外观</div>
          <div class="set-tab" :class="{ on: tab === 'data' }" @click="switchTab('data')">数据</div>
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
                  <div v-if="pwLocked" class="locked-row">
                    <span class="locked-box">🔒 已锁定，无法查看</span>
                    <button class="ghost" @click="unlockPassword">重置</button>
                  </div>
                  <input v-else v-model="form.password" type="password" class="mono" placeholder="登录密码" />
                  <div v-if="passwordDecryptFailed" class="key-warn">
                    ⚠ 已保存的密码无法解密（加密环境变化所致），请重新填写密码并保存
                  </div>
                </div>
              </div>
              <div class="faint" style="margin-bottom:14px">密码使用系统级加密（DPAPI）存储在本机，不上传任何地方。保存后不再显示，可随时重置更换。</div>

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

        <!-- ================= AI 技能 ================= -->
        <div v-else-if="tab === 'skills'" class="set-body">
          <div class="side-list">
            <button class="primary" style="width:100%" @click="newSkill">＋ 新增技能</button>
            <div class="side-items">
              <div
                v-for="s in config.skills"
                :key="s.id"
                class="side-item"
                :class="{ on: editingId === s.id }"
                @click="startEditSkill(s)"
              >
                <span class="ellipsis">{{ s.name }}</span>
                <span class="faint ellipsis" style="font-size:10.5px">{{ s.enabled ? s.description : '（已停用）' }}</span>
              </div>
            </div>
          </div>
          <div class="form-panel">
            <template v-if="form">
              <div class="form-row">
                <label>技能名称（AI 调用时使用，建议简短明确）</label>
                <input v-model="form.name" placeholder="如：部署学生急事通" />
              </div>
              <div class="form-row">
                <label>触发场景描述（告诉 AI 什么时候用这个技能）</label>
                <input v-model="form.description" placeholder="如：当要求部署/重启学子急事通服务时使用" />
              </div>
              <div class="form-row">
                <label>技能内容（AI 加载后会严格按此执行）</label>
                <textarea
                  v-model="form.content"
                  rows="10"
                  style="resize:vertical; font-family: var(--font-mono); font-size:12px"
                  placeholder="写清楚步骤、命令、注意事项...&#10;例如：&#10;1. cd /var/www/xxx&#10;2. 拉取最新代码&#10;3. systemctl restart xxx"
                ></textarea>
              </div>
              <label style="display:flex; align-items:center; gap:6px; margin-bottom:14px; cursor:pointer">
                <input type="checkbox" v-model="form.enabled" style="width:auto" />
                启用（启用的技能会注入 AI 的技能列表，按场景自动调用）
              </label>
              <div class="form-actions">
                <div class="grow"></div>
                <button class="danger" v-if="editingId" @click="removeSkillCurrent">删除</button>
                <button class="primary" @click="saveSkill">保存</button>
              </div>
            </template>
            <div v-else class="empty-hint">
              <div class="big">⚡</div>
              <div>把你的固定工作流程做成技能</div>
              <div class="faint">AI 会在任务匹配时自动加载对应技能</div>
            </div>
          </div>
        </div>

        <!-- ================= 流水线 ================= -->
        <div v-else-if="tab === 'pipelines'" class="set-body">
          <div class="side-list">
            <button class="primary" style="width:100%" @click="newPipeline">＋ 新建流水线</button>
            <div class="side-items">
              <div
                v-for="p in config.pipelines"
                :key="p.id"
                class="side-item"
                :class="{ on: editingId === p.id }"
                @click="startEditPipeline(p)"
              >
                <span class="ellipsis">{{ p.name }}</span>
                <span class="faint" style="font-size:10.5px">{{ p.steps.length }} 个步骤</span>
              </div>
            </div>
          </div>
          <div class="form-panel">
            <template v-if="form">
              <div class="form-row">
                <label>流水线名称</label>
                <input v-model="form.name" placeholder="如：部署学生急事通全流程" />
              </div>
              <div class="form-row">
                <label>步骤（从上到下依次执行，勾选"检查点"的步骤完成后暂停等你确认）</label>
                <div class="pl-steps">
                  <div v-for="(st, i) in form.steps" :key="i" class="pl-step">
                    <span class="mono faint pl-idx">{{ i + 1 }}</span>
                    <select v-model="st.skillId" class="grow">
                      <option value="" disabled>选择技能…</option>
                      <option v-for="s in config.skills" :key="s.id" :value="s.id">{{ s.name }}</option>
                    </select>
                    <label class="pl-ck" title="完成后暂停等待人工确认">
                      <input type="checkbox" v-model="st.checkpoint" style="width:auto" />检查点
                    </label>
                    <button class="ghost" title="上移" :disabled="i === 0" @click="moveStep(i, -1)">↑</button>
                    <button class="ghost" title="下移" :disabled="i === form.steps.length - 1" @click="moveStep(i, 1)">↓</button>
                    <button class="ghost" title="移除" @click="form.steps.splice(i, 1)">✕</button>
                  </div>
                  <button class="ghost" style="width:100%" @click="form.steps.push({ skillId: '', checkpoint: true })">＋ 添加步骤</button>
                </div>
              </div>
              <div class="form-actions">
                <button class="danger" v-if="editingId" @click="removePipelineCurrent">删除</button>
                <div class="grow"></div>
                <button class="primary" @click="savePipeline">保存</button>
              </div>
            </template>
            <div v-else class="empty-hint">
              <div class="big">▶</div>
              <div>把多个技能串成带检查点的流水线</div>
              <div class="faint">在 AI 副驾里点 ▶ 一键按步骤执行</div>
            </div>
          </div>
        </div>

        <!-- ================= 外观 ================= -->
        <div v-else-if="tab === 'appearance'" class="set-body">
          <div class="form-panel" style="max-width: 560px">
            <div class="form-row">
              <label>主题预设</label>
              <div style="display:flex; gap:8px; flex-wrap:wrap">
                <div
                  v-for="p in APPEARANCE_PRESETS"
                  :key="p.name"
                  class="preset-card"
                  :class="{ on: isPresetActive(p) }"
                  @click="applyPreset(p)"
                >
                  <span class="preset-dot" :style="{ background: p.accent }"></span>
                  <span>{{ p.name }}</span>
                </div>
              </div>
            </div>
            <div class="form-2col">
              <div class="form-row">
                <label>强调色（状态灯/按钮/终端光标）</label>
                <div style="display:flex; gap:6px; align-items:center">
                  <input type="color" v-model="draftAccent" @input="updateAppearance" style="width:46px; padding:2px" />
                  <span class="mono faint">{{ draftAccent }}</span>
                </div>
              </div>
              <div class="form-row">
                <label>界面文字颜色</label>
                <div style="display:flex; gap:6px; align-items:center">
                  <input type="color" v-model="draftText" @input="updateAppearance" style="width:46px; padding:2px" />
                  <span class="mono faint">{{ draftText }}</span>
                </div>
              </div>
            </div>
            <div class="form-row">
              <label>界面背景色相：<span class="mono">{{ draftHue }}°</span></label>
              <input type="range" min="0" max="360" v-model.number="draftHue" @input="updateAppearance" style="width:100%" />
            </div>
            <div class="form-row">
              <label>界面透明度：<span class="mono">{{ draftAlpha }}%</span>（数值越小界面越通透）</label>
              <input type="range" min="30" max="100" v-model.number="draftAlpha" @input="updateAppearance" style="width:100%" />
            </div>
            <div class="form-row">
              <label>终端字号：<span class="mono">{{ draftFs }}px</span></label>
              <input type="range" min="11" max="20" v-model.number="draftFs" @input="updateAppearance" style="width:100%" />
            </div>
            <div class="form-2col">
              <div class="form-row">
                <label>终端背景色（默认跟随全局）</label>
                <div style="display:flex; gap:6px; align-items:center">
                  <input type="color" :value="draftTermBg || '#14161b'" @input="draftTermBg = $event.target.value; updateAppearance()" style="width:46px; padding:2px" />
                  <button class="ghost" @click="draftTermBg = ''; updateAppearance()">跟随全局</button>
                </div>
              </div>
              <div class="form-row">
                <label>终端文字色（默认跟随全局）</label>
                <div style="display:flex; gap:6px; align-items:center">
                  <input type="color" :value="draftTermFg || '#d8dce4'" @input="draftTermFg = $event.target.value; updateAppearance()" style="width:46px; padding:2px" />
                  <button class="ghost" @click="draftTermFg = ''; updateAppearance()">跟随全局</button>
                </div>
              </div>
            </div>
            <div class="form-row">
              <label>窗口效果（真透明可看到桌面壁纸）</label>
              <div style="display:flex; gap:8px">
                <button
                  v-for="opt in EFFECTS"
                  :key="opt.value"
                  :class="{ primary: draftEffect === opt.value }"
                  @click="draftEffect = opt.value; updateAppearance(true)"
                >{{ opt.label }}</button>
              </div>
            </div>
            <div class="form-actions">
              <button @click="resetAppearance">恢复默认</button>
              <div class="grow"></div>
              <div class="faint" style="align-self:center">改动即时生效并自动保存</div>
            </div>
          </div>
        </div>

        <!-- ================= 数据 ================= -->
        <div v-else-if="tab === 'data'" class="set-body">
          <div class="form-panel" style="max-width: 560px">
            <div class="form-row">
              <label>数据保存位置（配置、服务器密码、AI 密钥、对话历史）</label>
              <div class="mono" style="word-break:break-all; background:var(--bg2); padding:8px 10px; border-radius:6px; font-size:12px">{{ dataDir }}</div>
            </div>
            <div class="form-row">
              <label>说明</label>
              <div class="faint" style="font-size:12px; line-height:1.7">
                数据独立于 exe 保存，删除软件不会丢数据。<br>
                更换位置会把全部数据（含加密密钥）拷贝到新目录并重启应用；换电脑时拷贝数据文件夹即可迁移。
              </div>
            </div>
            <div class="form-row">
              <label>会话录制保存位置（asciinema .cast 格式，可在终端标签栏点「⏺ 录制」启停）</label>
              <div class="mono" style="word-break:break-all; background:var(--bg2); padding:8px 10px; border-radius:6px; font-size:12px">{{ recordDirShown }}</div>
              <div style="display:flex; gap:8px">
                <button @click="changeRecordDir">更改位置…</button>
                <button class="ghost" @click="resetRecordDir">恢复默认</button>
              </div>
            </div>
            <div class="form-actions">
              <button @click="openDataDir">打开数据文件夹</button>
              <button @click="changeDataDir">更改保存位置…</button>
              <button class="ghost" @click="resetDataDir">恢复默认位置</button>
            </div>
          </div>
        </div>

        <!-- ================= AI 配置 ================= -->
        <div v-else-if="tab === 'ai'" class="set-body">
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
                <label>接口协议</label>
                <select v-model="form.protocol">
                  <option value="openai">OpenAI 兼容（/v1/chat/completions）</option>
                  <option value="anthropic">Anthropic 原生（/v1/messages）</option>
                </select>
                <div class="faint" v-if="form.protocol === 'anthropic'">
                  Claude 系中转选这个。地址填到端点根（如 https://xx.com/anthropic，末尾不加斜杠），认证用 AUTH_TOKEN。
                </div>
                <div class="faint" v-else>
                  DeepSeek/Kimi/通义/多数中转站选这个。填到域名或 /v1 即可，无需带 /chat/completions。
                </div>
              </div>
              <div class="form-row">
                <label>请求地址（Base URL）</label>
                <input v-model="form.baseUrl" class="mono" :placeholder="form.protocol === 'anthropic' ? 'https://xx.com/anthropic' : 'https://api.deepseek.com'" />
              </div>
              <div class="form-row">
                <label>API Key</label>
                <div v-if="keyLocked" class="locked-row">
                  <span class="locked-box">🔒 已锁定，无法查看</span>
                  <button class="ghost" @click="unlockKey">重置</button>
                </div>
                <input v-else v-model="form.apiKey" type="password" class="mono" placeholder="sk-... 或 tp-..." />
                <div v-if="keyDecryptFailed" class="key-warn">
                  ⚠ 已保存的密钥无法解密（加密环境变化所致），请重新粘贴 API Key 并保存
                </div>
              </div>
              <div class="form-row">
                <label>模型</label>
                <div style="display:flex; gap:6px">
                  <input v-model="form.model" class="mono grow" placeholder="deepseek-chat" list="model-suggestions" />
                  <button @click="fetchModels" :disabled="fetchingModels">{{ fetchingModels ? '获取中...' : '获取列表' }}</button>
                  <button @click="testConn" :disabled="testingConn">{{ testingConn ? '测试中...' : '测试连接' }}</button>
                </div>
                <datalist id="model-suggestions">
                  <option v-for="m in modelOptions" :key="m" :value="m"></option>
                </datalist>
                <div v-if="testResult" :class="testOk ? 'key-ok' : 'key-warn'">{{ testResult }}</div>
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
import { ref, reactive, watch, computed } from 'vue'
import { useConfigStore } from '../stores/config'
import { useDialogStore } from '../stores/dialog'
import { APPEARANCE_PRESETS } from '../utils/appearance'

const config = useConfigStore()
const dialog = useDialogStore()
const visible = ref(false)
const tab = ref('instances')
const editingId = ref(null)
const form = ref(null)
const fetchingModels = ref(false)
const modelOptions = ref([])
const testingConn = ref(false)
const testResult = ref('')
const testOk = ref(false)
const keyDecryptFailed = ref(false)

// 测试连接：拉模型列表验证地址+密钥（不消耗对话 token）
async function testConn() {
  const f = form.value
  if (!f.baseUrl) return alert('请先填写请求地址')
  testingConn.value = true
  testResult.value = ''
  try {
    const t0 = Date.now()
    const res = await window.api.aiListModels({
      protocol: f.protocol === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: f.baseUrl.trim(),
      apiKey: formApiKey()
    })
    const ms = Date.now() - t0
    if (res.ok) {
      testOk.value = true
      testResult.value = `✓ 连接成功（${ms}ms），密钥有效，返回 ${res.models.length} 个模型`
    } else {
      testOk.value = false
      testResult.value = '✗ ' + res.error
    }
  } catch (e) {
    testOk.value = false
    testResult.value = '✗ ' + e.message
  } finally {
    testingConn.value = false
  }
}

// 外观草稿（即时生效）
const draftAccent = ref('#3fdc97')
const draftText = ref('#d8dce4')
const draftHue = ref(222)
const draftAlpha = ref(100)
const draftFs = ref(14)
const draftTermBg = ref('')
const draftTermFg = ref('')
const draftEffect = ref('none')

const EFFECTS = [
  { value: 'none', label: '不透明' },
  { value: 'acrylic', label: '磨砂玻璃' },
  { value: 'transparent', label: '真透明' }
]

function syncDrafts() {
  const a = config.appearance
  draftAccent.value = a?.accent || '#3fdc97'
  draftText.value = a?.text || '#d8dce4'
  draftHue.value = a?.bgHue ?? 222
  draftAlpha.value = a?.bgAlpha ?? 100
  draftFs.value = a?.termFontSize ?? 14
  draftTermBg.value = a?.termBg || ''
  draftTermFg.value = a?.termFg || ''
  draftEffect.value = a?.windowEffect || 'none'
}
watch(tab, (t) => { if (t === 'appearance') syncDrafts() })

async function updateAppearance(effectChanged = false) {
  const effect = draftEffect.value
  const a = {
    accent: draftAccent.value,
    text: draftText.value,
    bgHue: draftHue.value,
    bgAlpha: draftAlpha.value,
    termFontSize: draftFs.value,
    termBg: draftTermBg.value,
    termFg: draftTermFg.value,
    windowEffect: effect
  }
  config.appearance = a
  config.save()
  if (!effectChanged) return
  // 窗口效果是原生窗口属性（transparent/backgroundMaterial 创建后不可热切换）。
  // 切到"不透明"可即时生效无需重启；其余变化弹窗让用户选立即重启还是下次启动生效
  if (effect === 'none') {
    config.runtimeEffect = 'none'
    dialog.showToast('已切换为不透明')
    return
  }
  if (effect !== config.runtimeEffect) {
    const choice = await dialog.askChoice({
      title: '窗口效果需要重启应用',
      message: `「${EFFECTS.find((e) => e.value === effect)?.label || effect}」是系统级窗口效果，重启后才能完整生效。已保存设置。`,
      options: [
        { value: 'now', label: '重新打开', kind: 'primary' },
        { value: 'later', label: '下次打开时应用' }
      ]
    })
    if (choice === 'now') window.api.appRelaunch()
    // 选"下次打开时应用"：配置已保存，本次渲染继续按旧效果（App.vue 的 effectiveEffect 不动）
  }
}
function applyPreset(p) {
  draftAccent.value = p.accent
  draftText.value = p.text
  draftHue.value = p.bgHue
  updateAppearance()
}
function isPresetActive(p) {
  const a = config.appearance
  return a && a.accent === p.accent && a.bgHue === p.bgHue
}
function resetAppearance() {
  config.appearance = null
  config.save()
  syncDrafts()
  config.runtimeEffect = 'none' // 恢复默认即不透明，可直接生效无需重启
  dialog.showToast('已恢复默认外观')
}

// ---------- 数据目录 ----------
const dataDir = ref('（读取中…）')
const recordDirShown = ref('（读取中…）')
async function refreshDataDir() {
  try { dataDir.value = await window.api.dataDir() } catch { dataDir.value = '（获取失败）' }
  recordDirShown.value = config.recordDir || (await window.api.recordingsDefaultDir().catch(() => '')) + '（默认）'
}
async function changeRecordDir() {
  const v = await dialog.askInput({ title: '录制保存目录（绝对路径）', value: config.recordDir || (await window.api.recordingsDefaultDir().catch(() => '')) })
  if (!v || !v.trim()) return
  config.recordDir = v.trim()
  await config.save()
  recordDirShown.value = config.recordDir
  dialog.showToast('录制保存位置已更新')
}
async function resetRecordDir() {
  config.recordDir = ''
  await config.save()
  recordDirShown.value = (await window.api.recordingsDefaultDir().catch(() => '')) + '（默认）'
}
async function openDataDir() {
  await window.api.dataOpen()
}
async function changeDataDir() {
  const r = await window.api.dataChange()
  if (r.canceled) return
  if (r.ok) setTimeout(() => window.api.appRelaunch(), 600)
  else alert('更改失败：' + (r.error || '未知错误'))
}
async function resetDataDir() {
  await window.api.dataReset()
  setTimeout(() => window.api.appRelaunch(), 600)
}

// ---------- 技能 ----------
function newSkill() {
  editingId.value = null
  form.value = { id: null, name: '', description: '', content: '', enabled: true }
}
function startEditSkill(s) {
  editingId.value = s.id
  form.value = { ...s }
}

// ---------- 流水线 ----------
function newPipeline() {
  editingId.value = null
  form.value = { id: null, name: '', steps: [] }
}
function startEditPipeline(p) {
  editingId.value = p.id
  form.value = JSON.parse(JSON.stringify({ ...p, steps: p.steps.length ? p.steps : [] }))
}
function moveStep(i, dir) {
  const steps = form.value.steps
  const j = i + dir
  if (j < 0 || j >= steps.length) return
  ;[steps[i], steps[j]] = [steps[j], steps[i]]
}
async function savePipeline() {
  const f = form.value
  if (!f.name || !f.name.trim()) return alert('流水线名称不能为空')
  const steps = f.steps.filter((s) => s.skillId)
  if (!steps.length) return alert('至少添加一个步骤并选择技能')
  const data = {
    id: f.id || config.newPipelineId(),
    name: f.name.trim(),
    steps: steps.map((s) => ({ skillId: s.skillId, checkpoint: s.checkpoint !== false }))
  }
  const idx = config.pipelines.findIndex((p) => p.id === data.id)
  if (idx >= 0) config.pipelines[idx] = data
  else config.pipelines.push(data)
  await config.save()
  dialog.showToast('流水线已保存')
  form.value = null
  editingId.value = null
}
async function removePipelineCurrent() {
  const id = editingId.value
  if (!id) return
  if (!confirm('确定删除该流水线？')) return
  config.pipelines = config.pipelines.filter((p) => p.id !== id)
  await config.save()
  form.value = null
  editingId.value = null
}
async function saveSkill() {
  const f = form.value
  if (!f.name || !f.content) {
    alert('技能名称和内容不能为空')
    return
  }
  const data = {
    id: f.id || config.newSkillId(),
    name: f.name.trim(),
    description: (f.description || '').trim(),
    content: f.content,
    enabled: f.enabled !== false
  }
  const idx = config.skills.findIndex((s) => s.id === data.id)
  if (idx >= 0) config.skills[idx] = data
  else config.skills.push(data)
  await config.save()
  dialog.showToast('技能已保存')
  close() // 保存成功离开编辑界面
}
async function removeSkillCurrent() {
  const id = editingId.value
  if (!id) return
  if (!confirm('确定删除该技能？')) return
  config.skills = config.skills.filter((s) => s.id !== id)
  await config.save()
  form.value = null
  editingId.value = null
}

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
  if (name === 'data') refreshDataDir()
}

// ---------- 实例 ----------
const pwLocked = ref(false) // 已存密码锁定态：编辑时不回显明文，只能重置重填
const passwordDecryptFailed = ref(false)

// 锁定态下保存：沿用原密码（form.password 是 __locked__ 占位，不是真值）
function savedInstancePassword(id) {
  return config.instances.find((i) => i.id === id)?.password || ''
}

function newInstance() {
  editingId.value = null
  pwLocked.value = false
  passwordDecryptFailed.value = false
  form.value = { id: null, name: '', host: '', port: 22, username: 'root', password: '' }
}
function startEdit(inst) {
  editingId.value = inst.id
  // 解密失败哨兵：不锁定、清空待重填，给出醒目提示
  passwordDecryptFailed.value = inst.password === '\u0000DECRYPT_FAILED'
  pwLocked.value = !!inst.password && !passwordDecryptFailed.value
  form.value = { ...inst, password: pwLocked.value ? '__locked__' : '' }
}
function unlockPassword() {
  pwLocked.value = false
  form.value.password = ''
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
    password: f.password === '__locked__' ? savedInstancePassword(f.id || editingId.value) : (f.password || '')
  }
  const idx = config.instances.findIndex((i) => i.id === data.id)
  if (idx >= 0) config.instances[idx] = data
  else config.instances.push(data)
  await config.save()
  dialog.showToast('服务器配置已保存')
  close() // 保存成功离开编辑界面
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
const keyLocked = ref(false) // 已存密钥锁定态：编辑时不回显明文，只能重置重填

// 锁定态下测试/保存用的真 key（form.apiKey 是 __locked__ 占位）
function savedProviderKey(id) {
  return config.aiProviders.find((p) => p.id === id)?.apiKey || ''
}
function formApiKey() {
  const f = form.value
  return f.apiKey === '__locked__' ? savedProviderKey(f.id || editingId.value) : (f.apiKey || '')
}

function newProvider() {
  editingId.value = null
  modelOptions.value = []
  keyDecryptFailed.value = false
  keyLocked.value = false
  form.value = { id: null, name: '', protocol: 'openai', baseUrl: '', apiKey: '', model: '' }
}
function startEditProvider(p) {
  editingId.value = p.id
  modelOptions.value = p.model ? [p.model] : []
  // 密钥解密失败：提示重填并清空哨兵值；正常则锁定不回显
  keyDecryptFailed.value = p.apiKey === '\u0000DECRYPT_FAILED'
  keyLocked.value = !!p.apiKey && !keyDecryptFailed.value
  form.value = { protocol: 'openai', ...p, apiKey: keyLocked.value ? '__locked__' : '' } // 老配置默认 OpenAI 协议
  testResult.value = ''
}
function unlockKey() {
  keyLocked.value = false
  form.value.apiKey = ''
}
async function saveProvider() {
  const f = form.value
  if (!f.name || !f.baseUrl) {
    alert('名称和请求地址不能为空')
    return
  }
  if (keyDecryptFailed.value && !formApiKey()) {
    alert('原密钥已失效（解密失败），请重新填写 API Key 再保存')
    return
  }
  const data = {
    id: f.id || config.newProviderId(),
    name: f.name.trim(),
    protocol: f.protocol === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: f.baseUrl.trim(),
    apiKey: formApiKey(),
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
  dialog.showToast('AI 配置已保存')
  close() // 保存成功离开编辑界面
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
    const res = await window.api.aiListModels({ protocol: f.protocol === 'anthropic' ? 'anthropic' : 'openai', baseUrl: f.baseUrl, apiKey: formApiKey() })
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
.pl-steps { display: flex; flex-direction: column; gap: 6px; }
.pl-step { display: flex; align-items: center; gap: 6px; }
.pl-step .ghost { font-size: 11px; padding: 3px 8px; }
.pl-idx { width: 16px; text-align: right; flex-shrink: 0; font-size: 11px; }
.pl-ck { display: flex; align-items: center; gap: 3px; font-size: 11px; cursor: pointer; flex-shrink: 0; white-space: nowrap; color: var(--text-dim); }
.preset-card {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12px;
  transition: border-color 0.12s;
}
.preset-card:hover { border-color: var(--border-strong); }
.preset-card.on { border-color: var(--green); color: var(--green); }
.preset-dot { width: 12px; height: 12px; border-radius: 50%; }
.key-warn {
  color: var(--amber);
  font-size: 12px;
  background: var(--amber-dim);
  border: 1px solid rgba(242, 177, 85, 0.35);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
}
.key-ok {
  color: var(--green);
  font-size: 12px;
  background: var(--green-dim);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
}
.locked-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.locked-box {
  flex: 1;
  padding: 6px 10px;
  font-size: 12.5px;
  color: var(--text-faint);
  background: var(--bg0);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
}
</style>
