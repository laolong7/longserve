<template>
  <div class="page">
    <div v-if="st" class="wrap">
      <!-- ===== 心跳检测（签名卡）：连接性 ECG + CPU 活动 ===== -->
      <div class="panel card beat-card" :class="beatState">
        <div class="beat-head">
          <div class="beat-title">
            <span class="beat-core"></span>
            <span>心跳检测</span>
          </div>
          <div class="beat-stats mono">
            <span class="beat-rtt">{{ lastRttText }}</span>
            <span class="beat-sep">·</span>
            <span>{{ beatLabel }}</span>
          </div>
        </div>
        <canvas ref="ecgEl" class="ecg" height="72"></canvas>
        <div class="beat-foot mono">
          <span>CPU 活动 <b :class="cpuAlive ? 'ok' : 'bad'">{{ cpuAlive ? '正常' : '异常' }}</b></span>
          <span>连续 {{ streak }} 拍</span>
          <span>每 2s 一拍</span>
        </div>
      </div>

      <!-- ===== CPU 环形仪表 + 内存/负载 ===== -->
      <div class="grid-top">
        <div class="panel card cpu-card">
          <RingGauge :percent="st.cpu.usage" label="CPU" :color="gaugeColor(st.cpu.usage)" />
          <div class="cpu-sub mono">{{ st.cpu.cores }}C · {{ st.cpu.loadavg[0] }} {{ st.cpu.loadavg[1] }} {{ st.cpu.loadavg[2] }}</div>
        </div>
        <div class="col">
          <div class="panel card">
            <div class="bar-head"><span>内存</span><span class="mono">{{ st.mem.percent }}%</span></div>
            <div class="bar"><i :style="{ width: st.mem.percent + '%', background: gaugeColor(st.mem.percent) }"></i></div>
            <div class="bar-sub mono">{{ fmtB(st.mem.used) }} / {{ fmtB(st.mem.total) }}</div>
          </div>
          <div class="panel card">
            <div class="bar-head"><span>网络 I/O</span><span class="mono dim">{{ st.net ? '实时' : '不可用' }}</span></div>
            <div class="net-rows mono">
              <div class="net-row"><span class="net-ico down">↓</span><span>{{ st.net ? fmtRate(st.net.rxPerSec) : '-' }}</span></div>
              <div class="net-row"><span class="net-ico up">↑</span><span>{{ st.net ? fmtRate(st.net.txPerSec) : '-' }}</span></div>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== 运行时长 / 进程 ===== -->
      <div class="panel card">
        <div class="bar-head"><span>运行时长</span><span class="mono">{{ uptimeText }}</span></div>
        <div class="bar-sub mono dim">{{ st.platform }} {{ st.release }} · {{ st.arch }}<template v-if="st.procs"> · 进程 {{ st.procs }}</template></div>
      </div>

      <!-- ===== 磁盘 ===== -->
      <div class="panel card" v-for="d in st.disks" :key="d.mount">
        <div class="bar-head"><span class="mono">{{ d.mount }}</span><span class="mono">{{ d.percent }}%</span></div>
        <div class="bar"><i :style="{ width: d.percent + '%', background: gaugeColor(d.percent) }"></i></div>
        <div class="bar-sub mono">剩 {{ fmtB(d.free) }} / 共 {{ fmtB(d.total) }}</div>
      </div>

      <!-- ===== Top 进程 ===== -->
      <div class="panel card" v-if="st.top && st.top.length">
        <div class="bar-head"><span>Top 进程</span><span class="mono dim">按 CPU</span></div>
        <div class="proc-row mono" v-for="p in st.top" :key="p.pid">
          <span class="proc-name ellipsis">{{ p.name }}</span>
          <span class="proc-num">{{ p.cpu }}%</span>
          <span class="proc-num dim">{{ p.mem }}%</span>
        </div>
      </div>

      <!-- ===== 服务控制 ===== -->
      <div class="panel card">
        <div class="bar-head">
          <span>服务控制</span>
          <button class="mini-btn" @click="loadServices" :disabled="svcLoading">{{ svcLoading ? '加载中…' : '↻ 刷新' }}</button>
        </div>
        <input
          v-model="svcFilter"
          class="svc-search"
          placeholder="筛选服务名 / 描述…"
          spellcheck="false"
          autocomplete="off"
        />
        <div v-if="svcError" class="svc-err">{{ svcError }}</div>
        <div v-else-if="!svcLoading && !svcList.length" class="svc-empty">没有匹配的服务</div>
        <div class="svc-list">
          <div v-for="s in svcList" :key="s.unit" class="svc-row">
            <span class="svc-dot" :class="s.active"></span>
            <div class="svc-info">
              <div class="svc-name mono ellipsis">{{ s.unit }}</div>
              <div class="svc-desc ellipsis">{{ s.desc }}</div>
            </div>
            <div class="svc-acts">
              <button v-if="s.active !== 'active'" class="mini-btn go" @click="svcAct(s, 'start')">启动</button>
              <button v-if="s.active === 'active'" class="mini-btn" @click="svcAct(s, 'restart')">重启</button>
              <button v-if="s.active === 'active'" class="mini-btn warn" @click="svcAct(s, 'stop')">停止</button>
            </div>
          </div>
        </div>
      </div>

      <div class="foot mono">采样于 {{ sampleTime }} · 5s 自动刷新</div>
    </div>
    <div v-else class="empty">正在采集服务器状态…</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { api } from '../api'
