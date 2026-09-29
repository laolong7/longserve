<template>
  <div class="ring" :style="{ '--p': percent, '--rc': color }">
    <svg viewBox="0 0 100 100">
      <circle class="bg" cx="50" cy="50" r="42" />
      <circle class="fg" cx="50" cy="50" r="42" />
    </svg>
    <div class="val">
      <div class="num mono">{{ percent }}<span class="unit">%</span></div>
      <div class="label">{{ label }}</div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  percent: { type: Number, default: 0 },
  label: { type: String, default: '' },
  color: { type: String, default: 'var(--cyan)' }
})
</script>

<style scoped>
.ring { position: relative; width: 100%; aspect-ratio: 1; }
svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.bg, .fg { fill: none; stroke-width: 7; }
.bg { stroke: var(--bg3); }
.fg {
  stroke: var(--rc);
  stroke-linecap: round;
  stroke-dasharray: 263.9; /* 2πr, r=42 */
  stroke-dashoffset: calc(263.9 * (1 - var(--p) / 100));
  transition: stroke-dashoffset 0.6s ease;
  filter: drop-shadow(0 0 5px var(--rc));
}
.val { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.num { font-size: 22px; font-weight: 700; color: var(--text); }
.unit { font-size: 11px; color: var(--text-dim); margin-left: 1px; }
.label { font-size: 10.5px; color: var(--text-dim); margin-top: 2px; }
</style>
