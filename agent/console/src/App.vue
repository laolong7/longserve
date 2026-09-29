<template>
  <div class="shell">
    <!-- ============ 绑定门：未绑定 ============ -->
    <div v-if="!bound" class="gate">
      <div class="gate-card panel">
        <div class="gate-logo">
          <span class="core"></span>
          <span class="orbit"></span>
        </div>
        <div class="gate-title">Longserve 控制台</div>
        <div class="gate-sub">扫描桌面端生成的二维码即可绑定本服务器</div>
        <div v-if="gateError" class="gate-err">{{ gateError }}</div>
        <button class="primary gate-btn" @click="retryBind">重新连接</button>
        <button class="gate-unbind" @click="manualToken">手动输入密钥</button>
      </div>
    </div>

    <!-- ============ 主界面 ============ -->
    <template v-else>
      <header class="topbar">
        <div class="srv">
          <span class="dot" :class="{ off: !online }"></span>
          <span class="mono srv-name">{{ serverName }}</span>
        </div>
        <div class="meta mono">LAGENT v{{ agentVersion }}</div>
      </header>

      <div v-if="pendingList.length" class="pending-bar" @click="switchTab('chat')">
        ⚠ 有 {{ pendingList.length }} 条危险命令等待确认，点击处理
      </div>

      <main class="content">
        <StatusView v-show="tab === 'status'" />
        <ChatView v-show="tab === 'chat'" ref="chatRef" @pending="refreshPending" />
        <ExecView v-show="tab === 'exec'" :hostname="serverName" />
      </main>

      <nav class="tabbar">
        <div
          v-for="t in TABS"
          :key="t.id"
          class="tab"
          :class="{ on: tab === t.id }"
          role="button"
          :aria-label="t.label"
          tabindex="0"
          @click="switchTab(t.id)"
          @keydown.enter="switchTab(t.id)"
        >
          <span class="tab-ico">{{ t.ico }}</span>
          <span class="tab-label">{{ t.label }}</span>
        </div>
      </nav>
    </template>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { api, setToken, hasToken, forgetToken } from './api'
import StatusView from './views/StatusView.vue'
import ChatView from './views/ChatView.vue'
import ExecView from './views/ExecView.vue'

const TABS = [
  { id: 'status', ico: '◈', label: '概览' },
  { id: 'chat', ico: '✦', label: 'AI' },
  { id: 'exec', ico: '❯', label: '指令' }
]

const bound = ref(false)
const gateError = ref('')
const online = ref(false)
const serverName = ref('…')
const agentVersion = ref('')
const tab = ref('status')
const pendingList = ref([])
const chatRef = ref(null)

let pollTimer = null

async function tryBind() {
  gateError.value = ''
  if (!hasToken()) {
    gateError.value = '未检测到绑定密钥，请通过桌面端生成的二维码进入'
    return
  }
  try {
    const r = await api.bind()
    if (r.ok) {
      bound.value = true
      serverName.value = r.server.hostname
      agentVersion.value = r.agentVersion
      online.value = true
      startPoll()
    } else {
      gateError.value = r.error || '绑定失败'
    }
  } catch (err) {
    gateError.value = err.code === 401 ? '密钥无效或已被重置，请重新扫码' : '无法连接 Agent：' + err.message
  }
}

function retryBind() {
  forgetToken()
  const t = prompt('粘贴绑定密钥（扫码链接 ?token= 后面那串）')
  if (t) setToken(t)
  tryBind()
}

function manualToken() {
  const t = prompt('粘贴绑定密钥')
  if (t && t.trim()) {
    setToken(t)
    tryBind()
  }
}

function switchTab(id) {
  tab.value = id
}

async function refreshPending() {
  try {
    const r = await api.pending()
    if (r.ok) pendingList.value = r.pending
  } catch { /* 断线时轮询会统一处理 */ }
}

async function pollStatus() {
  try {
    const r = await api.status()
    if (r.ok) {
      online.value = true
      serverName.value = r.status.hostname
      pendingList.value = r.pending || []
    }
  } catch {
    online.value = false
  }
}

function startPoll() {
  pollStatus()
  refreshPending()
  clearInterval(pollTimer)
  pollTimer = setInterval(pollStatus, 5000)
}

