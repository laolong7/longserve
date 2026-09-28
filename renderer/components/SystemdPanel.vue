<template>
  <div class="sd-panel">
    <div class="sd-head" @click="collapsed = !collapsed" :title="collapsed ? '展开服务面板' : '收起服务面板'">
      <span class="sd-arrow">{{ collapsed ? '▸' : '▾' }}</span>
      <span class="sd-title">服务面板</span>
      <span class="grow"></span>
      <button class="ghost btn-xs" title="刷新服务列表" @click.stop="refresh">⟳</button>
    </div>

    <div v-show="!collapsed" class="sd-body">
      <template v-if="tab && tab.status === 'connected'">
        <div class="sd-tools">
          <input v-model="filter" class="sd-filter mono" placeholder="筛选：nginx / gunicorn…" />
          <label class="sd-all" title="显示包括 inactive 在内的全部已加载服务">
            <input type="checkbox" v-model="showAll" style="width:auto" />全部
          </label>
        </div>
        <div v-if="err" class="sd-err">{{ err }}</div>
        <div v-else-if="loading" class="sd-wait">读取服务列表…</div>
        <div v-else-if="!shown.length" class="sd-wait">没有匹配的服务</div>
        <div v-else class="sd-list">
          <div v-for="u in shown" :key="u.unit" class="sd-item" @click="u.__open = !u.__open">
            <div class="sd-line">
              <span class="dot" :class="u.active === 'active' ? 'on' : u.active === 'failed' ? 'off' : ''"></span>
              <span class="sd-name mono ellipsis" :title="u.desc">{{ u.unit.replace(/\.service$/, '') }}</span>
              <button
                class="ghost btn-xs"
                :title="u.active === 'active' ? '停止' : '启动'"
                @click.stop="act(u, u.active === 'active' ? 'stop' : 'start')"
              >{{ u.active === 'active' ? '■' : '▶' }}</button>
            </div>
            <div v-if="u.__open" class="sd-more" @click.stop>
              <div class="sd-desc ellipsis" :title="u.desc">{{ u.desc || '（无描述）' }}</div>
              <div class="sd-btns">
                <span class="sd-state" :class="{ ok: u.enabled === 'enabled' }">
                  {{ u.enabled === 'enabled' ? '已开机自启' : u.enabled === 'disabled' ? '未自启' : u.enabled }}
                </span>
                <button class="ghost btn-xs" @click="act(u, 'restart')">重启</button>
                <button v-if="u.enabled === 'enabled'" class="ghost btn-xs" @click="act(u, 'disable')">关自启</button>
                <button v-else class="ghost btn-xs" @click="act(u, 'enable')">开自启</button>
              </div>
            </div>
          </div>
        </div>
      </template>
      <div v-else class="sd-wait">连接服务器后管理服务</div>
    </div>
  </div>
</template>

<script setup>
// 数据源三路合并：
//   ① systemctl list-units --all（已加载的运行态）
//   ② systemctl list-unit-files（装了但从未启动的服务）
//   ③ 常见服务名单逐个 is-active/is-enabled 兜底探测（nginx/gunicorn/mysql…，
//      覆盖 unit 文件在非标准位置的极简系统）
// 操作直接 systemctl start/stop/restart/enable/disable，操作后刷新。
// 关键服务（sshd/network 等）操作前会追加"可能断开连接"的强确认。
import { ref, computed, watch } from 'vue'
import { useTerminalStore } from '../stores/terminals'
import { useDialogStore } from '../stores/dialog'

const store = useTerminalStore()
const dialog = useDialogStore()

const collapsed = ref(localStorage.getItem('sd_collapsed') === '1')
const units = ref([])
const loading = ref(false)
const err = ref('')
const filter = ref('')
const showAll = ref(false)

const tab = computed(() => store.activeTab)
// 这些服务停掉可能直接断掉自己的 SSH 会话，务必二次敲响警钟
const CRITICAL = /^(sshd|ssh|network|networking|systemd-networkd|systemd-logind)\b/

// 常见服务兜底探测名单（按需可继续加）
const COMMON_SERVICES = [
  'nginx', 'apache2', 'httpd', 'caddy',
  'mysql', 'mysqld', 'mariadb', 'postgresql', 'redis', 'redis-server', 'mongod',
  'docker', 'containerd', 'php-fpm', 'php8.1-fpm', 'php8.2-fpm',
  'gunicorn', 'uwsgi', 'pm2', 'node', 'frps', 'frpc', 'xray', 'v2ray', 'fail2ban', 'ufw'
]

const shown = computed(() => {
  const kw = filter.value.trim().toLowerCase()
  return units.value.filter((u) => {
    if (!showAll.value && u.active !== 'active' && u.active !== 'failed') return false
    if (kw && !u.unit.toLowerCase().includes(kw) && !(u.desc || '').toLowerCase().includes(kw)) return false
    return true
  })
})

watch(collapsed, (v) => localStorage.setItem('sd_collapsed', v ? '1' : '0'))
watch(() => [store.activeTabId, tab.value && tab.value.status], () => refresh())

