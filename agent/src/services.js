// ============================================================
// systemd 服务管理（手机控制台「服务控制」用）
//   list()   —— 列出全部服务（list-units + list-unit-files 合并，与桌面端同策略）
//   act()    —— start/stop/restart/enable/disable（白名单动作 + 单元名校验防注入）
// 解析规则与桌面端 SystemdPanel 一致：parts[2] 才是 ACTIVE，跳过 not-found 幽灵单元
// 无 systemd 的系统（或容器内）返回明确错误，不瞎猜
// ============================================================
const { runShell, summarize } = require('./exec')

const ACTIONS = ['start', 'stop', 'restart', 'enable', 'disable']
const ACTION_TEXT = { start: '启动', stop: '停止', restart: '重启', enable: '设为开机自启', disable: '取消开机自启' }
// 单元名白名单：systemd 合法字符，杜绝注入
const NAME_RE = /^[A-Za-z0-9@_.\-:]+$/

// 解析 list-units + list-unit-files 两段输出 → 服务数组（导出供契约测试）
function parseUnits(segUnits, segFiles) {
  const byName = new Map()
  const enabledMap = {}
  for (const l of String(segFiles || '').split('\n')) {
    const parts = l.trim().split(/\s+/)
    if (parts.length >= 2) enabledMap[parts[0]] = parts[1]
  }
  for (const l of String(segUnits || '').split('\n')) {
    const line = l.trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    if (parts.length < 4) continue
    const unit = parts[0]
    if (!unit.endsWith('.service')) continue
    if (/@\.service$/.test(unit)) continue // 模板单元（如 getty@.service）不是具体服务
    const load = parts[1] || ''
    if (load === 'not-found') continue // 幽灵单元：被引用但机器上没有
    byName.set(unit.replace(/\.service$/, ''), {
      unit,
      active: parts[2] || 'unknown',
      sub: parts[3] || '',
      desc: parts.slice(4).join(' '),
      enabled: enabledMap[unit] || '?'
    })
  }
  // unit-files 里装了但没被 list-units 加载的服务（已安装、没在跑）
  for (const l of String(segFiles || '').split('\n')) {
    const parts = l.trim().split(/\s+/)
    if (parts.length < 2) continue
    const unit = parts[0]
    if (!unit.endsWith('.service')) continue
    if (/@\.service$/.test(unit)) continue
    const short = unit.replace(/\.service$/, '')
    if (!byName.has(short)) {
      byName.set(short, { unit, active: 'inactive', sub: '', desc: '（已安装，未运行）', enabled: parts[1] || '?' })
    }
  }
  // 排序：运行中优先 → failed → 其余，再按名称
  const rank = (s) => (s === 'active' ? 0 : s === 'failed' ? 1 : s === 'activating' ? 2 : 3)
  return [...byName.values()].sort((a, b) => {
    const ra = rank(a.active)
    const rb = rank(b.active)
    if (ra !== rb) return ra - rb
    return a.unit.localeCompare(b.unit)
  })
}

async function list() {
  const r = await runShell(
    'systemctl list-units --type=service --all --no-legend --no-pager 2>/dev/null; ' +
    'echo "|SEP|"; systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null',
    20000
  )
  const out = String(r.stdout || '')
  if (!out.trim() || !out.includes('|SEP|')) {
    throw new Error('无法列出服务：该系统没有可用的 systemd')
  }
  const seg = out.split('|SEP|')
  return parseUnits(seg[0] || '', seg[1] || '')
}

// 执行服务动作。unit 可带或不带 .service 后缀；动作白名单；返回 { output, code }
async function act(unit, action) {
  const name = String(unit || '').trim()
  const op = String(action || '').trim()
  if (!NAME_RE.test(name)) throw new Error('非法的服务名')
  if (!ACTIONS.includes(op)) throw new Error('不支持的操作：' + op)
  const full = name.endsWith('.service') ? name : name + '.service'
  const r = await runShell(`systemctl ${op} '${full.replace(/'/g, '')}'`, 30000)
  if (r.code !== 0) {
    throw new Error(`systemctl ${op} ${full} 失败：${summarize(r, 300)}`)
  }
  return { output: summarize(r, 300) || `${full} 已${ACTION_TEXT[op]}`, code: r.code }
}

module.exports = { list, act, parseUnits, ACTIONS, ACTION_TEXT }
