// ============================================================
// Longserve Agent 构建脚本：bundle → Node SEA 单二进制
// 产物：
//   release/longserve-agent        Linux x64（部署到服务器，glibc≥2.17 通吃新老系统）
//   release/longserve-agent.exe    Windows x64（本地自测）
// 流程：esbuild 打包 src/index.js → sea-config 生成 blob →
//       注入 node 宿主二进制（与 blob 同版本）→ GLIBC 符号自检
// 关键决策（v1.11.3）：Linux 宿主用 unofficial-builds 的 glibc-217 变体。
//   官方 Node≥20 的 linux-x64 构建基于 RHEL 8，硬性要求 glibc≥2.28，
//   在 CentOS 7 / Debian 9 / Ubuntu 18.04 等老系统上直接报
//   "version `GLIBC_2.28' not found" 起不来；glibc-217 变体只要求 2.17。
//   升级版本时必须先确认新版本存在 glibc-217 产物（并非每个小版本都有）：
//   https://unofficial-builds.nodejs.org/download/release/vX/node-vX-linux-x64-glibc-217.tar.gz
// 用法：node build.mjs [--skip-download]（跳过 Linux 版，只出 Windows 本地自测版）
// ============================================================
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const root = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(root, '..') // 主工程根（postject/esbuild 从它的 node_modules 取）
const releaseDir = path.join(root, 'release')
const distDir = path.join(root, 'dist')
const publicDir = path.join(root, 'src', 'public')
const skipDownload = process.argv.includes('--skip-download')

// Linux 产物绑定的 node 版本（blob 与宿主必须同版本，故 Windows 产物也用它）
const AGENT_NODE_VERSION = 'v24.21.0' // unofficial-builds 有该版本的 glibc-217 变体
const log = (m) => console.log('[agent-build] ' + m)

const require = createRequire(import.meta.url)

function sh(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts })
}