async function refresh() {
  const t = tab.value
  if (!t || t.status !== 'connected') { units.value = []; return }
  loading.value = true
  err.value = ''
  const candidates = COMMON_SERVICES.join(' ')
  const cmd =
    'systemctl list-units --type=service --all --no-legend --no-pager 2>/dev/null; ' +
    'echo "|SEP|"; systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null; ' +
    'echo "|SEP|"; for s in ' + candidates + '; do a=$(systemctl is-active $s 2>/dev/null); e=$(systemctl is-enabled $s 2>/dev/null); echo "$s $a $e"; done'
  const res = await window.api.sshExec(t.id, cmd, 20000)
  loading.value = false
  if (!res.ok) { err.value = res.error; return }
  const seg = (res.stdout || '').split('|SEP|')
  const enabledMap = {}
  for (const l of (seg[1] || '').split('\n')) {
    const parts = l.trim().split(/\s+/)
    if (parts.length >= 2) enabledMap[parts[0]] = parts[1]
  }
  const byName = new Map() // 去掉 .service 的短名 -> 条目
  // ① 已加载 units：格式 UNIT LOAD ACTIVE SUB DESCRIPTION（ACTIVE 是第 3 列，SUB 第 4 列）
  for (const l of (seg[0] || '').split('\n')) {
    const line = l.trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    if (parts.length < 4) continue
    const unit = parts[0]
    const active = parts[2] || 'unknown'
    const sub = parts[3] || ''
    const desc = parts.slice(4).join(' ')
    byName.set(unit.replace(/\.service$/, ''), {
      unit, active, sub, desc,
      enabled: enabledMap[unit] || '?', __open: false
    })
  }
  // ② unit-files 里存在但没被 list-units 加载的服务（装了没启动过）
  for (const l of (seg[1] || '').split('\n')) {
    const parts = l.trim().split(/\s+/)
    if (parts.length < 2) continue
    const unit = parts[0]
    const short = unit.replace(/\.service$/, '')
    if (!byName.has(short)) {
      byName.set(short, { unit, active: 'inactive', sub: '', desc: '（已安装，未运行）', enabled: parts[1] || '?', __open: false })
    }
  }
  // ③ 常见服务兜底探测（is-active 输出 active/inactive/failed/unknown）
  for (const l of (seg[2] || '').split('\n')) {
    const parts = l.trim().split(/\s+/)
    if (parts.length < 2) continue
    const [name, active, enabled] = parts
    if (active === 'active' || active === 'failed') {
      if (!byName.has(name)) {
        byName.set(name, { unit: name + '.service', active, sub: '', desc: '（常见服务探测）', enabled: enabled || '?', __open: false })
      } else if (byName.get(name).active === 'inactive') {
        // 探测到 active 但 list-units 没给：以探测为准
        const u = byName.get(name)
        u.active = active
        if (enabled && enabled !== 'unknown') u.enabled = enabled
      }
    }
  }
  // 运行中的排前，其余按名称
  units.value = [...byName.values()].sort((a, b) =>
    (b.active === 'active') - (a.active === 'active') || a.unit.localeCompare(b.unit)
  )
}

async function act(u, op) {
  const t = tab.value
  if (!t || t.status !== 'connected') return
  const critical = CRITICAL.test(u.unit.replace(/\.service$/, ''))
  const opText = { start: '启动', stop: '停止', restart: '重启', enable: '设为开机自启', disable: '取消开机自启' }[op]
  const ok = await dialog.askConfirm({
    title: `${opText}服务：${u.unit}`,
    message:
      `将在 ${t.name} 上执行：systemctl ${op} ${u.unit}` +
      (critical ? '\n\n⚠ 这是关键系统服务，操作可能导致你的 SSH 连接直接断开！' : '')
  })
  if (!ok) return
  const res = await window.api.sshExec(t.id, `systemctl ${op} ${u.unit}`, 30000)
  if (!res.ok) dialog.showToast('操作失败：' + res.error)
  else dialog.showToast(`${u.unit} 已${opText}`)
  setTimeout(refresh, 800) // 给 systemd 一点落定时间再刷新
}
</script>

<style scoped>
.sd-panel {
  border-top: 1px solid var(--border);
  flex-shrink: 0;
  background: var(--bg1);
}
.sd-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
  color: var(--text-dim);
}
.sd-head:hover { color: var(--text); }
.sd-arrow { font-size: 10px; width: 10px; flex-shrink: 0; }
.sd-title { font-weight: 600; letter-spacing: 1px; }
.btn-xs { font-size: 11px; padding: 2px 7px; }
.sd-body { padding: 0 8px 10px; }
.sd-tools { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.sd-filter { flex: 1; min-width: 0; font-size: 11.5px; padding: 4px 8px; }
.sd-all { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-faint); cursor: pointer; flex-shrink: 0; }
.sd-list { max-height: 260px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.sd-item { border-radius: var(--radius-sm); }
.sd-item:hover { background: var(--bg3); }
.sd-line { display: flex; align-items: center; gap: 7px; padding: 4px 6px; cursor: pointer; }
.sd-name { flex: 1; min-width: 0; font-size: 11.8px; }
.sd-more { padding: 2px 6px 6px 21px; }
.sd-desc { font-size: 10.5px; color: var(--text-faint); margin-bottom: 5px; }
.sd-btns { display: flex; gap: 5px; align-items: center; }
.sd-state { font-size: 10.5px; color: var(--text-faint); margin-right: auto; }
.sd-state.ok { color: var(--green); }
.sd-wait, .sd-err { font-size: 11.5px; color: var(--text-faint); text-align: center; padding: 12px 0; }
.sd-err { color: var(--red); word-break: break-all; }
</style>
