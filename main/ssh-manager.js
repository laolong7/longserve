// ============================================================
// SSH 连接管理器
// 每个连接：Client + shell 流，数据经 IPC 转发给渲染层的 xterm
// attach 缓冲机制：shell 数据先入缓冲，渲染层订阅后一次性 flush，
// 保证欢迎信息（MOTD）等首屏数据不丢失、不重复
// ============================================================
const { Client } = require('ssh2')

const MAX_PENDING = 512 * 1024 // 未订阅时的数据缓冲上限 512KB

class SshManager {
  constructor(send) {
    this.send = send
    this.conns = new Map() // connId -> { conn, shellStream, pending, attached, closed }
    this.seq = 0
  }

  // 建立连接并打开 shell，resolve({ connId })
  connect(instance) {
    return new Promise((resolve, reject) => {
      const connId = `conn_${Date.now()}_${++this.seq}`
      const conn = new Client()
      // 连接阶段日志：真实转发给渲染层，连接动画里可见
      const stage = (msg) => this.send(`conn:stage:${connId}`, msg)
      stage(`解析地址 ${instance.host}:${instance.port || 22} …`)
      const meta = {
        conn,
        shellStream: null,
        pending: [],
        pendingBytes: 0,
        attached: false,
        closed: false,
        settled: false // connect promise 是否已定局
      }
      this.conns.set(connId, meta)

      const fail = (err) => {
        if (meta.settled) return
        meta.settled = true
        reject(new Error(this.humanError(err)))
      }

      conn.on('handshake', () => stage('TCP 已连通，SSH 握手…'))
      conn.on('banner', () => stage('收到服务器横幅，身份认证中…'))
      conn.on('ready', () => {
        stage('认证通过，正在打开终端会话…')
        conn.shell(
          { term: 'xterm-256color', cols: 120, rows: 30 },
          (err, stream) => {
            if (err) { fail(err); this.close(connId); return }
            meta.shellStream = stream
            stage('终端就绪 ✓')

            stream.on('data', (d) => {
              if (!meta.attached) {
                // 渲染层尚未订阅：先缓冲，防止首屏丢失
                meta.pending.push(d)
                meta.pendingBytes += d.length
                if (meta.pendingBytes > MAX_PENDING) {
                  const drop = meta.pendingBytes - MAX_PENDING
                  let dropped = 0
                  while (meta.pending.length && dropped < drop) {
                    dropped += meta.pending[0].length
                    meta.pending.shift()
                  }
                  meta.pendingBytes -= dropped
                }
              } else {
                this.send(`term:data:${connId}`, d)
              }
            })
            stream.on('close', () => this.handleClose(connId, '会话已结束'))

            meta.settled = true
            resolve({ connId })
          }
        )
      })

      conn.on('error', (err) => {
        fail(err)
        this.handleClose(connId, err.message)
      })
      conn.on('close', () => this.handleClose(connId, '连接已关闭'))
      conn.on('end', () => this.handleClose(connId, '连接已断开'))

      // keyboard-interactive 认证兜底（部分服务器禁用直发密码）
      conn.on('keyboard-interactive', (_name, _instr, _lang, _prompts, finish) => {
        stage('服务器要求交互式认证，提交凭据…')
        finish([instance.password])
      })

      conn.connect({
        host: instance.host,
        port: Number(instance.port) || 22,
        username: instance.username,
        password: instance.password,
        keepaliveInterval: 15000, // 15s 心跳，防 NAT/防火墙空闲回收
        keepaliveCountMax: 10,    // 容忍 150s 无响应再判死
        readyTimeout: 20000,
        tryKeyboard: true
      })
    })
  }

  // 渲染层订阅：返回缓冲数据并切换为直发模式
  attach(connId) {
    const meta = this.conns.get(connId)
    if (!meta) return null
    meta.attached = true
    if (meta.pending.length) {
      const merged = Buffer.concat(meta.pending)
      meta.pending = []
      meta.pendingBytes = 0
      return merged
    }
    return null
  }

  write(connId, data) {
    const meta = this.conns.get(connId)
    if (meta && meta.shellStream) meta.shellStream.write(data)
  }

  resize(connId, rows, cols) {
    const meta = this.conns.get(connId)
    if (meta && meta.shellStream) {
      try { meta.shellStream.setWindow(rows, cols, 0, 0) } catch { /* 流已关闭时忽略 */ }
    }
  }

  close(connId) {
    const meta = this.conns.get(connId)
    if (!meta) return
    meta.intentional = true // 标记主动断开，渲染层不再自动重连
    this.handleClose(connId, '手动断开')
    try { meta.conn.end() } catch { /* 已断开时忽略 */ }
  }

  closeAll() {
    for (const connId of [...this.conns.keys()]) this.close(connId)
  }

  // 连接关闭统一处理：通知渲染层 + 清理（幂等）
  handleClose(connId, reason) {
    const meta = this.conns.get(connId)
    if (!meta || meta.closed) return
    meta.closed = true
    this.send(`term:close:${connId}`, {
      reason,
      intentional: !!meta.intentional // 区分手动断开/意外掉线
    })
    this.conns.delete(connId)
    this.onClosed && this.onClosed(connId)
  }

  // 获取底层 Client（供 SFTP 复用同一 TCP 连接）
  getClient(connId) {
    const meta = this.conns.get(connId)
    if (!meta) throw new Error('连接不存在或已断开，请先连接服务器')
    return meta.conn
  }

  alive(connId) {
    return this.conns.has(connId)
  }

  // 把 ssh2 的错误翻译成人话
  humanError(err) {
    const msg = err.message || String(err)
    if (msg.includes('All configured authentication methods failed')) {
      return '认证失败：用户名或密码错误'
    }
    if (msg.includes('Timed out while waiting for handshake')) {
      return '连接超时：服务器无响应，请检查 IP/端口或网络'
    }
    if (msg.includes('ECONNREFUSED')) {
      return '连接被拒绝：端口未开放或 SSH 服务未运行'
    }
    if (msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN')) {
      return '无法解析主机名：请检查 IP 地址'
    }
    if (msg.includes('EHOSTUNREACH') || msg.includes('ENETUNREACH')) {
      return '网络不可达：无法路由到该服务器'
    }
    return msg
  }
}

module.exports = SshManager
