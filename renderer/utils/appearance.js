// ============================================================
// 外观系统：由 appearance 配置动态生成全部 CSS 变量
// a: { accent, text, bgHue, bgAlpha, termFontSize } 或 null（默认）
// 设计要点：
//   - 默认主题为「深海蓝 + 真透明」（牢笼 2026-09-28 定）：
//     accent #5ccfe6 / 文字 #cfe3ef / 色相 210° / 透明度 59% / 终端字号 11px
//     终端背景 #1d2530（RGB 29 37 48），窗口效果真透明
//   - bgHue 允许 0（Number(x)||222 会把 0 当假值，属历史 bug）
//   - 透明度要有参照物才看得见：html 底为随色相的辉光渐变，
//     面板/终端半透明后透出光晕，低透明度才有"通透"感
//   - 终端背景/前景/光标/选区跟随同一套外观（工作页面最大面积）
// ============================================================

// 默认外观（新装无配置时生效；"恢复默认"也回到这里）
export const DEFAULT_APPEARANCE = {
  accent: '#5ccfe6',
  text: '#cfe3ef',
  bgHue: 210,
  bgAlpha: 59,
  termFontSize: 11,
  termBg: '#1d2530', // RGB 29 37 48
  termFg: '',
  windowEffect: 'transparent'
}

// 终端基础主题（one-dark 风格；ANSI 内容色保留各自色相，保证红=错绿=对）
const TERM_BASE = {
  background: '#1d2530',
  foreground: '#cfe3ef',
  cursor: '#5ccfe6',
  cursorAccent: '#1d2530',
  selectionBackground: 'rgba(110, 168, 254, 0.30)',
  black: '#282c34',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#dcdfe4',
  brightBlack: '#5c6370',
  brightRed: '#f2777a',
  brightGreen: '#99cc99',
  brightYellow: '#ffcc66',
  brightBlue: '#6699cc',
  brightMagenta: '#c678dd',
  brightCyan: '#66cccc',
  brightWhite: '#ffffff'
}

export const APPEARANCE_PRESETS = [
  { name: '深海蓝（默认）', accent: '#5ccfe6', text: '#cfe3ef', bgHue: 210 },
  { name: '磷光绿', accent: '#3fdc97', text: '#d8dce4', bgHue: 222 },
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

// 解析外观项；hue 用 Number.isFinite 判定，0° 是合法值
function parseAppearance(a) {
  const {
    accent = DEFAULT_APPEARANCE.accent,
    text = DEFAULT_APPEARANCE.text,
    bgHue = DEFAULT_APPEARANCE.bgHue,
    bgAlpha = DEFAULT_APPEARANCE.bgAlpha,
    termBg = DEFAULT_APPEARANCE.termBg,
    termFg = DEFAULT_APPEARANCE.termFg,
    windowEffect = DEFAULT_APPEARANCE.windowEffect
  } = a || {}
  const alpha = Math.min(100, Math.max(30, Number(bgAlpha) || 100)) / 100
  const h = Number.isFinite(Number(bgHue)) ? Number(bgHue) : DEFAULT_APPEARANCE.bgHue
  return { accent, text, h, alpha, termBg, termFg, windowEffect }
}

// 应用到 CSS 变量
// effectOverride：渲染时实际生效的窗口效果（窗口属性创建后不可热切换，
// 用户选"下次打开时应用"时配置已保存新值，但渲染继续按旧效果，避免视觉错乱）
export function applyAppearance(a, effectOverride) {
  const root = document.documentElement
  const cfg = parseAppearance(a) // null/缺省字段都落到默认深海蓝
  const { accent, text, h, alpha } = cfg
  const windowEffect = effectOverride || cfg.windowEffect

  // html 底：
  //   none       = 随色相辉光渐变（不透明窗口）
  //   acrylic    = 很淡的一层色相底（主要质感来自系统磨砂）
  //   transparent= 完全不画底，直接看到桌面壁纸（真透明）
  if (windowEffect === 'transparent') {
    root.style.setProperty('--backdrop', 'transparent')
  } else if (windowEffect === 'acrylic') {
    root.style.setProperty('--backdrop', `hsla(${h}, 30%, 12%, 0.35)`)
  } else {
    root.style.setProperty(
      '--backdrop',
      `radial-gradient(130% 100% at 75% -15%, hsl(${h}, 38%, 17%), hsl(${h}, 26%, 10%) 65%)`
    )
  }

  const bg = (l) => `hsla(${h}, 26%, ${l}%, ${alpha})`
  root.style.setProperty('--bg0', bg(8))
  root.style.setProperty('--bg1', bg(11))
  root.style.setProperty('--bg2', bg(14))
  root.style.setProperty('--bg3', bg(19))
  root.style.setProperty('--border', `hsla(${h}, 22%, 24%, ${Math.min(1, alpha + 0.1)})`)
  root.style.setProperty('--border-strong', `hsla(${h}, 22%, 32%, ${Math.min(1, alpha + 0.1)})`)

  root.style.setProperty('--green', accent)
  root.style.setProperty('--green-dim', hexToRgba(accent, 0.14))

  root.style.setProperty('--text', text)
  root.style.setProperty('--text-dim', hexToRgba(text, 0.62))
  root.style.setProperty('--text-faint', hexToRgba(text, 0.4))
}

// 终端主题片段（xterm 用）。
// 背景/前景优先用独立的 termBg/termFg（外观设置可单独调），留空则跟随全局
// —— 跟随全局用面板同款亮度（11%，即 --bg1），和旁边系统 UI 融为一体而不是一块纯黑
export function getTermTheme(a) {
  const { accent, text, h, alpha, termBg, termFg } = parseAppearance(a)
  return {
    ...TERM_BASE,
    background: termBg ? hexToRgba(termBg, alpha) : `hsla(${h}, 26%, 11%, ${alpha})`,
    foreground: termFg || text,
    cursor: accent,
    cursorAccent: termBg ? termBg : `hsl(${h}, 26%, 11%)`,
    selectionBackground: hexToRgba(accent, 0.3)
  }
}
