// store.js 预设技能/流水线注入与回填测试（mock electron safeStorage，不碰真实数据目录）
// 覆盖：首次全量注入 / 老配置一次性回填 / 版本标记后删除不复活 / 渲染层保存不丢标记
const fs = require('fs')
const path = require('path')
const os = require('os')
const Module = require('module')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'laoji-defaults-'))
let userDataDir = path.join(tmp, 'userData')
fs.mkdirSync(userDataDir, { recursive: true })

// mock electron：safeStorage 用可逆假实现
const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from('ENC:' + s, 'utf8'),
        decryptString: (b) => {
          const s = b.toString('utf8')
          if (!s.startsWith('ENC:')) throw new Error('bad ciphertext')
          return s.slice(4)
        }
      }
    }
  }
  return origLoad.call(this, request, ...rest)
}

const fakeApp = {
  getPath: (n) => (n === 'appData' ? tmp : userDataDir),
  setPath: () => {}
}

// 清 require 缓存模拟"重启应用"
function freshStore() {
  for (const k of Object.keys(require.cache)) {
    if (k.replace(/\\/g, '/').endsWith('main/store.js')) delete require.cache[k]
  }
  return require('../main/store.js')
}

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name) }
}

function readCfgFile() {
  return JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf8'))
}

console.log('场景 1：首次启动全量注入 4 技能 + 3 流水线（v3 无学子急事通），并落盘版本标记')
{
  const store = freshStore()
  store.init(fakeApp)
  const cfg = store.load()
  ok(cfg.skills.filter((s) => String(s.id).startsWith('sk_preset_')).length === 4, '注入 4 个预设技能')
  ok(cfg.pipelines.filter((p) => String(p.id).startsWith('pl_preset_')).length === 3, '注入 3 条预设流水线')
  ok(!cfg.skills.some((s) => s.id === 'sk_preset_deploy'), '不含「部署学子急事通」技能（牢笼个人项目不该做默认）')
  ok(!cfg.pipelines.some((p) => p.id === 'pl_preset_deploy'), '不含「学子急事通发布」流水线')
  ok(cfg.defaultsVersion === 3, '内存标记 defaultsVersion=3')
  const onDisk = readCfgFile()
  ok(onDisk.defaultsVersion === 3, '版本标记已落盘（删除预设后不会被回填复活）')
  ok(onDisk.pipelines.some((p) => p.id === 'pl_preset_nginx'), '含新增的 nginx 变更发布流水线')
  ok(onDisk.pipelines.some((p) => p.id === 'pl_preset_trouble'), '含新增的服务故障排查流水线')
}

console.log('场景 2：老配置（无版本标记）一次性回填缺失预设，保留用户自定义')
{
  userDataDir = path.join(tmp, 'userData2')
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify({
    instances: [],
    aiProviders: [],
    skills: [
      { id: 'sk_custom', name: '我的自定义技能', content: 'x', enabled: true },
      { id: 'sk_preset_health', name: '服务器体检（用户改过名）', content: 'y', enabled: true }
    ],
    pipelines: []
  }), 'utf8')
  const store = freshStore()
  store.init(fakeApp)
  const cfg = store.load()
  ok(cfg.skills.some((s) => s.id === 'sk_custom'), '自定义技能保留')
  ok(cfg.skills.find((s) => s.id === 'sk_preset_health').name === '服务器体检（用户改过名）', '用户改过的预设不被覆盖')
  ok(cfg.skills.filter((s) => String(s.id).startsWith('sk_preset_')).length === 4, '缺失的预设技能补齐到 4 个')
  ok(cfg.pipelines.filter((p) => String(p.id).startsWith('pl_preset_')).length === 3, '流水线补齐到 3 条')
  ok(Number(readCfgFile().defaultsVersion) === 3, '回填后落盘版本标记')
}

console.log('场景 3：版本标记已写入后，删除预设重启不复活')
{
  const store = freshStore()
  store.init(fakeApp)
  const cfg = store.load()
  cfg.skills = cfg.skills.filter((s) => s.id !== 'sk_preset_nginx')
  store.save(cfg)
  // 模拟重启
  const store2 = freshStore()
  store2.init(fakeApp)
  const cfg2 = store2.load()
  ok(!cfg2.skills.some((s) => s.id === 'sk_preset_nginx'), '已删的预设不会复活')
  ok(cfg2.defaultsVersion === 3, '版本标记仍在')
}

console.log('场景 5：v2 旧配置（含学子急事通预设）升级 → 退役清理 + 补齐新预设')
{
  userDataDir = path.join(tmp, 'userData3')
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify({
    instances: [],
    aiProviders: [],
    defaultsVersion: 2,
    skills: [
      { id: 'sk_custom', name: '我的技能', content: 'x', enabled: true },
      { id: 'sk_preset_health', name: '服务器体检', content: 'y', enabled: true },
      { id: 'sk_preset_deploy', name: '部署学子急事通', content: 'z', enabled: true }
    ],
    pipelines: [
      { id: 'pl_preset_deploy', name: '学子急事通发布', steps: [{ skillId: 'sk_preset_deploy', checkpoint: true }] },
      { id: 'pl_custom', name: '我的流水线', steps: [{ skillId: 'sk_custom', checkpoint: true }] }
    ]
  }), 'utf8')
  const store = freshStore()
  store.init(fakeApp)
  const cfg = store.load()
  ok(!cfg.skills.some((s) => s.id === 'sk_preset_deploy'), 'v2 配置里的学子急事通技能已退役删除')
  ok(!cfg.pipelines.some((p) => p.id === 'pl_preset_deploy'), 'v2 配置里的学子急事通流水线已退役删除')
  ok(cfg.pipelines.some((p) => p.id === 'pl_custom' && p.steps.length === 1), '用户自定义流水线保留')
  ok(cfg.skills.some((s) => s.id === 'sk_preset_nginx'), '缺失的新预设照常补齐')
  ok(cfg.defaultsVersion === 3, '迁移后版本标记升到 3')
}

console.log('场景 4：渲染层保存（带 defaultsVersion）后同样不复活')
{
  const store = freshStore()
  store.init(fakeApp)
  const cfg = store.load()
  // 模拟渲染层 config.js 的 save 载荷（含 defaultsVersion 透传）
  store.save({
    instances: [],
    aiProviders: [],
    activeAiProviderId: null,
    skills: cfg.skills.filter((s) => s.id !== 'sk_preset_clean'),
    pipelines: cfg.pipelines,
    recordDir: '',
    appearance: null,
    defaultsVersion: cfg.defaultsVersion,
    seq: 1
  })
  const store2 = freshStore()
  store2.init(fakeApp)
  const cfg2 = store2.load()
  ok(!cfg2.skills.some((s) => s.id === 'sk_preset_clean'), '渲染层保存后删除的预设不复活')
}

console.log(`\ntest-defaults: ${passed} 通过, ${failed} 失败`)
process.exitCode = failed ? 1 : 0
