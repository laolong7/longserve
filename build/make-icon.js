// ============================================================
// 应用图标生成器「轨道核心 · LSU」（无依赖，纯 Node）
// 深空海军蓝圆角底 + 六边形装甲板 + LSU 几何块状字母组（发光核心）
// + 斜切轨道环与卫星数据节点（全息 HUD，环在字母后方穿过）
// 产出：build/icon.ico（16~256 多尺寸 PNG-in-ICO）+ build/icon-preview-256.png（预览）
// 用法：node build/make-icon.js
// ============================================================
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// ---------- 调色（与产品深海蓝主题同源） ----------
const C = {
  voidTop: [14, 28, 48],     // #0e1c30 背景上沿
  voidBot: [9, 18, 35],      // #091223 背景下沿
  haze: [92, 207, 230],      // 顶部辉光雾（信号青降透明度）
  steel: [18, 36, 60],       // #12243c 六边形装甲
  steelLit: [24, 48, 78],    // 装甲上部受光
  cyan: [92, 207, 230],      // #5ccfe6 信号青（产品强调色）
  ice: [215, 244, 255],      // #d7f4ff 字母核心高光
  termCyan: [0, 255, 238],   // #00ffee 轨道环亮边（产品终端色）
}

// ---------- SDF 基元 ----------
function sdRoundRect(px, py, hw, hh, rad) {
  const qx = Math.abs(px) - hw + rad
  const qy = Math.abs(py) - hh + rad
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad
}
function sdHexagon(px, py, R) {
  // 平顶正六边形（顶点在左右 ±R）：凸六边形 = 6 个半平面的最大值，符号正确（内负外正）
  const a = R * Math.sqrt(3) / 2 // 边心距
  let d = -Infinity
  for (let k = 0; k < 6; k++) {
    const ang = Math.PI / 2 + (k * Math.PI) / 3
    d = Math.max(d, px * Math.cos(ang) + py * Math.sin(ang))
  }
  return d - a
}
function sdEllipseRing(px, py, a, b, halfW) {
  // 近似椭圆环 SDF：缩放圆环再按最小半轴折算
  const k = Math.min(a, b)
  return Math.abs((Math.hypot(px / a, py / b) - 1) * k) - halfW
}
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v }
function cover(sd, w) { return clamp01(0.5 - sd / w) } // 边缘覆盖（sd<0 在形内）
function mix(c1, c2, t) {
  return [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t]
}

// ---------- LSU 几何块状字母（矩形并集，微圆角，科技切字） ----------
// 字母局部坐标：宽 w=0.185、高 h=0.40、笔画 t=0.050
const LETTER = { w: 0.185, h: 0.40, t: 0.050, r: 0.007 }
const LAYOUT = { y: -0.03, xs: [-0.26, 0, 0.26] } // 光学居中，字距 0.075

function letterRects(kind) {
  const { w, h, t } = LETTER
  const hw = w / 2, hh = h / 2
  if (kind === 'L') {
    return [
      [-hw, -hw + t, -hh, hh],          // 竖
      [-hw, hw, -hh, -hh + t]           // 底脚
    ]
  }
  if (kind === 'S') {
    return [
      [-hw, hw, hh - t, hh],            // 上横
      [-hw, -hw + t, -t / 2, hh - t],   // 左竖（上半）
      [-hw, hw, -t / 2, t / 2],         // 中横
      [hw - t, hw, -hh + t, t / 2],     // 右竖（下半）
      [-hw, hw, -hh, -hh + t]           // 下横
    ]
  }
  // U
  return [
    [-hw, -hw + t, -hh + t, hh],        // 左竖
    [hw - t, hw, -hh + t, hh],          // 右竖
    [-hw, hw, -hh, -hh + t]             // 底横
  ]
}

