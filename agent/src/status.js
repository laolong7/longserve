// ============================================================
// 服务器状态采集（全内置模块，跨平台：Linux 生产 / Windows 本地测试）
// CPU 使用率用 cpus() 两次采样差值计算，不依赖外部命令
// v1.13.0 增强：网络 I/O 速率（/proc/net/dev 两次采样差值，复用 CPU 采样窗口）、
//   Top 进程、进程数——全部 best-effort，采集失败返回 null/空数组不阻塞
// ============================================================
const os = require('os')
const fs = require('fs')
const { exec } = require('child_process')

function cpuSample() {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    for (const k of Object.keys(cpu.times)) total += cpu.times[k]
    idle += cpu.times.idle
  }
  return { idle, total }
}

// 采样间隔内的 CPU 使用率（百分比）
function cpuUsage(sampleMs = 200) {
  return new Promise((resolve) => {
    const a = cpuSample()
    setTimeout(() => {
      const b = cpuSample()
      const idleDelta = b.idle - a.idle
      const totalDelta = b.total - a.total
      resolve(totalDelta > 0 ? Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100)) : 0)
    }, sampleMs)
  })
}

// 磁盘分区：Linux 采根分区与常见挂载点；Windows 枚举存在的盘符
function disks() {
  const out = []
  const probe = (p, label) => {
    try {
      const st = fs.statfsSync(p)
      const total = st.blocks * st.bsize
      const free = st.bavail * st.bsize
      if (total > 0) {
        out.push({ mount: label, total, free, used: total - free, percent: Math.round(((total - free) / total) * 100) })
      }
    } catch { /* 分区不存在或无权限 */ }
  }
  if (process.platform === 'win32') {
    for (let i = 65; i <= 90; i++) probe(String.fromCharCode(i) + ':\\', String.fromCharCode(i) + ':')
  } else {
    probe('/', '/')
    probe('/var', '/var')
    probe('/home', '/home')
  }
  return out
}

// /proc/net/dev 全接口累计字节（Linux only，其他平台返回 null）
function netSample() {
  try {
    const raw = fs.readFileSync('/proc/net/dev', 'utf8')
    let rx = 0
    let tx = 0
    for (const line of raw.split('\n').slice(2)) {
      const m = line.match(/^\s*([^:]+):\s*(.+)$/)
      if (!m) continue
      const fields = m[2].trim().split(/\s+/)
      rx += Number(fields[0]) || 0
      tx += Number(fields[8]) || 0
    }
    return { rx, tx }
  } catch {
    return null
  }
}

// shell 小命令采集（Linux 生产用；失败静默返回 null）
function sh(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 3000, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout || ''))
    })
  })
}

// Top 进程（按 CPU 降序前 5）+ 进程总数——best-effort
async function processes() {
  const [topRaw, countRaw] = await Promise.all([
    sh("ps -eo pcpu,pmem,pid,comm --sort=-pcpu --no-headers 2>/dev/null | head -5"),
    sh('ps -e --no-headers 2>/dev/null | wc -l')
  ])
  const top = []
  if (topRaw) {
    for (const l of topRaw.split('\n')) {
      const parts = l.trim().split(/\s+/)
      if (parts.length < 4) continue
      top.push({
        cpu: Math.round((Number(parts[0]) || 0) * 10) / 10,
        mem: Math.round((Number(parts[1]) || 0) * 10) / 10,
        pid: Number(parts[2]) || 0,
        name: parts.slice(3).join(' ')
      })
    }
  }
  return { top, total: countRaw ? Number(countRaw.trim()) || null : null }
}

async function collect() {
  const netA = netSample()
  const usage = await cpuUsage() // 200ms 窗口，顺带做网络速率差值
  const netB = netSample()
  const memTotal = os.totalmem()
  const memFree = os.freemem()
  const procs = await processes()

  // 网络速率：字节/秒（两次采样差 / 0.2s）；Linux only
  let net = null
  if (netA && netB) {
    net = {
      rxPerSec: Math.max(0, Math.round((netB.rx - netA.rx) / 0.2)),
      txPerSec: Math.max(0, Math.round((netB.tx - netA.tx) / 0.2))
    }
  }

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    uptime: os.uptime(),
    cpu: {
      model: (os.cpus()[0] && os.cpus()[0].model) || '',
      cores: os.cpus().length,
      usage: Math.round(usage),
      loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100)
    },
    mem: {
      total: memTotal,
      free: memFree,
      used: memTotal - memFree,
      percent: Math.round(((memTotal - memFree) / memTotal) * 100)
    },
    disks: disks(),
    net,
    procs: procs.total,
    top: procs.top,
    time: Date.now()
  }
}

// 给 AI 的文本版状态（注入上下文/工具结果用，紧凑省 token）
function toText(s) {
  const fmtB = (b) => (b > 1073741824 ? (b / 1073741824).toFixed(1) + 'G' : Math.round(b / 1048576) + 'M')
  const fmtRate = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + 'MB/s' : n > 1024 ? Math.round(n / 1024) + 'KB/s' : n + 'B/s')
  const upD = Math.floor(s.uptime / 86400)
  const upH = Math.floor((s.uptime % 86400) / 3600)
  const lines = [
    `主机: ${s.hostname}（${s.platform} ${s.release} ${s.arch}）`,
    `CPU: ${s.cpu.cores} 核，使用率 ${s.cpu.usage}%，负载 ${s.cpu.loadavg.join(' / ')}`,
    `内存: 使用率 ${s.mem.percent}%（已用 ${fmtB(s.mem.used)} / 共 ${fmtB(s.mem.total)}）`,
    `运行时长: ${upD} 天 ${upH} 小时`,
    '磁盘: ' + s.disks.map((d) => `${d.mount} ${d.percent}%（剩 ${fmtB(d.free)}）`).join('，')
  ]
  if (s.net) lines.push(`网络: ↓ ${fmtRate(s.net.rxPerSec)} ↑ ${fmtRate(s.net.txPerSec)}`)
  if (s.procs) lines.push(`进程数: ${s.procs}`)
  if (s.top && s.top.length) lines.push('Top 进程: ' + s.top.map((p) => `${p.name} ${p.cpu}%`).join('，'))
  return lines.join('\n')
}

module.exports = { collect, toText }
