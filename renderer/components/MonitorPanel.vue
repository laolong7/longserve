<template>
  <div class="mon-panel">
    <div class="mon-head" @click="collapsed = !collapsed" :title="collapsed ? '展开监控' : '收起监控'">
      <span class="mon-arrow">{{ collapsed ? '▸' : '▾' }}</span>
      <span class="mon-title">监控仪表盘</span>
      <span v-if="cur" class="mono mon-mini">{{ cur.cpu }}%</span>
      <span class="grow"></span>
      <span class="mon-srv ellipsis">{{ tab ? tab.name : '未连接' }}</span>
    </div>

    <div v-show="!collapsed" class="mon-body">
      <template v-if="tab && tab.status === 'connected'">
        <div v-if="err" class="mon-err">{{ err }}</div>
        <template v-else-if="cur">
          <!-- CPU：近 40 次采样 sparkline（单色系，当前值直标） -->
          <div class="mon-row" :title="`CPU 使用率：${cur.cpu}%（每 3 秒采样 /proc/stat 计算差值）`">
            <span class="mon-label">CPU</span>
            <svg class="mon-spark" viewBox="0 0 100 26" preserveAspectRatio="none">
              <polyline :points="cpuPoints" class="spark-line" :class="{ hot: cur.cpu >= 85 }" />
            </svg>
            <span class="mon-val mono" :class="{ amber: cur.cpu >= 85 }">{{ cur.cpu }}%</span>
          </div>
          <div class="mon-row" :title="`内存：${fmtBytes(cur.memUsed)} / ${fmtBytes(cur.memTotal)}`">
            <span class="mon-label">内存</span>
            <div class="mon-bar"><div class="mon-bar-in" :class="{ amber: cur.memPct >= 85 }" :style="{ width: cur.memPct + '%' }"></div></div>
            <span class="mon-val mono" :class="{ amber: cur.memPct >= 85 }">{{ cur.memPct }}%</span>
          </div>
          <div class="mon-row" :title="`根分区：${fmtBytes(cur.diskUsed)} / ${fmtBytes(cur.diskTotal)}`">
            <span class="mon-label">磁盘</span>
            <div class="mon-bar"><div class="mon-bar-in" :class="{ amber: cur.diskPct >= 90 }" :style="{ width: cur.diskPct + '%' }"></div></div>
            <span class="mon-val mono" :class="{ amber: cur.diskPct >= 90 }">{{ cur.diskPct }}%</span>
          </div>
          <div class="mon-row" title="系统负载（1/5/15 分钟）与网卡吞吐">
            <span class="mon-label">负载</span>
            <span class="mon-val mono" style="flex:1; text-align:left">{{ cur.load1 }} / {{ cur.load5 }} / {{ cur.load15 }}</span>
            <span class="mon-val mono" :title="`${fmtBytes(cur.netUp)}/s 上行 · ${fmtBytes(cur.netDown)}/s 下行`">
              ↓{{ fmtBytes(cur.netDown) }}/s ↑{{ fmtBytes(cur.netUp) }}/s
            </span>
          </div>
        </template>
        <div v-else class="mon-wait">正在采样…</div>
      </template>
      <div v-else class="mon-wait">连接服务器后开始监控</div>
    </div>
  </div>
</template>

<script setup>
// 监控原理：通过当前 SSH 连接的 exec 通道（一次性命令通道，不进终端、不污染画面）
// 每 3 秒读一次 /proc/stat（CPU 时间片）/ /proc/meminfo / /proc/net/dev / df 根分区，
// 相邻两次采样做差：CPU% = 1 - idle增量/总增量；网速 = 字节增量 ÷ 间隔。全程只读。
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useTerminalStore } from '../stores/terminals'

const store = useTerminalStore()
const collapsed = ref(localStorage.getItem('mon_collapsed') === '1')
const cur = ref(null) // { cpu, memPct, memUsed, memTotal, diskPct, diskUsed, diskTotal, load1, load5, load15, netUp, netDown }
const err = ref('')
const history = ref([]) // CPU 历史（sparkline）
let prevStat = null // { total, idle, rx, tx, at }
let timer = null
let failCount = 0

const tab = computed(() => store.activeTab)

const SAMPLE_CMD =
  'cat /proc/stat; echo "|MEM|"; cat /proc/meminfo; echo "|NET|"; cat /proc/net/dev; ' +
  'echo "|DSK|"; df -kP / 2>/dev/null; echo "|AVG|"; cat /proc/loadavg'

watch(collapsed, (v) => localStorage.setItem('mon_collapsed', v ? '1' : '0'))
watch(() => store.activeTabId, restart)
watch(
  () => tab.value && tab.value.status,
  restart
)

function restart() {
  stop()
  const t = tab.value
  if (!collapsed.value && t && t.status === 'connected') {
    prevStat = null
    sample()
    timer = setInterval(sample, 3000)
  }
}
function stop() {
  if (timer) { clearInterval(timer); timer = null }
  if (tab.value && tab.value.status !== 'connected') { cur.value = null; err.value = '' }
}

function num(s) { return parseInt(s, 10) || 0 }

async function sample() {
  const t = tab.value
  if (!t || t.status !== 'connected') return stop()
  let res
  try {
    res = await window.api.sshExec(t.id, SAMPLE_CMD, 5000)
  } catch (e) {
    res = { ok: false, error: e.message }
  }
  if (!res.ok) {
    // 连接已断开或超时：连续失败 3 次停止轮询，避免死循环刷错误
    if (String(res.error || '').includes('连接不存在')) return restart()
    if (++failCount >= 3) { err.value = '采样失败：' + (res.error || '未知错误'); stop(); return }
    return
  }
  failCount = 0
  err.value = ''
  try { cur.value = parse(res.stdout, prevStat) } catch { /* 解析失败保持上一次值 */ }
}

