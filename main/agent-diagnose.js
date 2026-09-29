// ============================================================
// AI 部署失败诊断：把部署错误信息（含 journalctl 日志）交给 AI 分析，
// 返回结构化 { rootCause, fix, confidence }，UI 直接展示"根因 + 怎么修"
// 复用 ai-proxy 的 chatStream —— 双协议（OpenAI/Anthropic）、候选地址
// 重试、非流式兜底、超时看门狗全部白拿；主进程内收集增量成完整文本
// 设计约束：诊断失败绝不影响错误展示（UI 拿不到诊断就只显示原始日志）
// ============================================================
const { chatStream } = require('./ai-proxy')

// 一次性（非流式语义）调用：主进程内收集 delta 拼成全文，done 后 resolve
function chatOnce(provider, messages, timeoutMs) {
  return new Promise((resolve, reject) => {
    let text = ''
    chatStream(
      {
        eventId: 'agent-diag-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        provider,
        body: { messages, temperature: 0.2 },
        timeouts: { first: 20000, idle: 30000, total: timeoutMs || 90000 }
      },
      (type, data) => {
        if (type === 'delta') {
          if (data.content) text += data.content
          // 思考型模型的推理增量不进结果（只要结论）
        } else if (type === 'done') {
          resolve(text.trim())
        } else if (type === 'error') {
          reject(new Error(data.message || 'AI 请求失败'))
        }
      }
    )
  })
}

// 解析 AI 输出的 JSON（容忍 ```json 包裹、前后杂文；解析失败降级为纯文本）
function parseDiagnosis(text) {
  const t = String(text || '').trim()
  const stripped = t.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(stripped.slice(start, end + 1))
      if (j && (j.rootCause || j.fix)) {
        return {
          rootCause: String(j.rootCause || ''),
          fix: String(j.fix || ''),
          confidence: ['high', 'medium', 'low'].includes(j.confidence) ? j.confidence : 'medium'
        }
      }
    } catch { /* 落到纯文本兜底 */ }
  }
  // AI 没按 JSON 说（或胡言乱语）：原文直接给用户，标注把握低
  return t
    ? { rootCause: t.slice(0, 600), fix: '', confidence: 'low' }
    : { rootCause: '（AI 返回了空内容）', fix: '', confidence: 'low' }
}

// 部署失败诊断入口。provider: 桌面端 AI 配置（与部署时所选一致）；errorText: 部署器抛出的完整错误
async function diagnoseDeploy(provider, errorText) {
  const logs = String(errorText || '').slice(0, 6000) // 日志截断，防超长撑爆上下文
  const messages = [
    {
      role: 'system',
      content:
        '你是 Linux 服务器运维专家，擅长分析 systemd 服务与部署故障。只输出要求的 JSON，不要 markdown 代码块，不要多余解释。'
    },
    {
      role: 'user',
      content:
        'Longserve Agent（Node.js 单二进制，systemd 服务名 longserve-agent，独立端口监听）通过 SSH 部署到 Linux 服务器后健康检查失败。\n' +
        '部署流程：上传二进制到 /opt/longserve-agent/ → 写入配置 → 注册 systemd unit → systemctl restart → 轮询 curl http://127.0.0.1:<端口>/api/health 15 次均无响应。\n\n' +
        '=== 部署错误信息（含 journalctl 日志）===\n' +
        logs +
        '\n\n=== 任务 ===\n' +
        '分析根因，输出严格 JSON（中文）：\n' +
        '{"rootCause": "一句话根因", "fix": "具体修复步骤，含需要的命令，用 \\n 分行", "confidence": "high|medium|low"}\n' +
        '常见可能：glibc/libc 版本不兼容、端口被占用、防火墙/安全组拦截、配置文件损坏、磁盘满、systemd unit 错误。若日志不足以定位，confidence 填 low，fix 里说明还需什么信息。'
    }
  ]
  const text = await chatOnce(provider, messages)
  return parseDiagnosis(text)
}

module.exports = { diagnoseDeploy, parseDiagnosis }
