// ============================================================
// 外观系统：由 appearance 配置动态生成全部 CSS 变量
// a: { accent, text, bgHue, bgAlpha, termFontSize } 或 null（默认）
// ============================================================

// style.css 里的默认值（恢复默认时用）
const DEFAULTS = [
  ['--bg0', '#14161b'],
  ['--bg1', '#191c22'],
  ['--bg2', '#20242c'],
  ['--bg3', '#282d37'],
  ['--border', '#2c313c'],
  ['--border-strong', '#3a404d'],
  ['--text', '#d8dce4'],
  ['--text-dim', '#8a92a2'],
  ['--text-faint', '#5c6474'],
  ['--green', '#3fdc97'],
  ['--green-dim', 'rgba(63, 220, 151, 0.14)']
]

export const APPEARANCE_PRESETS = [
  { name: '磷光绿（默认）', accent: '#3fdc97', text: '#d8dce4', bgHue: 222 },
  { name: '深海蓝', accent: '#5ccfe6', text: '#cfe3ef', bgHue: 210 },
  { name: '暖橙', accent: '#f2a15a', text: '#ecdfd2', bgHue: 20 },
  { name: '紫夜', accent: '#a78bfa', text: '#ddd6f3', bgHue: 265 },
  { name: '灰岩', accent: '#9db2c7', text: '#d5dae0', bgHue: 215 }
]

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

// 应用到 CSS 变量，返回给 xterm 用的主题片段（null=默认）
export function applyAppearance(a) {
  const root = document.documentElement
  if (!a) {
    for (const [k, v] of DEFAULTS) root.style.setProperty(k, v)
    return null
  }
  const { accent = '#3fdc97', text = '#d8dce4', bgHue = 222, bgAlpha = 100 } = a
  const alpha = Math.min(100, Math.max(30, Number(bgAlpha) || 100)) / 100
  const h = Number(bgHue) || 222

  const bg = (l) => `hsla(${h}, 16%, ${l}%, ${alpha})`
  root.style.setProperty('--bg0', bg(8))
  root.style.setProperty('--bg1', bg(11))
  root.style.setProperty('--bg2', bg(14))
  root.style.setProperty('--bg3', bg(19))
  root.style.setProperty('--border', `hsla(${h}, 18%, 24%, ${Math.min(1, alpha + 0.1)})`)
  root.style.setProperty('--border-strong', `hsla(${h}, 18%, 32%, ${Math.min(1, alpha + 0.1)})`)

  root.style.setProperty('--green', accent)
  root.style.setProperty('--green-dim', hexToRgba(accent, 0.14))

  root.style.setProperty('--text', text)
  root.style.setProperty('--text-dim', hexToRgba(text, 0.62))
  root.style.setProperty('--text-faint', hexToRgba(text, 0.4))

  return {
    background: `hsl(${h}, 16%, 8%)`, // 终端背景保持不透明保证可读
    foreground: text,
    cursor: accent
  }
}