import RingGauge from '../components/RingGauge.vue'

const st = ref(null)
let timer = null

// ---------- 心跳检测 ----------
const ecgEl = ref(null)
const beats = ref([]) // { t, rtt|null }，最多 40 拍
const streak = ref(0)
let beatTimer = null
let rafId = 0

const lastBeat = computed(() => (beats.value.length ? beats.value[beats.value.length - 1] : null))
const lastRttText = computed(() => {
  const b = lastBeat.value
  if (!b) return '— ms'
  return b.rtt == null ? '超时' : Math.round(b.rtt) + ' ms'
})
// 在线判定：最近一拍成功 = 在线；最近 3 拍全失败 = 断线；中间 = 波动
const beatState = computed(() => {
  const recent = beats.value.slice(-3)
  if (!recent.length) return 'idle'
  const fails = recent.filter((b) => b.rtt == null).length
  if (fails >= recent.length) return 'down'
  if (fails > 0) return 'wavy'
  return 'live'
})
const beatLabel = computed(() => ({ live: '连接稳定', wavy: '延迟波动', down: '连接中断', idle: '探测中' }[beatState.value] || ''))
// CPU 活动：有采样且 CPU 指标齐全即视为正常（数据不再更新 = 异常）
const cpuAlive = computed(() => {
  if (!st.value || !st.value.cpu) return false
  return Date.now() - (st.value.time || 0) < 30000
})

async function beat() {
  const t0 = performance.now()
  try {
    const r = await api.health()
    const rtt = performance.now() - t0
    if (r && r.ok) {
      beats.value.push({ t: Date.now(), rtt })
      streak.value += 1
    } else {
      beats.value.push({ t: Date.now(), rtt: null })
      streak.value = 0
    }
  } catch {
    beats.value.push({ t: Date.now(), rtt: null })
    streak.value = 0
  }
  if (beats.value.length > 40) beats.value = beats.value.slice(-40)
  drawEcg()
}

// ECG 波形：每拍一个尖峰（延迟越低越挺拔），断线画红线平段
function drawEcg() {
  const canvas = ecgEl.value
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = 72
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr
    canvas.height = h * dpr
  }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  // 底部基线网格（极淡）
  ctx.strokeStyle = 'rgba(92, 207, 230, 0.10)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, h - 8)
  ctx.lineTo(w, h - 8)
  ctx.stroke()

  const list = beats.value
  if (!list.length) return
  const step = w / 40 // 最多 40 拍占满画布
  const base = h - 10
  const off = (40 - list.length) * step // 从右侧往左长出来

  for (let i = 0; i < list.length; i++) {
    const x = off + i * step
    const b = list[i]
    const alive = b.rtt != null
    // 尖峰幅度：延迟 0ms→48px，500ms→12px；断线→小平段
    const amp = alive ? Math.max(12, 48 - Math.min(b.rtt, 500) / 12) : 2
    const prevX = i > 0 ? off + (i - 1) * step : x - step
    const prev = i > 0 ? list[i - 1] : { rtt: null }
    const prevAmp = prev.rtt != null ? Math.max(12, 48 - Math.min(prev.rtt, 500) / 12) : 2

    const grad = ctx.createLinearGradient(prevX, 0, x, 0)
    const color = alive ? 'rgba(92, 207, 230, 0.9)' : 'rgba(242, 85, 90, 0.9)'
    grad.addColorStop(0, alive ? 'rgba(92, 207, 230, 0.45)' : 'rgba(242, 85, 90, 0.45)')
    grad.addColorStop(1, color)
    ctx.strokeStyle = grad
    ctx.lineWidth = alive ? 1.8 : 2.2
    ctx.shadowColor = color
    ctx.shadowBlur = alive ? 6 : 8

    ctx.beginPath()
    if (alive) {
      // ECG 形：升 → 尖 → 降（对称三角）
      ctx.moveTo(prevX, base - prevAmp / 3)
      ctx.lineTo(x - step * 0.35, base)
      ctx.lineTo(x, base - amp)
      ctx.lineTo(x + step * 0.35, base)
    } else {
      ctx.moveTo(prevX, base - 1)
      ctx.lineTo(x, base - 1)
    }
    ctx.stroke()
    ctx.shadowBlur = 0

    // 最新一拍的辉光点
    if (i === list.length - 1) {
      ctx.beginPath()
      ctx.fillStyle = alive ? '#5ccfe6' : '#f2555a'
      ctx.shadowColor = ctx.fillStyle
      ctx.shadowBlur = 10
      ctx.arc(x, alive ? base - amp : base - 1, 3, 0, Math.PI * 2)
      ctx.fill()
      ctx.shadowBlur = 0
    }
  }
}

