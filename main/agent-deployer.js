// ============================================================
// Longserve 手机控制 Agent 部署器
// 通过现有 SSH 连接把 agent 单二进制部署到服务器：
//   上传二进制 → 注入配置(token+AI) → systemd 常驻 → 防火墙放行 → 健康检查
// 设计约束：
//   - 只写 /opt/longserve-agent 与自己的 systemd unit，不碰任何现有服务
//   - 端口独立监听（默认 37777），与 nginx/gunicorn 等完全无关
//   - 重部署保留服务器上已有 token（手机不用重新扫码）
//   - 配置文件经 base64 通道写入，规避 shell 引号转义问题
// ============================================================
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const REMOTE_DIR = '/opt/longserve-agent'
const SERVICE = 'longserve-agent'
const PORT_DEFAULT = 37777

// agent 二进制位置：打包后在 resources/agent/，开发时在 agent/release/
function agentBinaryPath(app) {
  if (app.isPackaged) return path.join(process.resourcesPath, 'agent', 'longserve-agent')
  return path.join(__dirname, '..', 'agent', 'release', 'longserve-agent')
}

function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

// exec 适配层：SshManager.exec 成功 resolve { code, stdout }、失败直接 reject，
// 而部署器内部统一用 { ok, code, stdout, error } 形状判断。这里做归一化，
// 并对瞬时失败（上传后线路抖动）自动重试一次。
// 历史教训（v1.11.2 修复）：writeRemoteFile/readRemoteFile 曾按 (connId, cmd, timeout)
// 三参调用，而包装器签名为 (cmd, timeout)——命令串被当成 timeout 塞进 setTimeout，
// 1ms 后必然抛「命令超时（NaNs）」，表现为"部署永远假超时、提示 SSH 断开"。
function makeExec(sshManager, connId) {
  return async (cmd, timeout) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await sshManager.exec(connId, cmd, timeout)
        return { ok: true, code: r.code, stdout: r.stdout }
      } catch (err) {
        if (attempt >= 1) return { ok: false, error: err.message }
        await new Promise((res) => setTimeout(res, 800))
      }
    }
  }
}

// 远程写文本文件（base64 通道：内容里的引号/换行/$ 都不会破坏 shell）
async function writeRemoteFile(ssh, remotePath, content) {
  const b64 = Buffer.from(content, 'utf8').toString('base64')
  const dir = path.posix.dirname(remotePath)
  const r = await ssh.exec(
    `mkdir -p ${shQuote(dir)} && echo ${shQuote(b64)} | base64 -d > ${shQuote(remotePath)}`,
    20000
  )
  if (!r.ok) throw new Error('远程写入失败：' + r.error)
  if (r.code !== 0) throw new Error('远程写入失败（退出码 ' + r.code + '）')
}

async function readRemoteFile(ssh, remotePath) {
  const r = await ssh.exec(`cat ${shQuote(remotePath)} 2>/dev/null`, 10000)
  if (!r.ok || r.code !== 0) return null
  try { return JSON.parse(r.stdout) } catch { return null }
}

// 远程读文本文件原文（JSONL 等非单 JSON 的文件用）
async function readRemoteText(ssh, remotePath) {
  const r = await ssh.exec(`cat ${shQuote(remotePath)} 2>/dev/null`, 15000)
  if (!r.ok || r.code !== 0) return null
  return String(r.stdout || '')
}

// 解析 `ldd --version` 首行，判断目标机 libc：
//   glibc：'ldd (Ubuntu GLIBC 2.31-0ubuntu9.16) 2.31' / 'ldd (GNU libc) 2.17' → { musl:false, version:'2.31', minor:31 }
//   musl：'musl libc (x86_64)' → { musl:true }（glibc 构建的二进制在 musl 上跑不了）
//   解析不出 → null（不阻塞部署，交给启动阶段暴露）
function parseGlibcVersion(line) {
  if (/musl/i.test(line || '')) return { musl: true }
  const m = (line || '').match(/(\d+)\.(\d+)/)
  if (!m) return null
  return { musl: false, version: m[1] + '.' + m[2], minor: Number(m[2]) }
}

class AgentDeployer {
  constructor(sshManager, sftpManager) {
    this.ssh = sshManager
    this.sftpProvider = sftpManager
  }

