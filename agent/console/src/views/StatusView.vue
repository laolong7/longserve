<template>
  <div class="page">
    <div v-if="st" class="wrap">
      <!-- CPU 环形仪表 + 内存/负载 -->
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
            <div class="bar-head"><span>运行时长</span><span class="mono">{{ uptimeText }}</span></div>
            <div class="bar-sub mono dim">{{ st.platform }} {{ st.release }} · {{ st.arch }}</div>
          </div>
        </div>
      </div>

      <!-- 磁盘 -->
      <div class="panel card" v-for="d in st.disks" :key="d.mount">
        <div class="bar-head"><span class="mono">{{ d.mount }}</span><span class="mono">{{ d.percent }}%</span></div>
        <div class="bar"><i :style="{ width: d.percent + '%', background: gaugeColor(d.percent) }"></i></div>
        <div class="bar-sub mono">剩 {{ fmtB(d.free) }} / 共 {{ fmtB(d.total) }}</div>
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

async function refresh() {
  try {
    const r = await api.status()
    if (r.ok) st.value = r.status
  } catch { /* 顶栏状态灯已反映断线 */ }
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

const uptimeText = computed(() => {
  if (!st.value) return '-'
  const s = st.value.uptime
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  return d > 0 ? `${d} 天 ${h} 时` : `${h} 时 ${Math.floor((s % 3600) / 60)} 分`
})

const sampleTime = computed(() => (st.value ? new Date(st.value.time).toLocaleTimeString('zh-CN') : '-'))

onMounted(() => {
  refresh()
  timer = setInterval(refresh, 5000)
})
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.page { flex: 1; overflow-y: auto; padding: 14px; }
.wrap { display: flex; flex-direction: column; gap: 10px; }
.grid-top { display: grid; grid-template-columns: 150px 1fr; gap: 10px; }
.card { padding: 14px; }
.col { display: flex; flex-direction: column; gap: 10px; }
.cpu-card { display: flex; flex-direction: column; align-items: center; }
.cpu-sub { font-size: 10.5px; color: var(--text-dim); margin-top: 8px; }
.bar-head { display: flex; justify-content: space-between; font-size: 12.5px; color: var(--text-dim); margin-bottom: 8px; }
.bar { height: 7px; background: var(--bg3); border-radius: 4px; overflow: hidden; }
.bar i { display: block; height: 100%; border-radius: 4px; transition: width 0.6s ease; box-shadow: 0 0 6px currentColor; }
.bar-sub { font-size: 10.5px; color: var(--text-dim); margin-top: 7px; }
.bar-sub.dim { color: var(--text-faint); }
.foot { text-align: center; font-size: 10px; color: var(--text-faint); padding: 4px 0 8px; }
.empty { padding: 60px 0; text-align: center; color: var(--text-faint); font-size: 13px; }
</style>