// ---------- 状态刷新 ----------
async function refresh() {
  try {
    const r = await api.status()
    if (r.ok) st.value = r.status
  } catch { /* 顶栏/心跳已反映断线 */ }
}

function gaugeColor(p) {
  if (p >= 90) return 'var(--red)'
  if (p >= 75) return 'var(--amber)'
  return 'var(--cyan)'
}

function fmtB(b) {
  if (b == null) return '-'
  if (b > 1073741824) return (b / 1073741824).toFixed(1) + 'G'
  if (b > 1048576) return Math.round(b / 1048576) + 'M'
  return Math.round(b / 1024) + 'K'
}

function fmtRate(n) {
  if (n == null) return '-'
  if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB/s'
  if (n > 1024) return Math.round(n / 1024) + ' KB/s'
  return n + ' B/s'
}

const uptimeText = computed(() => {
  if (!st.value) return '-'
  const s = st.value.uptime
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  return d > 0 ? `${d} 天 ${h} 时` : `${h} 时 ${Math.floor((s % 3600) / 60)} 分`
})

const sampleTime = computed(() => (st.value ? new Date(st.value.time).toLocaleTimeString('zh-CN') : '-'))

// ---------- 服务控制 ----------
const svcAll = ref([])
const svcLoading = ref(false)
const svcError = ref('')
const svcFilter = ref('')

const svcList = computed(() => {
  const kw = svcFilter.value.trim().toLowerCase()
  const arr = kw
    ? svcAll.value.filter((s) => s.unit.toLowerCase().includes(kw) || (s.desc || '').toLowerCase().includes(kw))
    : svcAll.value
  return arr.slice(0, 50) // 手机上渲染上限，防长列表卡顿
})

async function loadServices() {
  svcLoading.value = true
  svcError.value = ''
  try {
    const r = await api.services()
    if (r.ok) {
      const fresh = r.services || []
      if (!svcAll.value.length) {
        svcAll.value = fresh
      } else {
        // 就地合并：既有条目原位更新状态（停止的服务不跳走），消失的移除，新增的追加到末尾
        const byName = new Map(fresh.map((s) => [s.unit, s]))
        const merged = []
        for (const s of svcAll.value) {
          const cur = byName.get(s.unit)
          if (cur) {
            merged.push(cur)
            byName.delete(s.unit)
          }
        }
        for (const rest of byName.values()) merged.push(rest)
        svcAll.value = merged
      }
    } else svcError.value = r.error || '加载失败'
  } catch (err) {
    svcError.value = '加载失败：' + (err.message || err)
  } finally {
    svcLoading.value = false
  }
}

async function svcAct(s, op) {
  const opText = { start: '启动', stop: '停止', restart: '重启' }[op] || op
  if (!window.confirm(`确定${opText}服务 ${s.unit}？`)) return
  try {
    const r = await api.serviceAction(s.unit, op, true)
    if (!r.ok) {
      window.alert('操作失败：' + (r.error || '未知错误'))
      return
    }
    // 就地更新状态：条目留在原位，停止后变「关闭」并出现启动按钮（不整表重排）
    s.active = op === 'stop' ? 'inactive' : 'active'
    s.sub = op === 'stop' ? 'dead' : 'running'
    if (op === 'start') s.desc = s.desc || '（已安装，未运行）'
  } catch (err) {
    window.alert('操作失败：' + (err.message || err))
  }
}

// ---------- 生命周期 ----------
function onResize() {
  cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(drawEcg)
}

onMounted(() => {
  refresh()
  timer = setInterval(refresh, 5000)
  beat()
  beatTimer = setInterval(beat, 2000)
  loadServices()
  window.addEventListener('resize', onResize)
})
onUnmounted(() => {
  clearInterval(timer)
  clearInterval(beatTimer)
  cancelAnimationFrame(rafId)
  window.removeEventListener('resize', onResize)
})
</script>

