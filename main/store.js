// ============================================================
// 配置持久化
// userData/config.json：实例列表 + AI 多配置
// 密码与 apiKey 用 Electron safeStorage（Windows DPAPI）加密落盘
// ============================================================
const fs = require('fs')
const path = require('path')
const { safeStorage } = require('electron')

let configFile = null
let historyFile = null
let cache = null
let firstRun = false

function init(app) {
  applyCustomDataDir(app)
  configFile = path.join(app.getPath('userData'), 'config.json')
  historyFile = path.join(app.getPath('userData'), 'history.json')
  firstRun = !fs.existsSync(configFile)
  migrateFromLegacyName(app)
}

// ---------- 数据目录管理（设置→数据） ----------
// bootstrap 文件固定在 %APPDATA% 下，记录自定义数据目录；没有则用默认 userData
function bootstrapPath(app) {
  return path.join(app.getPath('appData'), 'laolong-data-location.txt')
}

function applyCustomDataDir(app) {
  try {
    const bp = bootstrapPath(app)
    if (!fs.existsSync(bp)) return false
    const custom = fs.readFileSync(bp, 'utf8').trim()
    if (!custom || !fs.existsSync(custom)) return false
    app.setPath('userData', custom)
    return true
  } catch { return false }
}

// 数据目录三件套：config + history + Local State（safeStorage 密钥，缺一不可）
function copyDataFiles(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true })
  for (const f of ['config.json', 'history.json', 'Local State']) {
    const s = path.join(srcDir, f)
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dstDir, f))
  }
}

function changeDataDir(app, newDir) {
  const cur = app.getPath('userData')
  if (path.resolve(newDir) === path.resolve(cur)) return { ok: false, error: '新目录与当前目录相同' }
  copyDataFiles(cur, newDir)
  fs.writeFileSync(bootstrapPath(app), newDir, 'utf8')
  return { ok: true }
}

function resetDataDir(app) {
  const bp = bootstrapPath(app)
  const custom = fs.existsSync(bp) ? fs.readFileSync(bp, 'utf8').trim() : ''
  const def = path.join(app.getPath('appData'), 'Laolong Server Utilities')
  if (custom && fs.existsSync(custom)) copyDataFiles(custom, def)
  if (fs.existsSync(bp)) fs.unlinkSync(bp)
  return { ok: true }
}

// 产品名改为 Laolong Server Utilities 后 userData 目录随之变化，
// 首次启动时把旧目录（牢笼服务器工具）里的数据搬过来，无缝升级
// ⚠️ Local State 必须一起搬：safeStorage 的 AES 解密密钥存于其中，
// 漏搬会导致所有密码/apiKey 解密失败（SSH 连不上、AI 401）
function migrateFromLegacyName(app) {
  try {
    const legacyDir = path.join(app.getPath('appData'), '牢笼服务器工具')
    const newDir = path.dirname(configFile)
    // Local State 即使 config 已存在也要补搬（修复过一次的历史残留场景）
    const legacyState = path.join(legacyDir, 'Local State')
    const newState = path.join(newDir, 'Local State')
    if (fs.existsSync(legacyState) && !fs.existsSync(newState)) {
      fs.mkdirSync(newDir, { recursive: true })
      fs.copyFileSync(legacyState, newState)
      console.log('[store] 已补搬 safeStorage 密钥文件（Local State）')
    }
    if (fs.existsSync(configFile)) return // 配置已有，无需再搬
    const legacyConfig = path.join(legacyDir, 'config.json')
    if (!fs.existsSync(legacyConfig)) return
    fs.mkdirSync(newDir, { recursive: true })
    fs.copyFileSync(legacyConfig, configFile)
    const legacyHistory = path.join(legacyDir, 'history.json')
    if (fs.existsSync(legacyHistory)) fs.copyFileSync(legacyHistory, historyFile)
    console.log('[store] 已从旧配置目录迁移数据')
  } catch (err) {
    console.log('[store] 配置迁移失败（不影响启动）:', err.message)
  }
}

function defaults() {
  return {
    instances: [],          // { id, name, host, port, username, password }
    aiProviders: [],        // { id, name, baseUrl, apiKey, model }
    activeAiProviderId: null,
    skills: [],             // { id, name, description, content, enabled }
    pipelines: [],          // { id, name, steps: [{ skillId, checkpoint }] } 技能流水线
    recordDir: '',          // 会话录制保存目录（空=默认 userData/recordings）
    appearance: null,       // { accent, text, bgHue, bgAlpha } null=默认主题
    seq: 0                  // id 生成计数器
  }
}

function normalize(raw) {
  const cfg = { ...defaults(), ...(raw || {}) }
  if (!Array.isArray(cfg.instances)) cfg.instances = []
  if (!Array.isArray(cfg.aiProviders)) cfg.aiProviders = []
  if (!Array.isArray(cfg.skills)) cfg.skills = []
  if (!Array.isArray(cfg.pipelines)) cfg.pipelines = []
  if (typeof cfg.recordDir !== 'string') cfg.recordDir = ''
  if (!cfg.appearance || typeof cfg.appearance !== 'object') cfg.appearance = null
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
  for (const s of cfg.skills) {
    s.id = s.id || `sk_${Date.now()}_${++cfg.seq}`
    s.enabled = s.enabled !== false
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
    // 解密失败返回哨兵值：设置界面据此提示用户重新填写
    return '\u0000DECRYPT_FAILED'
  }
}

