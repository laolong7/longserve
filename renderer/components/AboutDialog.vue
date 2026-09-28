<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-mask" @click.self="close">
      <div class="modal about-modal">
        <div class="about-head">
          <span class="about-logo">◆</span>
          <div class="about-title-wrap">
            <div class="about-title">Laolong Server Utilities</div>
            <div class="about-sub">带 AI 副驾的服务器终端管理工具</div>
          </div>
          <span class="about-ver mono">v{{ info.version || '…' }}</span>
          <button class="ghost" @click="close">✕</button>
        </div>

        <div class="about-body">
          <!-- 开源信息 -->
          <div class="about-card open-line">
            <span class="tag">开源项目</span>
            作者 <b>Laolong</b> · 基于 MIT 协议在 GitHub 开源：
            <a class="mono" href="#" @click.prevent="openRepo">github.com/laolong7/laolong-server-utilities</a>
            <span class="faint">（占位链接）</span>
          </div>

          <!-- 架构分层 -->
          <div class="about-card">
            <div class="card-title">架构：四层隔离，安全优先</div>
            <div class="arch">
              <div class="arch-layer" v-for="(l, i) in ARCH" :key="l.name">
                <div class="arch-box" :style="{ borderColor: l.color }">
                  <span class="arch-name">{{ l.name }}</span>
                  <span class="arch-desc">{{ l.desc }}</span>
                </div>
                <div v-if="i < ARCH.length - 1" class="arch-arrow">↕</div>
              </div>
            </div>
            <div class="faint" style="font-size:11px; margin-top:6px">
              渲染层不接触网络与文件系统；一切敏感操作经主进程白名单 IPC 执行，密码与密钥全程 DPAPI 加密。
            </div>
          </div>

          <!-- 技术栈 -->
          <div class="about-card">
            <div class="card-title">技术栈</div>
            <div class="stack">
              <span class="stack-item" v-for="s in STACK" :key="s.name" :title="s.desc">
                <b>{{ s.name }}</b><span class="faint">{{ s.ver }}</span>
              </span>
            </div>
          </div>

          <!-- 代码构成图表（单序列水平条，直接标注） -->
          <div class="about-card">
            <div class="card-title">代码构成 <span class="faint" style="font-weight:400">（约 5.4k 行）</span></div>
            <div class="chart">
              <div class="chart-row" v-for="r in CODE" :key="r.name" :title="`${r.name}：${r.val} 行`">
                <span class="chart-label">{{ r.name }}</span>
                <div class="chart-track">
                  <div class="chart-bar" :style="{ width: (r.val / CODE_MAX * 100) + '%' }"></div>
                </div>
                <span class="chart-val mono">{{ r.val }}</span>
              </div>
            </div>
          </div>

          <!-- 功能亮点 -->
          <div class="about-card">
            <div class="card-title">功能亮点</div>
            <div class="feats">
              <div class="feat" v-for="f in FEATS" :key="f.t">
                <span class="feat-icon">{{ f.icon }}</span>
                <div>
                  <div class="feat-t">{{ f.t }}</div>
                  <div class="feat-d">{{ f.d }}</div>
                </div>
              </div>
            </div>
          </div>

          <div class="about-foot faint">
            牢笼 & 逐光 出品 · Electron {{ info.electron || '…' }} · {{ platformName }}
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, onMounted } from 'vue'

const visible = ref(false)
const info = ref({})
const GITHUB = 'https://github.com/laolong7/laolong-server-utilities' // TODO: 仓库建好后替换为真实地址

const ARCH = [
  { name: '界面层', desc: 'Vue 3 + Pinia（渲染进程，零特权）', color: 'var(--violet)' },
  { name: '安全桥', desc: 'contextBridge 白名单 IPC（contextIsolation 隔离）', color: 'var(--blue)' },
  { name: '主进程', desc: 'Electron Node.js：窗口 / 配置加密存储 / 看门狗', color: 'var(--green)' },
  { name: '连接层', desc: 'ssh2 终端流 · SFTP 传输 · AI 网关（SSE 双协议）', color: 'var(--amber)' }
]

const STACK = [
  { name: 'Electron', ver: '44', desc: '桌面壳与多窗口' },
  { name: 'Vue', ver: '3.5', desc: '界面框架' },
  { name: 'Pinia', ver: '3', desc: '状态管理' },
  { name: 'xterm.js', ver: '5.5', desc: '终端仿真' },
  { name: 'ssh2', ver: '1.17', desc: 'SSH/SFTP 协议实现' },
  { name: 'Vite', ver: '7', desc: '构建工具' },
  { name: 'DPAPI', ver: '', desc: 'Windows 系统级加密存储' }
]

// 代码构成（行数为 2026-09-28 统计口径）
const CODE = [
  { name: '界面组件', val: 2870 },
  { name: '主进程', val: 1431 },
  { name: '状态与工具', val: 1126 }
]
const CODE_MAX = Math.max(...CODE.map((c) => c.val))