onMounted(() => {
  // 扫码进入：URL 带 ?token=xxx，优先采用并清掉地址栏参数
  const q = new URLSearchParams(location.search)
  if (q.get('token')) {
    setToken(q.get('token'))
    history.replaceState(null, '', '/')
  }
  tryBind()
})

onUnmounted(() => clearInterval(pollTimer))
</script>

<style scoped>
.shell { height: 100%; display: flex; flex-direction: column; }

/* ---------- 绑定门 ---------- */
.gate { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; }
.gate-card { width: 100%; max-width: 340px; padding: 36px 28px; text-align: center; animation: slideUp 0.3s ease; }
.gate-logo { position: relative; width: 74px; height: 74px; margin: 0 auto 18px; }
.core {
  position: absolute; inset: 22px;
  background: radial-gradient(circle at 35% 30%, #9be8f5, var(--cyan) 55%, #2b7f93);
  border-radius: 50%;
  box-shadow: 0 0 18px rgba(92, 207, 230, 0.55);
  animation: breathe 2.6s ease-in-out infinite;
}
.orbit {
  position: absolute; inset: 0;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  border-top-color: transparent;
  border-bottom-color: transparent;
  transform: rotate(30deg);
}
.gate-title { font-size: 19px; font-weight: 700; letter-spacing: 1px; }
.gate-sub { color: var(--text-dim); font-size: 12.5px; margin: 8px 0 18px; line-height: 1.6; }
.gate-err { color: var(--amber); font-size: 12.5px; background: var(--amber-dim); border-radius: 8px; padding: 8px 10px; margin-bottom: 14px; }
.gate-btn { width: 100%; padding: 11px; }
.gate-unbind { width: 100%; margin-top: 8px; background: transparent; border-color: transparent; color: var(--text-faint); font-size: 12.5px; }

/* ---------- 顶栏 ---------- */
.topbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: calc(env(safe-area-inset-top, 0px) + 10px) 14px 10px;
  border-bottom: 1px solid var(--border);
  background: rgba(14, 17, 22, 0.82);
  backdrop-filter: blur(8px);
  flex-shrink: 0;
  position: relative;
}
/* 顶栏底部游走的扫描光（科幻仪表感，细而克制） */
.topbar::after {
  content: '';
  position: absolute; left: 0; right: 0; bottom: -1px; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(92, 207, 230, 0.5), transparent);
  background-size: 120px 100%;
  background-repeat: no-repeat;
  animation: topScan 5s linear infinite;
}
@keyframes topScan {
  0% { background-position: -140px 0; }
  100% { background-position: calc(100% + 140px) 0; }
}
.srv { display: flex; align-items: center; gap: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px var(--green); animation: breathe 2.4s ease-in-out infinite; }
.dot.off { background: var(--red); box-shadow: 0 0 8px var(--red); animation: none; }
.srv-name { font-size: 14px; font-weight: 600; }
.meta { font-size: 10.5px; color: var(--text-faint); }

.pending-bar {
  padding: 9px 14px;
  background: var(--amber-dim);
  color: var(--amber);
  font-size: 12.5px;
  border-bottom: 1px solid rgba(242, 177, 85, 0.3);
  cursor: pointer;
  flex-shrink: 0;
}

.content { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }

/* ---------- 底部导航 ---------- */
.tabbar {
  display: flex;
  border-top: 1px solid var(--border);
  background: rgba(14, 17, 22, 0.9);
  backdrop-filter: blur(8px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  flex-shrink: 0;
}
.tab {
  flex: 1;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 8px 0 7px;
  color: var(--text-faint);
  cursor: pointer;
  position: relative;
}
/* 选中页签：顶部亮线 + 图标发光 */
.tab.on { color: var(--cyan); }
.tab.on::before {
  content: '';
  position: absolute; top: -1px; left: 22%; right: 22%; height: 2px;
  background: linear-gradient(90deg, transparent, var(--cyan), transparent);
  border-radius: 1px;
}
.tab.on .tab-ico { filter: drop-shadow(0 0 6px rgba(92, 207, 230, 0.7)); }
.tab-ico { font-size: 17px; line-height: 1; }
.tab-label { font-size: 10.5px; }
.tab:focus-visible { outline: 1px solid var(--border-strong); outline-offset: -2px; }
</style>