  // 部署。opts: { connId, instance, aiProvider, port, onStep(progress) }
  // progress: { phase, percent, msg }（percent: 0-100 总进度，上传阶段按实际传输映射）
  // aiProvider: 桌面端 AI 配置 { name, protocol, baseUrl, apiKey, model, reasoningBack }
  // 步骤刻意排序：小命令（配置/unit）在连接最健康时先做完，大体积上传放中间，
  // 最后只留启动+健康检查——避免 100MB+ 上传后连接劣化导致关键步骤超时
  async deploy(app, opts) {
    const { connId, instance, aiProvider, port = PORT_DEFAULT, onStep = () => {} } = opts
    const report = (phase, percent, msg) => onStep({ phase, percent, msg })
    const ssh = { exec: makeExec(this.ssh, connId) }

    // 0. 本地二进制检查
    report('check', 3, '检查 Agent 程序包…')
    const bin = agentBinaryPath(app)
    if (!fs.existsSync(bin)) throw new Error('未找到 Agent 程序包（agent/release/longserve-agent），请先构建：node agent/build.mjs')
    const binSize = fs.statSync(bin).size

    // 0.5 glibc 预检（v1.11.3：Agent 二进制为 glibc-217 构建，要求 glibc ≥ 2.17；
    //     musl/Alpine 不支持。官方构建要求 ≥ 2.28 的坑在老系统上必现，提前拦住给明确报错）
    report('check', 4, '检测系统 libc…')
    const glibc = await this.checkGlibc(ssh)
    if (glibc && glibc.musl) {
      throw new Error('该服务器是 musl libc（Alpine 等），Agent 为 glibc 构建暂不支持部署到这类系统')
    }
    if (glibc && glibc.minor < 17) {
      throw new Error(`该服务器 glibc ${glibc.version} 过老（Agent 需 ≥ 2.17，即 CentOS 7 / Debian 9 及之后），暂不支持部署`)
    }
    report('check', 5, glibc ? `glibc ${glibc.version} ✓` : 'libc 版本未识别（跳过预检）')

    // 1. 端口预检（ss 不存在则跳过，失败靠启动阶段暴露）
    report('check', 6, '检测端口占用…')
    const portBusy = await this.checkPort(ssh, port)
    if (portBusy) throw new Error(`端口 ${port} 已被占用，请换一个端口再部署`)

    // 2. 生成 token 与配置（纯 exec 小命令，连接最健康时先做完；
    //    此阶段刻意不开 sftp 通道——sshd MaxSessions 紧的服务器上
    //    "shell + sftp" 已占满会话位，再开 exec 会卡到超时）
    report('config', 10, '生成配置（token + AI 密钥）…')
    const existing = await readRemoteFile(ssh, REMOTE_DIR + '/data/config.json')
    const token = existing && existing.token ? existing.token : crypto.randomBytes(24).toString('hex')
    const config = {
      token,
      port: Number(port) || PORT_DEFAULT,
      ai: {
        name: aiProvider.name || '',
        protocol: aiProvider.protocol === 'anthropic' ? 'anthropic' : 'openai',
        baseUrl: aiProvider.baseUrl || '',
        apiKey: aiProvider.apiKey || '',
        model: aiProvider.model || '',
        reasoningBack: aiProvider.reasoningBack !== false,
        // 高级出口：思考字段名 / 附加请求体 / 自定义请求头（支持所有类型 AI）
        reasoningField: aiProvider.reasoningField || 'auto',
        extraBody: aiProvider.extraBody || '',
        extraHeaders: aiProvider.extraHeaders || ''
      },
      createdAt: existing && existing.createdAt ? existing.createdAt : Date.now(),
      updatedAt: Date.now()
    }
    await writeRemoteFile(ssh, REMOTE_DIR + '/data/config.json', JSON.stringify(config, null, 2))
    await ssh.exec(`chmod 600 ${shQuote(REMOTE_DIR + '/data/config.json')}`, 10000)

    // 3. systemd unit 先注册好（启动时二进制已就位即可生效）
    report('config', 14, '注册 systemd 服务…')
    const unit = [
      '[Unit]',
      'Description=Longserve Agent (mobile console)',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `WorkingDirectory=${REMOTE_DIR}`,
      `ExecStart=${REMOTE_DIR}/longserve-agent --port=${config.port}`,
      'Restart=always',
      'RestartSec=5',
      'NoNewPrivileges=true',
      '',
      '[Install]',
      'WantedBy=multi-user.target'
    ].join('\n')
    await writeRemoteFile(ssh, '/etc/systemd/system/' + SERVICE + '.service', unit)
    await ssh.exec('systemctl daemon-reload', 15000)

    // 4. 上传二进制（最大耗时步骤，进度条主体；sftp 一次性会话，用完即关）
    report('upload', 15, `上传 Agent 程序包（${(binSize / 1048576).toFixed(1)} MB）…`)
    const mk = await ssh.exec(`mkdir -p ${shQuote(REMOTE_DIR)}`, 10000)
    if (!mk.ok) throw new Error('创建远程目录失败：' + mk.error)
    const session = await this.sftpProvider.openSession(connId)
    try {
      await this.putFile(session.sftp, bin, REMOTE_DIR + '/longserve-agent', (p) => {
        report('upload', 15 + Math.floor((p.percent / 100) * 70), `上传中 ${p.percent}%`)
      })
    } finally {
      // 关键：立即释放 sftp 子系统。部分服务器 sshd MaxSessions 收得很紧（1-2），
      // sftp 通道不关，后续 exec 会被卡到超时（实测踩坑：命令超时假象）
      session.close()
    }
    report('upload', 86, '上传完成，设置执行权限…')
    await ssh.exec(`chmod +x ${shQuote(REMOTE_DIR + '/longserve-agent')}`, 15000)

    // 5. 启动服务
    report('service', 90, '启动 Agent 服务…')
    const up = await ssh.exec(`systemctl enable --now ${SERVICE} && systemctl restart ${SERVICE}`, 25000)
    if (!up.ok || up.code !== 0) {
      throw new Error('systemd 启动失败：' + (up.stdout || up.error || '未知错误') + '（老系统无 systemd 时不支持自动部署）')
    }

    // 6. 防火墙放行（best effort，失败不阻塞——云安全组需用户自行放行）
    report('service', 94, '放行本机防火墙端口…')
    await this.openFirewall(ssh, config.port)

    // 7. 健康检查
    report('health', 97, '健康检查…')
    const healthy = await this.waitHealthy(ssh, config.port, 15)
    if (!healthy) {
      const logs = await ssh.exec(`journalctl -u ${SERVICE} -n 20 --no-pager 2>/dev/null || echo '（无法读取日志）'`, 15000)
      throw new Error('Agent 启动后未响应健康检查。最近日志：\n' + (logs.stdout || '').slice(-1500))
    }

    report('done', 100, '部署完成 ✓')
    return { host: instance.host, port: config.port, token }
  }