// 三个字母的矩形世界坐标（含布局偏移）
const LETTER_RECTS = []
for (let i = 0; i < 3; i++) {
  const kind = 'LSU'[i]
  for (const [x0, x1, y0, y1] of letterRects(kind)) {
    LETTER_RECTS.push([x0 + LAYOUT.xs[i], x1 + LAYOUT.xs[i], y0 + LAYOUT.y, y1 + LAYOUT.y])
  }
}
function sdLetters(px, py) {
  let d = 1e9
  for (const [x0, x1, y0, y1] of LETTER_RECTS) {
    const sd = sdRoundRect(px - (x0 + x1) / 2, py - (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, LETTER.r)
    if (sd < d) d = sd
  }
  return d
}

// ---------- 光栅：SDF + 解析抗锯齿，1024² 一次渲染，再盒式降采样 ----------
const N = 1024

function render() {
  const rgba = Buffer.alloc(N * N * 4)
  const S = 2 / N
  const px0 = 2 / N // 1 像素当量（归一化单位）
  for (let j = 0; j < N; j++) {
    const y = 1 - (j + 0.5) * S // PNG 行序自上而下 → 数学 y 轴向上，防镜像
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) * S - 1
      let r = 0, g = 0, b = 0, a = 0
      // src-over-dst 合成（非预乘）：后画的层盖在先画的层上
      const put = (col, alpha) => {
        if (alpha <= 0) return
        const na = alpha + a * (1 - alpha)
        if (na <= 0) return
        r = (col[0] * alpha + r * a * (1 - alpha)) / na
        g = (col[1] * alpha + g * a * (1 - alpha)) / na
        b = (col[2] * alpha + b * a * (1 - alpha)) / na
        a = na
      }

      // ---- 1) 圆角底 + 垂直渐变 + 顶部辉光雾 ----
      const sdBg = sdRoundRect(x, y, 0.985, 0.985, 0.21)
      const bgA = cover(sdBg, px0 * 1.2)
      if (bgA > 0) {
        const t = clamp01((1 - y) / 2) // 上亮下暗
        let col = mix(C.voidTop, C.voidBot, t)
        const haze = Math.exp(-(((x + 0.15) ** 2) / 0.55 + ((y - 0.55) ** 2) / 0.32)) * 0.16 // 顶部辉光雾
        col = mix(col, C.haze, haze)
        const lift = Math.exp(-((x * x + y * y) / 0.75)) * 0.07
        col = mix(col, C.steelLit, lift)
        put(col, bgA)
      }

      // ---- 2) 六边形装甲板 ----
      const sdHex = sdHexagon(x, y, 0.60)
      const plateT = clamp01((0.5 - y) / 1.0) // 上亮下暗
      put(mix(C.steelLit, C.steel, plateT), cover(sdHex, px0 * 1.2))
      put(C.cyan, cover(Math.abs(sdHex) - 0.004, px0 * 3.2) * 0.16) // 边缘青辉光
      put(C.cyan, cover(Math.abs(sdHex) - 0.0015, px0 * 1.0) * 0.55) // 细亮边

      // ---- 3) 轨道环（字母后方穿过）+ 卫星节点 ----
      const ang = (-22 * Math.PI) / 180
      const ca = Math.cos(ang), sa = Math.sin(ang)
      const rx = x * ca + y * sa
      const ry = -x * sa + y * ca
      const sdRing = sdEllipseRing(rx, ry, 0.80, 0.315, 0.015)
      // 环外辉光：指数衰减
      put(C.cyan, Math.exp(-Math.max(0, Math.abs(sdRing) - 0.015) / 0.028) * 0.11)
      put(mix(C.cyan, C.termCyan, 0.35), cover(sdRing, px0 * 1.1) * 0.80) // 环本体
      // 卫星节点（环右下侧，冰白核心 + 青晕）
      const nAng = (-16 * Math.PI) / 180
      const nx = Math.cos(nAng) * 0.80, ny = Math.sin(nAng) * 0.315
      const sx = nx * ca - ny * sa, sy = nx * sa + ny * ca
      const dNode = Math.hypot(x - sx, y - sy)
      put(C.cyan, cover(dNode - 0.028, px0 * 2.2) * 0.30)
      put(C.ice, cover(dNode - 0.0125, px0 * 1.1))

      // ---- 4) LSU 字母组（发光核心，最上层）----
      const sdL = sdLetters(x, y)
      // 字母辉光：指数衰减的真光源（平顶膨胀会糊成方块光板）
      put(C.cyan, Math.exp(-Math.max(0, sdL) / 0.022) * 0.13)
      // 字母本体：上亮（冰白）下青的渐变
      const lt = clamp01((LAYOUT.y + 0.2 - y) / 0.4)
      put(mix(C.ice, C.cyan, 0.25 + lt * 0.55), cover(sdL, px0 * 1.1))

      const o = (j * N + i) * 4
      rgba[o] = Math.round(clamp01(r / 255) * 255)
      rgba[o + 1] = Math.round(clamp01(g / 255) * 255)
      rgba[o + 2] = Math.round(clamp01(b / 255) * 255)
      rgba[o + 3] = Math.round(a * 255)
    }
  }
  return rgba
}

// 盒式降采样 N → size
function downsample(src, srcN, size) {
  const out = Buffer.alloc(size * size * 4)
  const box = srcN / size
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0
      const j0 = Math.floor(j * box), j1 = Math.min(srcN, Math.ceil((j + 1) * box))
      const i0 = Math.floor(i * box), i1 = Math.min(srcN, Math.ceil((i + 1) * box))
      for (let y = j0; y < j1; y++) {
        for (let x = i0; x < i1; x++) {
          const o = (y * srcN + x) * 4
          const al = src[o + 3]
          r += src[o] * al; g += src[o + 1] * al; b += src[o + 2] * al; a += al
          n++
        }
      }
      const o = (j * size + i) * 4
      if (a > 0) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a)
      }
      out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

// ---------- PNG 编码 ----------
function crc32(buf) {
  let c, table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  c = -1
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}
function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(size * (1 + size * 4))
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0
    rgba.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ---------- ICO 编码（PNG-in-ICO，Win Vista+） ----------
function encodeICO(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  const dir = []
  let offset = 6 + 16 * entries.length
  for (const e of entries) {
    const d = Buffer.alloc(16)
    d[0] = e.size >= 256 ? 0 : e.size
    d[1] = e.size >= 256 ? 0 : e.size
    d.writeUInt16LE(1, 4)  // planes
    d.writeUInt16LE(32, 6) // bpp
    d.writeUInt32LE(e.png.length, 8)
    d.writeUInt32LE(offset, 12)
    offset += e.png.length
    dir.push(d)
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.png)])
}

// ---------- 主流程 ----------
console.log('渲染 1024² 光栅…')
const big = render()
const SIZES = [256, 128, 64, 48, 32, 16]
const entries = []
for (const s of SIZES) {
  const rgba = downsample(big, N, s)
  entries.push({ size: s, png: encodePNG(s, rgba) })
  console.log(`  ${s}x${s} 编码完成（${entries[entries.length - 1].png.length} 字节）`)
}

const ico = encodeICO(entries)
const outDir = __dirname
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico)
fs.writeFileSync(path.join(outDir, 'icon-preview-256.png'), entries[0].png)
console.log(`✓ build/icon.ico（${ico.length} 字节，${SIZES.length} 尺寸）`)
console.log('✓ build/icon-preview-256.png')
