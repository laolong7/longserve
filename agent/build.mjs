// ============================================================
// Longserve Agent 构建脚本：bundle → Node SEA 单二进制
// 产物：
//   release/longserve-agent        Linux x64（部署到服务器）
//   release/longserve-agent.exe    Windows x64（本地自测）
// 流程：esbuild 打包 src/index.js → sea-config 生成 blob →
//       注入 node 宿主二进制（本机版本号对应的官方 node，Linux 版从 npmmirror 下载）
// 用法：node build.mjs [--skip-download]（跳过 Linux 版，只出 Windows 版）
// ============================================================
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const root = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(root, '..') // 主工程根（postject/esbuild 从它的 node_modules 取）
const releaseDir = path.join(root, 'release')
const distDir = path.join(root, 'dist')
const publicDir = path.join(root, 'src', 'public')
const skipDownload = process.argv.includes('--skip-download')

const nodeVersion = process.versions.node
const log = (m) => console.log('[agent-build] ' + m)

const require = createRequire(import.meta.url)

function sh(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts })
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

// ---------- 2. 生成 sea-config（assets：控制台静态文件逐个嵌入） ----------
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

sh(process.execPath, ['--experimental-sea-config', 'sea-config.json'])

// ---------- 3. 注入 ----------
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

// 3a. Windows 本机版（复制当前 node.exe 注入，用于本地自测）
const winTarget = path.join(releaseDir, 'longserve-agent.exe')
fs.copyFileSync(process.execPath, winTarget)
await injectTarget(winTarget, 'Windows exe')

// 3b. Linux x64 版（下载官方 node linux-x64 解出二进制注入；SEA blob 与 node 版本绑定）
if (!skipDownload) {
  const mirror = process.env.NODEJS_MIRROR || 'https://npmmirror.com/mirrors/node'
  const url = `${mirror}/v${nodeVersion}/node-v${nodeVersion}-linux-x64.tar.gz`
  const tgz = path.join(distDir, `node-v${nodeVersion}-linux-x64.tar.gz`)
  if (!fs.existsSync(tgz)) {
    log(`下载 linux node v${nodeVersion}（npmmirror 镜像）…`)
    const res = await fetch(url)
    if (!res.ok) {
      console.error(`下载失败 HTTP ${res.status}：${url}`)
      console.error('可换源重试：NODEJS_MIRROR=https://mirrors.aliyun.com/nodejs-release node build.mjs')
      process.exit(1)
    }
    fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()))
  }
  log('解压 linux node…')
  const extractDir = path.join(distDir, `linux-node-${nodeVersion}`)
  fs.rmSync(extractDir, { recursive: true, force: true })
  fs.mkdirSync(extractDir, { recursive: true })
  // GNU tar 会把 "C:\..." 的盘符冒号当远程主机，必须用相对路径 + cwd 规避
  execFileSync('tar', ['-xzf', path.basename(tgz)], { cwd: distDir })
  const extracted = path.join(distDir, `node-v${nodeVersion}-linux-x64`, 'bin', 'node')
  const linuxTarget = path.join(releaseDir, 'longserve-agent')
  fs.copyFileSync(extracted, linuxTarget)
  fs.chmodSync(linuxTarget, 0o755)
  await injectTarget(linuxTarget, 'Linux binary')
}

log('完成 ✓ 产物：')
for (const f of fs.readdirSync(releaseDir)) {
  const st = fs.statSync(path.join(releaseDir, f))
  log(`  release/${f}  (${(st.size / 1048576).toFixed(1)} MB)`)
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