  // 重新生成 token（解绑所有已扫码设备）：改配置 → 重启 → 返回新 token
  async regenerateToken(connId, port) {
    const ssh = { exec: makeExec(this.ssh, connId) }
    const cfg = await readRemoteFile(ssh, REMOTE_DIR + '/data/config.json')
    if (!cfg) throw new Error('该服务器尚未部署 Agent')
    cfg.token = crypto.randomBytes(24).toString('hex')
    cfg.updatedAt = Date.now()
    await writeRemoteFile(ssh, REMOTE_DIR + '/data/config.json', JSON.stringify(cfg, null, 2))
    const r = await ssh.exec(`systemctl restart ${SERVICE}`, 20000)
    if (!r.ok || r.code !== 0) throw new Error('重启 Agent 失败：' + (r.stdout || r.error))
    const okHealth = await this.waitHealthy(ssh, cfg.port || port, 10)
    if (!okHealth) throw new Error('重启后健康检查未通过，请到服务器上查看 journalctl -u ' + SERVICE)
    return { token: cfg.token, port: cfg.port || port }
  }

  // 卸载（桌面端会先二次确认）
  async undeploy(connId) {
    const ssh = { exec: makeExec(this.ssh, connId) }
    const r = await ssh.exec(
      `systemctl disable --now ${SERVICE} 2>/dev/null; rm -f /etc/systemd/system/${SERVICE}.service; systemctl daemon-reload 2>/dev/null; rm -rf ${REMOTE_DIR}`,
      30000
    )
    if (!r.ok) throw new Error('卸载失败：' + r.error)
    return { ok: true }
  }