// 下载到本地（带缓存：文件已存在则跳过）
async function download(url, dest) {
  if (fs.existsSync(dest)) return
  log(`下载 ${path.basename(dest)} …`)
  const res = await fetch(url)
  if (!res.ok) {
    console.error(`下载失败 HTTP ${res.status}：${url}`)
    process.exit(1)
  }
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

// ---------- 0. 前置检查 ----------
if (!fs.existsSync(publicDir) || !fs.existsSync(path.join(publicDir, 'index.html'))) {
  console.error('缺少控制台构建产物：先在项目根目录运行 npm run build:agent')
  process.exit(1)
}

fs.mkdirSync(releaseDir, { recursive: true })
fs.mkdirSync(distDir, { recursive: true })

// ---------- 1. esbuild bundle（纯 CJS 单文件，零外部依赖） ----------
log('esbuild 打包…')
const esbuild = require('esbuild')
await esbuild.build({
  entryPoints: [path.join(root, 'src', 'index.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(distDir, 'agent.cjs'),
  logLevel: 'silent'
})

// ---------- 2. 选定宿主 node（生成 blob 与注入必须同一版本） ----------
// 完整构建：统一用 AGENT_NODE_VERSION 的 win-x64 node.exe（本机版本相同则直接复用）
// --skip-download：本机 node（仅出 Windows 自测版，blob/宿主同为本机，版本自洽）
// 注：直接下散装单文件 node.exe 而不是 win zip——构建环境里 tar 可能解析到
//     Git Bash 的 GNU tar（不认 zip 格式，只有 Windows 自带 bsdtar 认）
let hostNode = process.execPath
if (!skipDownload && process.versions.node !== AGENT_NODE_VERSION.slice(1)) {
  const mirror = process.env.NODEJS_MIRROR || 'https://npmmirror.com/mirrors/node'
  const exe = path.join(distDir, `node-${AGENT_NODE_VERSION}-win-x64.exe`)
  await download(`${mirror}/${AGENT_NODE_VERSION}/win-x64/node.exe`, exe)
  hostNode = exe
  if (fs.statSync(exe).size < 10 * 1048576) {
    console.error(`下载的 node.exe 异常（${fs.statSync(exe).size} 字节），请删除后重试：${exe}`)
    process.exit(1)
  }
}
log(`宿主 node：${AGENT_NODE_VERSION}（${skipDownload ? '本机 ' + process.versions.node + '（skip-download 模式）' : '构建绑定版本'}）`)

// ---------- 3. 生成 sea-config（assets：控制台静态文件逐个嵌入） ----------
log('生成 sea-config…')
const assets = {}
for (const f of walk(publicDir)) {
  assets[path.relative(publicDir, f).replace(/\\/g, '/')] = path.relative(root, f).replace(/\\/g, '/')
}
const seaConfig = {
  main: 'dist/agent.cjs',
  output: 'dist/sea-prep.blob',
  disableExperimentalSEAWarning: true,
  assets
}
fs.writeFileSync(path.join(root, 'sea-config.json'), JSON.stringify(seaConfig, null, 2))

sh(hostNode, ['--experimental-sea-config', 'sea-config.json'])

// ---------- 4. 注入 ----------
// postject 复用主工程依赖树里的版本（electron 打包器传递依赖，alpha.6 支持 SEA 所需全部选项）
const { inject } = require('postject')
const blob = fs.readFileSync(path.join(distDir, 'sea-prep.blob'))
const NODE_SEA_BLOB = 'NODE_SEA_BLOB'

async function injectTarget(target, label) {
  log(`注入 ${label}…`)
  await inject(target, NODE_SEA_BLOB, blob, {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    machoSegmentName: label.includes('win') ? undefined : 'NODE_SEA'
  })
}

// 4a. Windows 版（宿主即生成 blob 的 node，本地自测用）
const winTarget = path.join(releaseDir, 'longserve-agent.exe')
fs.copyFileSync(hostNode, winTarget)
await injectTarget(winTarget, 'Windows exe')

// 4b. Linux x64 版（unofficial glibc-217 变体，兼容老系统 glibc≥2.17）
if (!skipDownload) {
  // npmmirror 同步了 unofficial-builds 全量（unofficial-builds.org 直连国内仅 ~40KB/s）
  const mirror = process.env.NODE_UNOFFICIAL_MIRROR || 'https://registry.npmmirror.com/-/binary/node-unofficial-builds'
  const tgz = path.join(distDir, `node-${AGENT_NODE_VERSION}-linux-x64-glibc-217.tar.gz`)
  await download(`${mirror}/${AGENT_NODE_VERSION}/node-${AGENT_NODE_VERSION}-linux-x64-glibc-217.tar.gz`, tgz)
  log('解压 linux node（glibc-217）…')
  // tar 解到 distDir 下，顶层目录 node-vX-linux-x64-glibc-217（GNU tar 会把绝对路径的
  // 盘符冒号当远程主机，必须相对路径 + cwd 规避）
  fs.rmSync(path.join(distDir, `node-${AGENT_NODE_VERSION}-linux-x64-glibc-217`), { recursive: true, force: true })
  execFileSync('tar', ['-xzf', path.basename(tgz)], { cwd: distDir })
  const extracted = path.join(distDir, `node-${AGENT_NODE_VERSION}-linux-x64-glibc-217`, 'bin', 'node')
  const linuxTarget = path.join(releaseDir, 'longserve-agent')
  fs.copyFileSync(extracted, linuxTarget)
  fs.chmodSync(linuxTarget, 0o755)
  await injectTarget(linuxTarget, 'Linux binary (glibc-217)')

  // 自检：产物内引用的 GLIBC 符号版本必须 ≤ 2.17（防"误用官方构建"回归，
  // 官方 linux-x64 要求 2.28，老系统直接起不来）
  const maxMinor = maxGlibcMinor(linuxTarget)
  if (maxMinor > 17) {
    console.error(`自检失败：Linux 产物引用了 GLIBC_2.${maxMinor}（要求 ≤ 2.17）。`)
    console.error('疑似误用了官方构建（RHEL 8 基线，glibc≥2.28），老系统会启动失败，请检查下载源。')
    process.exit(1)
  }
  log(`GLIBC 自检通过：最高符号 GLIBC_2.${maxMinor}（≤ 2.17，老系统兼容）`)
}

log('完成 ✓ 产物：')
for (const f of fs.readdirSync(releaseDir)) {
  const st = fs.statSync(path.join(releaseDir, f))
  log(`  release/${f}  (${(st.size / 1048576).toFixed(1)} MB)`)
}

// 扫描 ELF 依赖的 GLIBC 符号第二段版本上限（如 GLIBC_2.17 → 17）。
// 符号名以明文存在于 .dynstr，直接全文匹配；按 minor 整数比较，
// 避免 GLIBC_2.2.5（minor=2，更老）被浮点比较误判为大于 2.17
function maxGlibcMinor(file) {
  const s = fs.readFileSync(file).toString('latin1')
  let max = 0
  for (const m of s.matchAll(/GLIBC_2\.(\d+)/g)) {
    const v = Number(m[1])
    if (v > max) max = v
  }
  return max
}

function walk(dir) {
  const out = []
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, it.name)
    if (it.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}