const FEATS = [
  { icon: '◆', t: 'AI 副驾', d: '流式对话 + 思考过程可视化，工具调用直达终端 / 本机 / SFTP，自定义技能注入' },
  { icon: '⧉', t: '多开与并列', d: '多窗口自动平铺，双终端上下并列各占一半' },
  { icon: '⇅', t: 'SFTP 文件管理', d: '双向传输、进度实时、断点取消，文件夹递归' },
  { icon: '⚠', t: '危险命令拦截', d: '规则清单 + AI 自评双保险，删除重启前必弹确认' },
  { icon: '🕘', t: '历史会话', d: 'AI 对话自动落盘，可搜索、可一键恢复上下文' },
  { icon: '🎨', t: '外观系统', d: '色相 / 透明度 / 磨砂 / 真透明 / 终端主题，全站实时联动' },
  { icon: '🔒', t: '密钥保险箱', d: '密码与 API Key 加密落盘，界面不回显，支持一键重置' },
  { icon: '🛡', t: '超时看门狗', d: '首响应 / 流空闲 / 总时长三重保险，永不永久转圈' }
]

const platformName = ref('Windows')
onMounted(async () => {
  try {
    info.value = await window.api.appInfo()
    platformName.value = info.value.platform === 'darwin' ? 'macOS' : info.value.platform === 'linux' ? 'Linux' : 'Windows'
  } catch { /* 版本信息拿不到不影响浏览 */ }
})

function open() {
  visible.value = true
}
function close() {
  visible.value = false
}
function openRepo() {
  window.api.openExternal(GITHUB)
}
defineExpose({ open })
</script>

<style scoped>
.about-modal { width: 600px; max-height: 86vh; }
.about-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--border);
}
.about-logo { font-size: 26px; color: var(--green); }
.about-title { font-size: 15px; font-weight: 600; }
.about-sub { font-size: 11.5px; color: var(--text-faint); margin-top: 2px; }
.about-ver {
  margin-left: auto;
  font-size: 11px;
  color: var(--green);
  background: var(--green-dim);
  border-radius: 10px;
  padding: 2px 9px;
}
.about-body { padding: 14px 18px 18px; overflow-y: auto; }
.about-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg0);
  padding: 12px 14px;
  margin-bottom: 12px;
}
.open-line { font-size: 12.5px; line-height: 1.8; }
.open-line .tag {
  font-size: 10.5px;
  color: var(--green);
  background: var(--green-dim);
  border-radius: 8px;
  padding: 1px 8px;
  margin-right: 6px;
}
.open-line a { color: var(--blue); text-decoration: none; }
.open-line a:hover { text-decoration: underline; }
.card-title { font-size: 12.5px; font-weight: 600; margin-bottom: 10px; }

/* 架构分层图 */
.arch { display: flex; flex-direction: column; align-items: stretch; }
.arch-layer { display: flex; flex-direction: column; align-items: center; }
.arch-box {
  width: 100%;
  display: flex;
  align-items: baseline;
  gap: 10px;
  border: 1px solid var(--border-strong);
  border-left-width: 3px;
  border-radius: var(--radius-sm);
  padding: 7px 12px;
  background: var(--bg1);
}
.arch-name { font-size: 12.5px; font-weight: 600; flex-shrink: 0; }
.arch-desc { font-size: 11px; color: var(--text-dim); }
.arch-arrow { color: var(--text-faint); font-size: 11px; line-height: 1.4; }

/* 技术栈徽章 */
.stack { display: flex; flex-wrap: wrap; gap: 7px; }
.stack-item {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  font-size: 11.5px;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 3px 10px;
  background: var(--bg1);
  cursor: default;
}
.stack-item b { font-size: 12px; }

/* 代码构成条形图：单色系、thin bar、直接标注 */
.chart { display: flex; flex-direction: column; gap: 8px; }
.chart-row { display: flex; align-items: center; gap: 10px; }
.chart-label { width: 76px; flex-shrink: 0; font-size: 11.5px; color: var(--text-dim); text-align: right; }
.chart-track { flex: 1; height: 10px; }
.chart-bar {
  height: 100%;
  min-width: 2px;
  background: var(--green);
  border-radius: 0 4px 4px 0;
  opacity: 0.85;
}
.chart-row:hover .chart-bar { opacity: 1; }
.chart-val { width: 40px; font-size: 11px; color: var(--text-dim); }

/* 功能亮点 */
.feats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.feat { display: flex; gap: 9px; align-items: flex-start; }
.feat-icon { font-size: 14px; line-height: 1.3; }
.feat-t { font-size: 12px; font-weight: 600; }
.feat-d { font-size: 11px; color: var(--text-faint); line-height: 1.55; margin-top: 1px; }
.about-foot { text-align: center; font-size: 11px; padding-top: 2px; }
</style>
