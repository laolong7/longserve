// ============================================================
// 配置持久化
// userData/config.json：实例列表 + AI 多配置
// 密码与 apiKey 用 Electron safeStorage（Windows DPAPI）加密落盘
// ============================================================
const fs = require('fs')
const path = require('path')
const { safeStorage } = require('electron')

let configFile = null
let cache = null

function init(app) {
  configFile = path.join(app.getPath('userData'), 'config.json')
}

function defaults() {
  return {
    instances: [],          // { id, name, host, port, username, password }
    aiProviders: [],        // { id, name, baseUrl, apiKey, model }
    activeAiProviderId: null,
    seq: 0                  // id 生成计数器
  }
}

function normalize(raw) {
  const cfg = { ...defaults(), ...(raw || {}) }
  if (!Array.isArray(cfg.instances)) cfg.instances = []
  if (!Array.isArray(cfg.aiProviders)) cfg.aiProviders = []
  // 实例字段补全
  for (const inst of cfg.instances) {
    inst.id = inst.id || `inst_${Date.now()}_${++cfg.seq}`
    inst.port = Number(inst.port) || 22
    inst.name = inst.name || inst.host
    inst.username = inst.username || 'root'
  }
  for (const p of cfg.aiProviders) {
    p.id = p.id || `ai_${Date.now()}_${++cfg.seq}`
    p.name = p.name || '未命名配置'
  }
  return cfg
}

// ---------- 加解密 ----------
function encryptField(plain) {
  if (!plain) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plain).toString('base64')
  }
  // 兜底：明文前缀标记（极端环境，如部分 Linux 无 keyring）
  return 'plain:' + plain
}

function decryptField(stored) {
  if (!stored) return ''
  if (stored.startsWith('plain:')) return stored.slice(6)
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return ''
  }
}

// 读取（内存缓存；返回的对象允许渲染层直接修改后回传保存）
function load() {
  if (cache) return cache
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  } catch { /* 首次启动无配置文件 */ }

  const cfg = normalize(raw)
  for (const inst of cfg.instances) inst.password = decryptField(inst.password)
  for (const p of cfg.aiProviders) p.apiKey = decryptField(p.apiKey)
  cache = cfg
  return cfg
}

// 保存（深拷贝后加密敏感字段，缓存保持明文）
function save(cfg) {
  const clone = JSON.parse(JSON.stringify(cfg))
  for (const inst of clone.instances || []) inst.password = encryptField(inst.password)
  for (const p of clone.aiProviders || []) p.apiKey = encryptField(p.apiKey)
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  fs.writeFileSync(configFile, JSON.stringify(clone, null, 2), 'utf8')
  cache = normalize(JSON.parse(JSON.stringify(cfg)))
}

module.exports = { init, load, save }