  // 运行状态（systemctl is-active + 健康检查）
  async status(connId, port) {
    const ssh = { exec: makeExec(this.ssh, connId) }
    const svc = await ssh.exec(`systemctl is-active ${SERVICE} 2>/dev/null`, 8000)
    const active = svc.ok && svc.stdout.trim() === 'active'
    const healthy = active ? await this.waitHealthy(ssh, port, 4) : false
    return { active, healthy }
  }

  // 手机端记录（磁盘直读）：指令记录 audit.jsonl + 聊天记录 chat.json
  // 桌面端「手机控制」面板展示网页/手机端的操作历史用
  async readRecords(connId) {
    const ssh = { exec: makeExec(this.ssh, connId) }
    const [auditRaw, chatRaw] = await Promise.all([
      readRemoteText(ssh, REMOTE_DIR + '/data/audit.jsonl'),
      readRemoteText(ssh, REMOTE_DIR + '/data/chat.json')
    ])
    const audit = String(auditRaw || '')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l) } catch { return null }
      })
      .filter(Boolean)
    let chat = []
    try {
      const j = JSON.parse(chatRaw || '')
      chat = Array.isArray(j.messages) ? j.messages : []
    } catch { /* 文件不存在/损坏 → 空记录 */ }
    return { audit, chat }
  }

  // ---------- 内部 ----------
  // glibc 预检：失败/识别不出返回 null，不阻塞部署
  async checkGlibc(ssh) {
    const r = await ssh.exec('ldd --version 2>&1 | head -1', 8000)
    if (!r.ok) return null
    return parseGlibcVersion(String(r.stdout || '').split('\n')[0] || '')
  }

  async checkPort(ssh, port) {
    const r = await ssh.exec(`ss -tln 2>/dev/null | grep -q ':${Number(port)} ' && echo BUSY || echo FREE`, 8000)
    if (!r.ok) return false // 探测失败当作空闲，交给启动阶段兜底
    return r.stdout.includes('BUSY')
  }

  async openFirewall(ssh, port) {
    // ufw / firewalld 二选一，存在才操作；云安全组（阿里云/腾讯云控制台）工具碰不到
    await ssh.exec(
      `command -v ufw >/dev/null 2>&1 && ufw allow ${Number(port)}/tcp 2>/dev/null; ` +
      `command -v firewall-cmd >/dev/null 2>&1 && (firewall-cmd --add-port=${Number(port)}/tcp --permanent 2>/dev/null && firewall-cmd --reload 2>/dev/null); ` +
      'true',
      15000
    )
  }

  async waitHealthy(ssh, port, tries = 10) {
    const p = Number(port)
    for (let i = 0; i < tries; i++) {
      const r = await ssh.exec(
        `curl -s -m 2 http://127.0.0.1:${p}/api/health 2>/dev/null || wget -qO- -T 2 http://127.0.0.1:${p}/api/health 2>/dev/null`,
        6000
      )
      if (r.ok && r.stdout.includes('"ok":true')) return true
      await new Promise((res) => setTimeout(res, 1000))
    }
    return false
  }

  putFile(sftp, localPath, remotePath, onPercent) {
    return new Promise((resolve, reject) => {
      const size = fs.statSync(localPath).size
      sftp.fastPut(localPath, remotePath, {
        step: (transferred) => {
          const percent = Math.floor((transferred / size) * 100)
          if (onPercent && percent % 10 === 0) onPercent({ percent })
        }
      }, (err) => (err ? reject(new Error('上传失败：' + err.message)) : resolve()))
    })
  }
}

// makeExec / writeRemoteFile / readRemoteFile / readRemoteText / parseGlibcVersion 导出供契约测试使用
module.exports = { AgentDeployer, agentBinaryPath, REMOTE_DIR, SERVICE, PORT_DEFAULT, makeExec, writeRemoteFile, readRemoteFile, readRemoteText, parseGlibcVersion }
