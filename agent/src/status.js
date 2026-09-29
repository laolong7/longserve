// ============================================================
// 服务器状态采集（全内置模块，跨平台：Linux 生产 / Windows 本地测试）
// CPU 使用率用 cpus() 两次采样差值计算，不依赖外部命令
// ============================================================
const os = require('os')
const fs = require('fs')

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

async function collect() {
  const usage = await cpuUsage()
  const memTotal = os.totalmem()
  const memFree = os.freemem()
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
    time: Date.now()
  }
}

// 给 AI 的文本版状态（注入上下文/工具结果用，紧凑省 token）
function toText(s) {
  const fmtB = (b) => (b > 1073741824 ? (b / 1073741824).toFixed(1) + 'G' : Math.round(b / 1048576) + 'M')
  const upD = Math.floor(s.uptime / 86400)
  const upH = Math.floor((s.uptime % 86400) / 3600)
  const lines = [
    `主机: ${s.hostname}（${s.platform} ${s.release} ${s.arch}）`,
    `CPU: ${s.cpu.cores} 核，使用率 ${s.cpu.usage}%，负载 ${s.cpu.loadavg.join(' / ')}`,
    `内存: 使用率 ${s.mem.percent}%（已用 ${fmtB(s.mem.used)} / 共 ${fmtB(s.mem.total)}）`,
    `运行时长: ${upD} 天 ${upH} 小时`,
    '磁盘: ' + s.disks.map((d) => `${d.mount} ${d.percent}%（剩 ${fmtB(d.free)}）`).join('，')
  ]
  return lines.join('\n')
}

module.exports = { collect, toText }
