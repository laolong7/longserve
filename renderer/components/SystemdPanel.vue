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
          <label class="sd-all" title="默认只显示运行中/异常的服务；勾选后显示全部已安装服务">
            <input type="checkbox" v-model="showAll" style="width:auto" />全部
          </label>
        </div>
        <div v-if="err" class="sd-err">{{ err }}</div>
        <div v-else-if="loading" class="sd-wait">扫描服务器服务…</div>
        <div v-else-if="!shown.length" class="sd-wait">{{ units.length ? '没有匹配的服务' : '这台服务器上没有发现服务' }}</div>
        <div v-else class="sd-list">
          <div v-for="u in shown" :key="u.unit" class="sd-item" @click="u.__open = !u.__open">
            <div class="sd-line">
              <span class="dot" :class="u.active === 'active' ? 'on' : u.active === 'failed' ? 'off' : ''"></span>
              <span class="sd-name mono ellipsis" :title="u.desc">{{ u.unit.replace(/\.service$/, '') }}</span>
              <span class="sd-tag" :class="'st-' + u.active">{{ stateText(u.active) }}</span>
              <!-- 运行中：可停止/重启；已安装未运行/失败：可启动 -->
              <template v-if="u.active === 'active'">
                <button class="ghost btn-xs" title="停止服务" @click.stop="act(u, 'stop')">■ 停止</button>
                <button class="ghost btn-xs" title="重启服务" @click.stop="act(u, 'restart')">⟳ 重启</button>
              </template>
              <button v-else class="ghost btn-xs" title="启动服务" @click.stop="act(u, 'start')">▶ 启动</button>
            </div>
            <div v-if="u.__open" class="sd-more" @click.stop>
              <div class="sd-desc ellipsis" :title="u.desc">{{ u.desc || '（无描述）' }}</div>
              <div class="sd-btns">
                <span class="sd-state" :class="{ ok: u.enabled === 'enabled' }">
                  {{ u.enabled === 'enabled' ? '已开机自启' : u.enabled === 'disabled' ? '未自启' : u.enabled }}
                </span>
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
// 数据源只信服务器真实返回（不猜、不捏造）：
//   ① systemctl list-units --type=service --all   → 已加载单元（运行中/停止/失败都算存在）
//   ② systemctl list-unit-files --type=service   → 装了但从未启动过的服务
// 两路合并后过滤：LOAD=not-found 的幽灵单元（引用了但服务器上并没有）与 @.service 模板单元
// 不做常见服务名单兜底探测——那会把探测噪声混进列表。
// 排序按"重要度活跃度"而非字母序：网关 → 前后端应用 → 数据库缓存 → 容器中间件 → 系统基础 → 其它，
// 同级内运行中优先。面板整体高度不超过左栏一半（CSS max-height: 50%）。
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

// 重要度排序（牢笼 2026-09-28 定）：nginx/前后端/MySQL 等核心服务置顶，不是字母序
function priorityOf(name) {
  const n = name.toLowerCase()
  if (/^(nginx|apache2|httpd|caddy|openresty|lighttpd|haproxy)/.test(n)) return 0 // 入口网关
  if (/^(gunicorn|uwsgi|pm2|node|tomcat|java|php|puma|next|vite|rails|frps|frpc)/.test(n)) return 1 // 前后端应用
  if (/^(mysql|mariadb|postgres|redis|mongo|memcached|elasticsearch|clickhouse|influx)/.test(n)) return 2 // 数据库与缓存
  if (/^(docker|containerd|podman|rabbitmq|kafka|zookeeper|nats|etcd)/.test(n)) return 3 // 容器与中间件
  if (/^(sshd|ssh|cron|rsyslog|firewalld|ufw|fail2ban|chronyd|ntpd|network|systemd-networkd|systemd-resolved|systemd-journald|auditd)/.test(n)) return 4 // 系统基础
  return 9 // 其它
}