// ---------- /proc 输出解析 ----------
function parse(out, prev) {
  const seg = (name) => out.split('|' + name + '|')[1] || ''
  const statLines = (out.split('|MEM|')[0] || '').split('\n')
  const cpu = statLines.find((l) => l.startsWith('cpu '))
  if (!cpu) throw new Error('no cpu line')
  const cols = cpu.trim().split(/\s+/).slice(1).map(num)
  const total = cols.reduce((a, b) => a + b, 0)
  const idle = cols[3] + (cols[4] || 0) // idle + iowait

  const memSeg = seg('MEM')
  const memTotal = num((memSeg.match(/MemTotal:\s+(\d+)/) || [])[1])
  const memAvail = num((memSeg.match(/MemAvailable:\s+(\d+)/) || [])[1])

  // 网卡字节：累加除 lo 外所有接口
  let rx = 0
  let tx = 0
  for (const l of seg('NET').split('\n')) {
    const m = l.match(/^\s*([\w@.]+):\s*(\d+)[^\|]*?\s(\d+)\s*$/)
    if (!m || m[1] === 'lo') continue
    rx += num(m[2])
    tx += num(m[3])
  }

  const dskLine = (seg('DSK').trim().split('\n').filter((l) => l.startsWith('/')) || [])[0]
  const dp = dskLine ? dskLine.trim().split(/\s+/) : []
  const diskTotal = num(dp[1]) * 1024
  const diskUsed = num(dp[2]) * 1024

  const lv = (seg('AVG').trim().split(/\s+/) || ['0', '0', '0'])

  let cpuPct = 0
  let netUp = 0
  let netDown = 0
  if (prev && total > prev.total) {
    cpuPct = Math.max(0, Math.min(100, Math.round((1 - (idle - prev.idle) / (total - prev.total)) * 100)))
    const dt = Math.max(1, (Date.now() - prev.at) / 1000)
    netDown = Math.max(0, Math.round((rx - prev.rx) / dt))
    netUp = Math.max(0, Math.round((tx - prev.tx) / dt))
  }
  prevStat = { total, idle, rx, tx, at: Date.now() }

  history.value.push(cpuPct)
  if (history.value.length > 40) history.value.shift()

  return {
    cpu: cpuPct,
    memTotal,
    memUsed: memTotal - memAvail,
    memPct: memTotal ? Math.round(((memTotal - memAvail) / memTotal) * 100) : 0,
    diskTotal,
    diskUsed,
    diskPct: diskTotal ? Math.round((diskUsed / diskTotal) * 100) : 0,
    load1: lv[0] || '0',
    load5: lv[1] || '0',
    load15: lv[2] || '0',
    netUp,
    netDown
  }
}

const cpuPoints = computed(() => {
  const h = history.value
  if (h.length < 2) return ''
  return h.map((v, i) => `${(i / (h.length - 1)) * 100},${26 - (v / 100) * 24 - 1}`).join(' ')
})

function fmtBytes(b) {
  if (b == null) return '-'
  if (b < 1024) return b + 'B'
  if (b < 1048576) return (b / 1024).toFixed(0) + 'K'
  if (b < 1073741824) return (b / 1048576).toFixed(1) + 'M'
  return (b / 1073741824).toFixed(2) + 'G'
}

restart()
onBeforeUnmount(stop)
</script>

<style scoped>
.mon-panel {
  border-top: 1px solid var(--border);
  flex-shrink: 0;
  background: var(--bg1);
}
.mon-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
  color: var(--text-dim);
}
.mon-head:hover { color: var(--text); }
.mon-arrow { font-size: 10px; width: 10px; flex-shrink: 0; }
.mon-title { font-weight: 600; letter-spacing: 1px; }
.mon-mini { color: var(--green); font-size: 11px; }
.mon-srv { font-size: 11px; color: var(--text-faint); max-width: 90px; }
.mon-body { padding: 2px 12px 10px; display: flex; flex-direction: column; gap: 7px; }
.mon-row { display: flex; align-items: center; gap: 8px; }
.mon-label { width: 30px; flex-shrink: 0; font-size: 11px; color: var(--text-faint); }
.mon-val { font-size: 11px; color: var(--text-dim); flex-shrink: 0; }
.mon-val.amber, .spark-line.hot { color: var(--amber); }
.spark-line {
  fill: none;
  stroke: var(--green);
  stroke-width: 1.5;
}
.spark-line.hot { stroke: var(--amber); }
.mon-spark { width: 100%; height: 26px; flex: 1; min-width: 0; }
.mon-bar {
  flex: 1;
  height: 8px;
  background: var(--bg0);
  border-radius: 4px;
  overflow: hidden;
  min-width: 0;
}
.mon-bar-in {
  height: 100%;
  background: var(--green);
  border-radius: 0 4px 4px 0;
  transition: width 0.5s;
  min-width: 0;
}
.mon-bar-in.amber { background: var(--amber); }
.mon-wait, .mon-err {
  font-size: 11.5px;
  color: var(--text-faint);
  text-align: center;
  padding: 10px 0;
}
.mon-err { color: var(--red); word-break: break-all; }
</style>
