// ============================================================
// 配置与数据持久化（纯磁盘文件，不依赖任何数据库）
//   data/config.json   token / 端口 / AI 配置（部署时由桌面端注入）
//   data/chat.json     AI 会话历史（Agent 侧持有，换设备不丢对话）
//   data/audit.jsonl   操作审计日志（一行一条 JSON，追加写）
// 数据目录 = 进程工作目录下的 data/（systemd 部署时 WorkingDirectory=/opt/longserve-agent）
// ============================================================
const fs = require('fs')
const path = require('path')

const VERSION = '1.14.1'

let dataDir = null

function init(dir) {
  dataDir = dir || path.join(process.cwd(), 'data')
  fs.mkdirSync(dataDir, { recursive: true })
}

function dataPath() {
  return dataDir
}

const configPath = () => path.join(dataDir, 'config.json')
const chatPath = () => path.join(dataDir, 'chat.json')
const auditPath = () => path.join(dataDir, 'audit.jsonl')

// ---------- 配置 ----------
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'))
  } catch {
    return null // 首次启动尚未初始化（未部署/未注入配置）
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8')
  try { fs.chmodSync(configPath(), 0o600) } catch { /* Windows 无 chmod 语义，忽略 */ }
}

// ---------- 会话历史 ----------
// 结构 { messages: [OpenAI 风格消息]，assistant 消息保留 reasoning_content 供思考模式回传
function loadChat() {
  try {
    const raw = JSON.parse(fs.readFileSync(chatPath(), 'utf8'))
    return Array.isArray(raw.messages) ? raw.messages : []
  } catch {
    return []
  }
}

function saveChat(messages) {
  // 上限 80 条（约 20 轮工具往返），防止文件无限膨胀
  const trimmed = messages.length > 80 ? messages.slice(-80) : messages
  fs.writeFileSync(chatPath(), JSON.stringify({ savedAt: Date.now(), messages: trimmed }, null, 2), 'utf8')
}

function clearChat() {
  try { fs.unlinkSync(chatPath()) } catch { /* 本来就没有 */ }
}

// ---------- 审计日志（JSONL 追加） ----------
function appendAudit(rec) {
  fs.appendFileSync(auditPath(), JSON.stringify(rec) + '\n', 'utf8')
}

// 最近 limit 条（新的在前）
function readAudit(limit = 200) {
  let raw = ''
  try { raw = fs.readFileSync(auditPath(), 'utf8') } catch { return [] }
  const lines = raw.split('\n').filter(Boolean)
  return lines.slice(-limit).reverse().map((l) => {
    try { return JSON.parse(l) } catch { return { time: 0, note: '（损坏的日志行）' } }
  })
}

module.exports = { init, VERSION, dataPath, loadConfig, saveConfig, loadChat, saveChat, clearChat, appendAudit, readAudit }
