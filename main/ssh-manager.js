// ============================================================
// SSH 连接管理器
// 每个连接：Client + shell 流，数据经 IPC 转发给渲染层的 xterm
// attach 缓冲机制：shell 数据先入缓冲，渲染层订阅后一次性 flush，
// 保证欢迎信息（MOTD）等首屏数据不丢失、不重复
// 扩展：exec 命令通道（监控/systemd/快照）、流式命令（日志 tail -F）、
//       连接质量探测（轻量 exec 测 RTT）、端口转发（-L 本地 / -R 远程）
// ============================================================
const { Client } = require('ssh2')
const net = require('net')

const MAX_PENDING = 512 * 1024 // 未订阅时的数据缓冲上限 512KB
const QUALITY_INTERVAL = 10000 // 质量采样间隔
const QUALITY_HISTORY = 12     // 丢包率统计窗口

class SshManager {
  constructor(send) {
    this.send = send
    this.conns = new Map()      // connId -> { conn, shellStream, pending, attached, closed }
    this.streams = new Map()    // streamId -> { stream, connId }（流式 exec，如日志 tail -F）
    this.tunnels = new Map()    // tunnelId -> { type, connId, server? , ... }
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
            this.startQualityMonitor(connId)
            resolve({ connId })
          }
        )
      })

      // 远程转发（-R）：服务器侧有新连接进来，按监听端口路由到对应隧道
      conn.on('tcp connection', (info, accept, reject) => {
        const tun = [...this.tunnels.values()].find(
          (t) => t.connId === connId && t.type === 'remote' && Number(t.bindPort) === Number(info.destPort)
        )
        if (!tun) return reject()
        const stream = accept()
        const sock = net.connect(Number(tun.targetPort), tun.targetHost || '127.0.0.1', () => {
          stream.pipe(sock)
          sock.pipe(stream)
        })
        const bail = () => { try { sock.destroy() } catch { /* 忽略 */ } try { stream.close() } catch { /* 忽略 */ } }
        sock.on('error', bail)
        stream.on('error', bail)
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
    // 清理该连接挂载的流式命令、隧道、质量监控
    for (const [sid, s] of [...this.streams.entries()]) {
      if (s.connId === connId) {
        try { s.stream.close() } catch { /* 忽略 */ }
        this.streams.delete(sid)
        this.send(`log:close:${sid}`, { reason })
      }
    }
    for (const [tid, t] of [...this.tunnels.entries()]) {
      if (t.connId === connId) this.stopTunnel(tid, '连接已断开')
    }
    if (meta.qualityTimer) clearInterval(meta.qualityTimer)
    this.send(`conn:quality:${connId}`, { ok: false, offline: true })
    this.conns.delete(connId)
    this.onClosed && this.onClosed(connId)
  }

  // ---------- exec 命令通道（监控采样 / systemd / 快照等） ----------
  // 收集式：返回 { code, stdout }；timeout 到点即断并拒绝
  exec(connId, cmd, timeout = 10000) {
    const meta = this.conns.get(connId)
    if (!meta) return Promise.reject(new Error('连接不存在或已断开'))
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (fn, arg) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(arg)
      }
      const timer = setTimeout(() => {
        done(reject, new Error('命令超时（' + Math.round(timeout / 1000) + 's）'))
        try { stream && stream.close() } catch { /* 忽略 */ }
      }, timeout)
      let stream = null
      meta.conn.exec(cmd, (err, s) => {
        if (err) return done(reject, new Error(this.humanError(err)))
        stream = s
        let out = ''
        s.on('data', (d) => { out += d.toString('utf8') })
        s.stderr.on('data', () => { /* 吞掉 stderr 防积压 */ })
        s.on('close', (code) => done(resolve, { code, stdout: out }))
      })
    })
  }

  // 流式命令（日志 tail -F 等）：返回 streamId，数据经 log:data:{streamId} 转发
  execStream(connId, cmd) {
    const meta = this.conns.get(connId)
    if (!meta) return Promise.reject(new Error('连接不存在或已断开'))
    return new Promise((resolve, reject) => {
      meta.conn.exec(cmd, (err, stream) => {
        if (err) return reject(new Error(this.humanError(err)))
        const streamId = `log_${Date.now()}_${++this.seq}`
        this.streams.set(streamId, { stream, connId })
        stream.on('data', (d) => this.send(`log:data:${streamId}`, d.toString('utf8')))
        stream.on('close', () => {
          if (this.streams.delete(streamId)) this.send(`log:close:${streamId}`, { reason: '命令结束' })
        })
        resolve({ streamId })
      })
    })
  }

  stopStream(streamId) {
    const s = this.streams.get(streamId)
    if (!s) return
    try { s.stream.close() } catch { /* 忽略 */ }
    this.streams.delete(streamId)
    this.send(`log:close:${streamId}`, { reason: '已停止' })
  }

  // ---------- 连接质量探测 ----------
  // 每 10s 跑一次 no-op 命令（true，builtin 不起子进程）测往返；
  // RTT 趋势与 ping 一致（略含执行开销），丢包率 = 窗口内失败占比
  startQualityMonitor(connId) {
    const meta = this.conns.get(connId)
    if (!meta || meta.qualityTimer) return
    meta.qualityHistory = []
    const sample = async () => {
      if (meta.closed) return
      const t0 = Date.now()
      let ok = true
      try { await this.exec(connId, 'true', 3000) } catch { ok = false }
      if (meta.closed) return
      const rtt = ok ? Date.now() - t0 : null
      meta.qualityHistory.push(ok ? rtt : -1)
      if (meta.qualityHistory.length > QUALITY_HISTORY) meta.qualityHistory.shift()
      const loss = Math.round((meta.qualityHistory.filter((v) => v < 0).length / meta.qualityHistory.length) * 100)
      this.send(`conn:quality:${connId}`, { ok, rtt, loss, at: Date.now() })
    }
    sample()
    meta.qualityTimer = setInterval(sample, QUALITY_INTERVAL)
  }

  // ---------- 端口转发 ----------
  // spec: { type: 'local'|'remote', listenHost, listenPort, bindHost, bindPort, targetHost, targetPort }
  addTunnel(connId, spec) {
    const meta = this.conns.get(connId)
    if (!meta) return Promise.reject(new Error('连接不存在或已断开'))
    const tunnelId = `tun_${Date.now()}_${++this.seq}`
    if (spec.type === 'local') {
      // -L：本机监听，连接进来经 SSH forwardOut 转到目标
      const server = net.createServer((sock) => {
        meta.conn.forwardOut(
          sock.remoteAddress || '127.0.0.1', sock.remotePort || 0,
          spec.targetHost || '127.0.0.1', Number(spec.targetPort),
          (err, stream) => {
            if (err) { try { sock.destroy() } catch { /* 忽略 */ } return }
            stream.pipe(sock)
            sock.pipe(stream)
            const bail = () => { try { sock.destroy() } catch { /* 忽略 */ } try { stream.close() } catch { /* 忽略 */ } }
            sock.on('error', bail)
            stream.on('error', bail)
          }
        )
      })
      return new Promise((resolve, reject) => {
        server.once('error', (err) => reject(new Error('本机监听失败：' + err.message)))
        server.listen(Number(spec.listenPort), spec.listenHost || '127.0.0.1', () => {
          this.tunnels.set(tunnelId, { ...spec, connId, server })
          resolve({ tunnelId })
        })
      })
    }
    // -R：服务器监听，数据由 'tcp connection' 事件（connect 时挂的处理器）回连本机目标
    return new Promise((resolve, reject) => {
      meta.conn.forwardIn(spec.bindHost || '', Number(spec.bindPort), (err) => {
        if (err) return reject(new Error('远程监听失败：' + this.humanError(err)))
        this.tunnels.set(tunnelId, { ...spec, connId })
        resolve({ tunnelId })
      })
    })
  }

  stopTunnel(tunnelId, reason = '已停止') {
    const t = this.tunnels.get(tunnelId)
    if (!t) return
    this.tunnels.delete(tunnelId)
    const meta = this.conns.get(t.connId)
    if (t.type === 'local') {
      try { t.server && t.server.close() } catch { /* 忽略 */ }
    } else if (meta) {
      try { meta.conn.unforwardIn(t.bindHost || '', Number(t.bindPort), () => {}) } catch { /* 忽略 */ }
    }
    this.send('tunnel:stopped', { tunnelId, reason })
  }

  listTunnels(connId) {
    return [...this.tunnels.entries()]
      .filter(([, t]) => !connId || t.connId === connId)
      .map(([tunnelId, t]) => ({
        tunnelId,
        ...t,
        // 本地转发：本机监听套接字的真实状态（创建失败/已断开时 listening=false）
        listening: t.type === 'local' ? !!(t.server && t.server.listening) : null
      }))
  }

  // 远程转发服务器侧监听检测：ss 查端口是否真的在监听（远程转发是否生效的最直接证据）
  async checkRemoteListen(connId, port) {
    try {
      const r = await this.exec(connId, `ss -tln 2>/dev/null | grep -q ':${Number(port)} ' && echo YES || echo NO`, 8000)
      return r.ok ? r.stdout.includes('YES') : null
    } catch {
      return null // 连接断开等无法检测
    }
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