// 预设技能/流水线（仅首次启动注入一次，之后完全归用户管理，删了不会复活）
const DEFAULT_SKILLS = [
  {
    id: 'sk_preset_health', name: '服务器体检', enabled: true,
    description: '当要求检查服务器状态/健康/负载时使用',
    content: '对当前服务器做一次全面体检，按顺序执行并汇报：\n1. uptime（负载）与 last -5（最近登录）\n2. free -m（内存）与 df -h（磁盘，重点关注使用率 80%+ 的分区）\n3. top -bn1 | head -15（占用最高的进程）\n4. systemctl --failed（失败的服务）\n最后汇总成清单：健康项 / 需要注意的问题 / 处理建议。全程只读操作。'
  },
  {
    id: 'sk_preset_nginx', name: 'nginx 配置检查与重载', enabled: true,
    description: '当要求修改/检查/重载 nginx 配置时使用',
    content: 'nginx 操作守则：\n1. 任何修改前先 backup_file 备份 /etc/nginx/nginx.conf 及相关站点配置\n2. 修改后必须先 nginx -t 校验语法；校验失败立即 restore_file 还原并报告错误\n3. 校验通过后 systemctl reload nginx（用 reload 不用 restart，避免中断连接）\n4. reload 后 curl -sI http://127.0.0.1 确认响应，read_terminal 汇报结果'
  },
  {
    id: 'sk_preset_logs', name: '服务日志排查', enabled: true,
    description: '当要求查看/排查某个服务的日志时使用',
    content: '日志排查流程：\n1. 确认服务名：systemctl list-units --type=service | grep 关键词\n2. journalctl -u 服务名 --since "1 hour ago" --no-pager -n 200 看近期日志\n3. 应用日志去 /var/log/ 下找对应文件 tail -n 200\n4. 归纳重复出现的报错模式，给出结论与修复建议。只读操作。'
  },
  {
    id: 'sk_preset_deploy', name: '部署学子急事通', enabled: true,
    description: '当要求部署/更新/重启学子急事通服务时使用',
    content: '学子急事通部署流程（路径 /var/www/student_emergency）：\n1. backup_file 备份 backend 目录下的关键配置\n2. cd /var/www/student_emergency && git pull（或按用户给的源更新）\n3. 确认 frontend/dist 为最新构建\n4. systemctl restart gunicorn，read_terminal 确认无报错\n5. curl -sI http://127.0.0.1 检查响应；异常时 journalctl -u gunicorn -n 50 排查，必要时 restore_file 回滚'
  },
  {
    id: 'sk_preset_clean', name: '磁盘清理', enabled: true,
    description: '当磁盘空间紧张，要求清理空间时使用',
    content: '磁盘清理守则（保守优先）：\n1. df -h 找大分区，du -sh /var/log /tmp /var/cache 逐层定位大头\n2. 只清安全项：journalctl --vacuum-size=200M、包管理缓存（apt clean / yum clean all）\n3. 大日志用 truncate -s 0 截断（不删文件，避免服务句柄问题）；删除任何文件前必须弹窗确认\n4. 清理前后各跑一次 df -h，对比汇报释放了多少空间'
  }
]
const DEFAULT_PIPELINES = [
  {
    id: 'pl_preset_checkup', name: '服务器例行体检',
    steps: [
      { skillId: 'sk_preset_health', checkpoint: true },
      { skillId: 'sk_preset_clean', checkpoint: true }
    ]
  },
  {
    id: 'pl_preset_deploy', name: '学子急事通发布',
    steps: [
      { skillId: 'sk_preset_health', checkpoint: true },
      { skillId: 'sk_preset_deploy', checkpoint: true },
      { skillId: 'sk_preset_logs', checkpoint: true }
    ]
  }
]

// 读取（内存缓存；返回的对象允许渲染层直接修改后回传保存）
function load() {
  if (cache) return cache
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  } catch { /* 首次启动无配置文件 */ }

  const cfg = normalize(raw)
  // 首次启动注入预设技能/流水线（之后归用户管理，删了不复活）
  if (firstRun && !cfg.skills.length) cfg.skills = JSON.parse(JSON.stringify(DEFAULT_SKILLS))
  if (firstRun && !cfg.pipelines.length) cfg.pipelines = JSON.parse(JSON.stringify(DEFAULT_PIPELINES))
  for (const inst of cfg.instances) inst.password = decryptField(inst.password)
  for (const p of cfg.aiProviders) p.apiKey = decryptField(p.apiKey)
  cache = cfg
  return cfg
}

// 某字段是否为解密失败哨兵
function isDecryptFailed(v) {
  return v === '\u0000DECRYPT_FAILED'
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

// ---------- AI 历史会话（独立文件，不加密，结构与 config 分离） ----------
function loadHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(historyFile, 'utf8'))
    return Array.isArray(raw.sessions) ? raw.sessions : []
  } catch {
    return []
  }
}

function saveHistory(sessions) {
  fs.mkdirSync(path.dirname(historyFile), { recursive: true })
  fs.writeFileSync(historyFile, JSON.stringify({ sessions }, null, 2), 'utf8')
}

module.exports = {
  init, load, save, loadHistory, saveHistory,
  applyCustomDataDir, changeDataDir, resetDataDir
}
