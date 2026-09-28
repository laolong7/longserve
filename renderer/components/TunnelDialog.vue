<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-mask" @click.self="close">
      <div class="modal tn-modal">
        <div class="tn-head">
          <span class="tn-title">端口转发</span>
          <span class="faint mono">{{ tabName }}</span>
          <div class="grow"></div>
          <button class="ghost" @click="close">✕</button>
        </div>

        <div class="tn-body">
          <!-- 已建隧道列表 -->
          <div class="tn-list-wrap">
            <div class="tn-sec">已建立的转发</div>
            <div v-if="!list.length" class="faint" style="padding:10px 0; font-size:12px">暂无转发规则</div>
            <div v-for="t in list" :key="t.tunnelId" class="tn-item">
              <span class="tn-kind" :class="t.type">{{ t.type === 'local' ? '本地' : '远程' }}</span>
              <span class="mono tn-path">
                <template v-if="t.type === 'local'">
                  本机 {{ t.listenHost }}:{{ t.listenPort }} → 服务器侧 {{ t.targetHost }}:{{ t.targetPort }}
                </template>
                <template v-else>
                  服务器 {{ t.bindHost || '0.0.0.0' }}:{{ t.bindPort }} → 本机 {{ t.targetHost }}:{{ t.targetPort }}
                </template>
              </span>
              <button class="ghost btn-xs" @click="stopOne(t)">停止</button>
            </div>
          </div>

          <!-- 新建表单 -->
          <div class="tn-sec">新建转发</div>
          <div class="tn-form">
            <div class="tn-type">
              <label :class="{ on: form.type === 'local' }">
                <input type="radio" value="local" v-model="form.type" style="width:auto" />
                本地转发（-L）：访问<b>本机</b>端口 → 送到<b>服务器</b>能访问的地址
              </label>
              <label :class="{ on: form.type === 'remote' }">
                <input type="radio" value="remote" v-model="form.type" style="width:auto" />
                远程转发（-R）：访问<b>服务器</b>端口 → 送回<b>本机</b>能访问的地址
              </label>
            </div>

            <div class="tn-grid">
              <template v-if="form.type === 'local'">
                <div class="tn-field"><label>本机监听地址</label><input v-model="form.listenHost" class="mono" placeholder="127.0.0.1" /></div>
                <div class="tn-field"><label>本机监听端口</label><input v-model="form.listenPort" class="mono" placeholder="8080" /></div>
                <div class="tn-field"><label>目标地址（服务器侧）</label><input v-model="form.targetHost" class="mono" placeholder="127.0.0.1" /></div>
                <div class="tn-field"><label>目标端口（服务器侧）</label><input v-model="form.targetPort" class="mono" placeholder="80" /></div>
              </template>
              <template v-else>
                <div class="tn-field"><label>服务器监听地址</label><input v-model="form.bindHost" class="mono" placeholder="留空 = 0.0.0.0" /></div>
                <div class="tn-field"><label>服务器监听端口</label><input v-model="form.bindPort" class="mono" placeholder="8080" /></div>
                <div class="tn-field"><label>目标地址（本机侧）</label><input v-model="form.targetHost" class="mono" placeholder="127.0.0.1" /></div>
                <div class="tn-field"><label>目标端口（本机侧）</label><input v-model="form.targetPort" class="mono" placeholder="3000" /></div>
              </template>
            </div>
            <div class="tn-actions">
              <div class="faint" style="font-size:11.5px">连接断开后转发自动失效。示例：本地转发把服务器上的 3306(MySQL) 映射到本机 13306。</div>
              <div class="grow"></div>
              <button class="primary" @click="add">建立转发</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { useDialogStore } from '../stores/dialog'

const dialog = useDialogStore()
const visible = ref(false)
const connId = ref(null)
const tabName = ref('')
const list = ref([])

const form = reactive({
  type: 'local',
  listenHost: '127.0.0.1',
  listenPort: '',
  bindHost: '',
  bindPort: '',
  targetHost: '127.0.0.1',
  targetPort: ''
})

async function open(tab) {
  if (!tab || tab.status !== 'connected') {
    dialog.showToast('请先连接一个服务器')
    return
  }
  connId.value = tab.id
  tabName.value = `${tab.name}（${tab.instance.host}）`
  visible.value = true
  await refresh()
}
function close() {
  visible.value = false
}
defineExpose({ open })

async function refresh() {
  list.value = await window.api.tunnelList(connId.value)
}
async function add() {
  const f = form
  const spec = { type: f.type, targetHost: (f.targetHost || '127.0.0.1').trim(), targetPort: f.targetPort }
  if (f.type === 'local') {
    spec.listenHost = (f.listenHost || '127.0.0.1').trim()
    spec.listenPort = f.listenPort
  } else {
    spec.bindHost = (f.bindHost || '').trim()
    spec.bindPort = f.bindPort
  }
  if (!Number(spec.targetPort) || (f.type === 'local' && !Number(spec.listenPort)) || (f.type === 'remote' && !Number(spec.bindPort))) {
    alert('端口必须是数字')
    return
  }
  const res = await window.api.tunnelAdd(connId.value, spec)
  if (!res.ok) {
    alert('建立失败：' + res.error)
    return
  }
  dialog.showToast(f.type === 'local' ? '本地转发已建立' : '远程转发已建立（注意服务器防火墙需放行监听端口）')
  f.listenPort = f.bindPort = f.targetPort = ''
  await refresh()
}
async function stopOne(t) {
  window.api.tunnelStop(t.tunnelId)
  setTimeout(refresh, 300)
}
</script>

<style scoped>
.tn-modal { width: 640px; }
.tn-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.tn-title { font-weight: 600; font-size: 14px; }
.tn-body { padding: 12px 16px 16px; overflow-y: auto; }
.tn-sec { font-size: 12px; font-weight: 600; color: var(--text-dim); margin: 6px 0 8px; letter-spacing: 1px; }
.tn-list-wrap { margin-bottom: 10px; }
.tn-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  margin-bottom: 5px;
  background: var(--bg0);
  font-size: 12px;
}
.tn-kind {
  font-size: 10.5px;
  padding: 1px 8px;
  border-radius: 8px;
  flex-shrink: 0;
}
.tn-kind.local { background: var(--green-dim); color: var(--green); }
.tn-kind.remote { background: var(--blue-dim); color: var(--blue); }
.tn-path { flex: 1; min-width: 0; font-size: 11.5px; word-break: break-all; }
.btn-xs { font-size: 11px; padding: 2px 8px; flex-shrink: 0; }
.tn-type { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.tn-type label {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.tn-type label.on { border-color: var(--green); color: var(--text); }
.tn-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
.tn-field { display: flex; flex-direction: column; gap: 4px; }
.tn-actions { display: flex; align-items: center; gap: 10px; }
</style>