<style scoped>
.page { flex: 1; overflow-y: auto; padding: 14px; }
.wrap { display: flex; flex-direction: column; gap: 10px; }
.grid-top { display: grid; grid-template-columns: 150px 1fr; gap: 10px; }
.card { padding: 14px; }
.col { display: flex; flex-direction: column; gap: 10px; }
.cpu-card { display: flex; flex-direction: column; align-items: center; }
.cpu-sub { font-size: 10.5px; color: var(--text-dim); margin-top: 8px; }
.bar-head { display: flex; justify-content: space-between; align-items: center; font-size: 12.5px; color: var(--text-dim); margin-bottom: 8px; }
.bar { height: 7px; background: var(--bg3); border-radius: 4px; overflow: hidden; }
.bar i { display: block; height: 100%; border-radius: 4px; transition: width 0.6s ease; box-shadow: 0 0 6px currentColor; }
.bar-sub { font-size: 10.5px; color: var(--text-dim); margin-top: 7px; }
.bar-sub.dim { color: var(--text-faint); }
.foot { text-align: center; font-size: 10px; color: var(--text-faint); padding: 4px 0 8px; }
.empty { padding: 60px 0; text-align: center; color: var(--text-faint); font-size: 13px; }

/* ---------- 心跳卡（签名元素） ---------- */
.beat-card { padding: 12px 14px 10px; overflow: hidden; }
.beat-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.beat-title { display: flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 600; color: var(--text); }
.beat-core {
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--cyan); box-shadow: 0 0 9px var(--cyan);
  animation: beatPulse 1s ease-in-out infinite;
}
.beat-stats { font-size: 11px; color: var(--text-dim); display: flex; gap: 6px; align-items: center; }
.beat-rtt { color: var(--cyan); font-weight: 700; font-size: 12px; }
.beat-sep { color: var(--text-faint); }
.ecg { width: 100%; height: 72px; display: block; }
.beat-foot {
  display: flex; justify-content: space-between;
  font-size: 10px; color: var(--text-faint); margin-top: 6px;
}
.beat-foot b { font-weight: 700; }
.beat-foot b.ok { color: var(--green); }
.beat-foot b.bad { color: var(--red); }
@keyframes beatPulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.35); opacity: 0.55; }
}
/* 连接中断：整卡转红调，核心停跳 */
.beat-card.down .beat-core { background: var(--red); box-shadow: 0 0 9px var(--red); animation: none; }
.beat-card.down .beat-rtt { color: var(--red); }
.beat-card.wavy .beat-core { background: var(--amber); box-shadow: 0 0 9px var(--amber); }
.beat-card.wavy .beat-rtt { color: var(--amber); }

/* ---------- 网络 I/O ---------- */
.net-rows { display: flex; flex-direction: column; gap: 6px; }
.net-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text); }
.net-ico { width: 18px; text-align: center; font-weight: 700; }
.net-ico.down { color: var(--cyan); }
.net-ico.up { color: var(--green); }

/* ---------- Top 进程 ---------- */
.proc-row {
  display: flex; align-items: center; gap: 10px;
  font-size: 11px; padding: 5px 0;
  border-top: 1px dashed var(--border);
}
.proc-row:first-of-type { border-top: none; }
.proc-name { flex: 1; color: var(--text); min-width: 0; }
.proc-num { width: 46px; text-align: right; color: var(--cyan); }
.proc-num.dim { color: var(--text-faint); }

/* ---------- 服务控制 ---------- */
.mini-btn {
  font-size: 11px; padding: 3px 10px; border-radius: 6px;
  background: var(--bg2); border: 1px solid var(--border); color: var(--text-dim);
}
.mini-btn:disabled { opacity: 0.5; }
.mini-btn.go { color: var(--green); border-color: rgba(110, 231, 160, 0.35); }
.mini-btn.warn { color: var(--red); border-color: rgba(242, 85, 90, 0.35); }
.svc-search {
  width: 100%; font-size: 12.5px; padding: 7px 10px; margin-bottom: 8px;
  background: var(--bg0); border: 1px solid var(--border); border-radius: 8px;
  color: var(--text); outline: none;
}
.svc-search:focus { border-color: var(--border-strong); }
.svc-err { color: var(--amber); font-size: 11.5px; padding: 6px 0; }
.svc-empty { color: var(--text-faint); font-size: 11.5px; padding: 10px 0; text-align: center; }
.svc-list { display: flex; flex-direction: column; }
.svc-row {
  display: flex; align-items: center; gap: 9px;
  padding: 7px 0; border-top: 1px dashed var(--border);
}
.svc-row:first-child { border-top: none; }
.svc-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--text-faint); }
.svc-dot.active { background: var(--green); box-shadow: 0 0 6px var(--green); }
.svc-dot.failed { background: var(--red); box-shadow: 0 0 6px var(--red); }
.svc-dot.activating { background: var(--amber); animation: beatPulse 1s ease-in-out infinite; }
.svc-info { flex: 1; min-width: 0; }
.svc-name { font-size: 11.5px; color: var(--text); }
.svc-desc { font-size: 10px; color: var(--text-faint); margin-top: 1px; }
.svc-acts { display: flex; gap: 5px; flex-shrink: 0; }
</style>
