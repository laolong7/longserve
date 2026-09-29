<template>
  <div class="page">
    <div class="head">
      <span class="count mono">{{ records.length }} 条记录</span>
      <button class="refresh" @click="load">↻ 刷新</button>
    </div>

    <div v-if="!records.length" class="empty">暂无操作记录</div>

    <div v-for="(r, i) in records" :key="i" class="rec panel" :class="{ danger: r.danger, denied: r.approved === false }">
      <div class="rec-top">
        <span class="src" :class="r.source">{{ r.source === 'ai' ? '✦ AI' : '❯ 手动' }}</span>
        <span v-if="r.danger" class="flag">{{ r.approved === false ? '已拒绝' : r.approved === true ? '已批准·危险' : r.approved === null && r.note === '等待确认' ? '待确认' : '危险' }}</span>
        <span class="time mono">{{ timeText(r.time) }}</span>
      </div>
      <div class="rec-cmd mono">$ {{ r.command }}</div>
      <div v-if="r.note" class="rec-note">{{ r.note }}</div>
      <div v-if="r.output" class="rec-out mono">{{ r.output }}</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { api } from '../api'

const records = ref([])

async function load() {
  try {
    const r = await api.audit()
    if (r.ok) records.value = r.records
  } catch { /* 断线时静默 */ }
}

function timeText(t) {
  if (!t) return ''
  const d = new Date(t)
  const today = new Date()
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return hm
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

onMounted(load)
</script>

<style scoped>
.page { flex: 1; overflow-y: auto; padding: 12px; }
.head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.count { font-size: 11px; color: var(--text-faint); }
.refresh { font-size: 12px; padding: 5px 12px; }
.empty { text-align: center; color: var(--text-faint); padding: 70px 0 0; font-size: 13px; }
.rec { padding: 10px 12px; margin-bottom: 8px; }
.rec.danger { border-color: rgba(242, 177, 85, 0.35); }
.rec.denied { opacity: 0.65; }
.rec-top { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.src { font-size: 10.5px; padding: 1px 8px; border-radius: 8px; }
.src.ai { color: var(--violet); background: var(--violet-dim); }
.src.manual { color: var(--cyan); background: var(--cyan-dim); }
.flag { font-size: 10px; color: var(--amber); background: var(--amber-dim); padding: 1px 8px; border-radius: 8px; }
.denied .flag { color: var(--red); background: var(--red-dim); }
.time { margin-left: auto; font-size: 10.5px; color: var(--text-faint); }
.rec-cmd { font-size: 12.5px; color: var(--text); word-break: break-all; }
.rec-note { font-size: 11px; color: var(--text-dim); margin-top: 4px; }
.rec-out {
  margin-top: 6px; padding-top: 6px;
  border-top: 1px dashed var(--border);
  font-size: 10.5px; color: var(--text-faint);
  white-space: pre-wrap; word-break: break-all;
  max-height: 88px; overflow: hidden;
}
</style>
