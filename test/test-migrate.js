// 产品名改名数据迁移测试（Longserve）：模拟 userData 目录随 productName 变化
// 覆盖：改名全量搬迁（config+history+Local State）/ 新旧目录并存取新者 / Local State 补搬
const fs = require('fs')
const path = require('path')
const os = require('os')
const Module = require('module')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'laoji-migrate-'))
const appData = path.join(tmp, 'AppData')
fs.mkdirSync(appData, { recursive: true })

// mock electron：safeStorage 可逆假实现
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

let userDataDir = path.join(appData, 'Longserve')
const fakeApp = {
  name: 'Longserve',
  getPath: (n) => (n === 'appData' ? appData : userDataDir),
  setPath: () => {}
}

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

function writeLegacy(name, { config, history, state }) {
  const dir = path.join(appData, name)
  fs.mkdirSync(dir, { recursive: true })
  if (config) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config))
  if (history) fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(history))
  if (state) fs.writeFileSync(path.join(dir, 'Local State'), state)
}

console.log('场景 1：Laolong Server Utilities → Longserve 全量搬迁（含 Local State）')
{
  writeLegacy('Laolong Server Utilities', {
    config: { instances: [{ id: 'i1', name: '我的服务器', host: '1.2.3.4', password: Buffer.from('ENC:pw').toString('base64') }] },
    history: { sessions: [{ id: 's1' }] },
    state: 'STATE-BYTES-v2'
  })
  const store = freshStore()
  store.init(fakeApp)
  const cfg = store.load()
  ok(cfg.instances.length === 1 && cfg.instances[0].name === '我的服务器', 'config 迁移成功（实例无损）')
  ok(cfg.instances[0].password === 'pw', '密码随密钥正确解密（Local State 同步搬迁）')
  ok(fs.existsSync(path.join(userDataDir, 'Local State')), 'Local State 已搬到新目录')
  ok(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8') === 'STATE-BYTES-v2', 'Local State 内容一致')
  ok(JSON.parse(fs.readFileSync(path.join(userDataDir, 'history.json'), 'utf8')).sessions.length === 1, 'history 迁移成功')
}

console.log('场景 2：新旧目录并存 → 取最近的 Laolong Server Utilities，不取过期的牢笼服务器工具')
{
  userDataDir = path.join(appData, 'Longserve2')
  writeLegacy('牢笼服务器工具', {
    config: { instances: [{ id: 'old', name: '过期数据' }] },
    state: 'STATE-OLD'
  })
  writeLegacy('Laolong Server Utilities', {
    config: { instances: [{ id: 'new', name: '最新数据' }] },
    state: 'STATE-NEW'
  })
  const store = freshStore()
  store.init(fakeApp)
  const cfg = store.load()
  ok(cfg.instances.length === 1 && cfg.instances[0].name === '最新数据', '取到新目录的数据（旧目录被忽略）')
  ok(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8') === 'STATE-NEW', 'Local State 与 config 同源')
}

console.log('场景 3：config 已在新目录、Local State 缺失 → 补搬密钥（记录 #10 的历史场景）')
{
  userDataDir = path.join(appData, 'Longserve3')
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify({
    instances: [{ id: 'i1', name: '已有配置', password: Buffer.from('ENC:pw2').toString('base64') }]
  }))
  const store = freshStore()
  store.init(fakeApp)
  const cfg = store.load()
  ok(fs.existsSync(path.join(userDataDir, 'Local State')), 'Local State 从旧目录补搬')
  ok(cfg.instances[0].password === 'pw2', '补搬后密码解密成功')
}

console.log('场景 4：全新安装（无任何旧目录）→ 不炸、走预设注入')
{
  // 清掉前面场景的旧目录夹具，模拟真正干净的机器
  for (const n of ['Laolong Server Utilities', '牢笼服务器工具']) {
    fs.rmSync(path.join(appData, n), { recursive: true, force: true })
  }
  userDataDir = path.join(appData, 'Longserve-fresh')
  const store = freshStore()
  store.init(fakeApp)
  const cfg = store.load()
  ok(cfg.skills.length > 0 && cfg.pipelines.length > 0, '预设技能/流水线正常注入')
  ok(!fs.existsSync(path.join(userDataDir, 'Local State')), '没有旧数据时不搬多余文件')
}

console.log(`\ntest-migrate: ${passed} 通过, ${failed} 失败`)
process.exitCode = failed ? 1 : 0