const STATE_TEXT = {
  active: '运行中', failed: '失败', activating: '启动中',
  deactivating: '停止中', reloading: '重载中', inactive: '未运行'
}
function stateText(s) { return STATE_TEXT[s] || s || '未知' }

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
  const cmd =
    'systemctl list-units --type=service --all --no-legend --no-pager 2>/dev/null; ' +
    'echo "|SEP|"; systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null'
  const res = await window.api.sshExec(t.id, cmd, 20000)
  loading.value = false
  if (!res.ok) { err.value = res.error; return }
  const seg = (res.stdout || '').split('|SEP|')
  const byName = new Map() // 短名（去 .service）-> 条目

  // 先从 ② 建 unit 文件的自启状态表（①解析时直接查）
  const enabledMap = {}
  for (const l of (seg[1] || '').split('\n')) {
    const parts = l.trim().split(/\s+/)
    if (parts.length >= 2) enabledMap[parts[0]] = parts[1]
  }

  // ① 已加载 units：UNIT LOAD ACTIVE SUB DESCRIPTION
  //    LOAD=not-found 的是"被引用但服务器上没有"的幽灵单元，必须跳过（不捏造服务）
  for (const l of (seg[0] || '').split('\n')) {
    const line = l.trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    if (parts.length < 4) continue
    const unit = parts[0]
    if (!unit.endsWith('.service')) continue
    if (/@\.service$/.test(unit)) continue // 模板单元（如 getty@.service），不是具体服务
    const load = parts[1] || ''
    if (load === 'not-found') continue
    const active = parts[2] || 'unknown'
    const sub = parts[3] || ''
    const desc = parts.slice(4).join(' ')
    byName.set(unit.replace(/\.service$/, ''), {
      unit, active, sub, desc,
      enabled: enabledMap[unit] || '?', __open: false
    })
  }

  // ② unit-files 里装了但没被 list-units 加载的服务（已存在、没在跑）
  for (const l of (seg[1] || '').split('\n')) {
    const parts = l.trim().split(/\s+/)
    if (parts.length < 2) continue
    const unit = parts[0]
    if (!unit.endsWith('.service')) continue
    if (/@\.service$/.test(unit)) continue // 模板单元不算具体服务
    const short = unit.replace(/\.service$/, '')
    if (!byName.has(short)) {
      byName.set(short, { unit, active: 'inactive', sub: '', desc: '（已安装，未运行）', enabled: parts[1] || '?', __open: false })
    }
  }

  // 排序：重要度（网关→前后端→数据库→…）→ 运行中优先 → 名称
  const activeRank = (s) => (s === 'active' ? 0 : s === 'failed' ? 1 : s === 'activating' ? 2 : 3)
  units.value = [...byName.values()].sort((a, b) => {
    const pa = priorityOf(a.unit.replace(/\.service$/, ''))
    const pb = priorityOf(b.unit.replace(/\.service$/, ''))
    if (pa !== pb) return pa - pb
    const aa = activeRank(a.active)
    const ab = activeRank(b.active)
    if (aa !== ab) return aa - ab
    return a.unit.localeCompare(b.unit)
  })
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
  /* 面板整体不超过左栏（服务器栏目）高度的一半 */
  max-height: 50%;
  min-height: 0;
  display: flex;
  flex-direction: column;
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
  flex-shrink: 0;
}
.sd-head:hover { color: var(--text); }
.sd-arrow { font-size: 10px; width: 10px; flex-shrink: 0; }
.sd-title { font-weight: 600; letter-spacing: 1px; }
.btn-xs { font-size: 11px; padding: 2px 7px; }
.sd-body {
  padding: 0 8px 10px;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.sd-tools { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; flex-shrink: 0; }
.sd-filter { flex: 1; min-width: 0; font-size: 11.5px; padding: 4px 8px; }
.sd-all { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-faint); cursor: pointer; flex-shrink: 0; }
.sd-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.sd-item { border-radius: var(--radius-sm); }
.sd-item:hover { background: var(--bg3); }
.sd-line { display: flex; align-items: center; gap: 6px; padding: 4px 6px; cursor: pointer; }
.sd-name { flex: 1; min-width: 0; font-size: 11.8px; }
.sd-tag { font-size: 10px; color: var(--text-faint); flex-shrink: 0; }
.sd-tag.st-active { color: var(--green); }
.sd-tag.st-failed { color: var(--red); }
.sd-tag.st-activating, .sd-tag.st-deactivating { color: var(--amber); }
.sd-more { padding: 2px 6px 6px 21px; }
.sd-desc { font-size: 10.5px; color: var(--text-faint); margin-bottom: 5px; }
.sd-btns { display: flex; gap: 5px; align-items: center; }
.sd-state { font-size: 10.5px; color: var(--text-faint); margin-right: auto; }
.sd-state.ok { color: var(--green); }
.sd-wait, .sd-err { font-size: 11.5px; color: var(--text-faint); text-align: center; padding: 12px 0; }
.sd-err { color: var(--red); word-break: break-all; }
</style>
