// ============================================================
// 本地 Shell 管理器：把本机命令提示符（cmd.exe / bash）接进 xterm
// 无 pty 依赖（纯 child_process 管道）：cmd/bash 基础交互完全够用，
// vim/top 这类全屏 TUI 不支持（那是 SSH 终端的活）
// 数据通路与 ssh-manager 同构：local:data:{shellId} / local:close:{shellId}
// 未订阅时输出先进缓冲（上限 512KB），防止首屏丢失
// ============================================================
const { spawn } = require('child_process')
const os = require('os')
const path = require('path')

const MAX_PENDING = 512 * 1024

class LocalShellManager {
  constructor(send) {
    this.send = send
    this.shells = new Map() // shellId -> { proc, pending, pendingBytes, attached, closed }
    this.seq = 0
  }

  // 打开本地 shell，resolve({ shellId })
  open() {
    return new Promise((resolve, reject) => {
      const shellId = `local_${Date.now()}_${++this.seq}`
      const isWin = process.platform === 'win32'
      // Windows：经典命令提示符。/d 跳过 AutoRun；/q 启动即关命令回显
      // （交互中 @echo off 关不掉管道回显、/q 才有效——实测钉死；回显由渲染层行编辑接管）
      const proc = isWin
        ? spawn('cmd.exe', ['/d', '/q'], { cwd: os.homedir(), windowsHide: true, env: process.env })
        : spawn(process.env.SHELL || '/bin/bash', ['-i'], { cwd: os.homedir(), env: process.env })

      const meta = { proc, pending: [], pendingBytes: 0, attached: false, closed: false }
      this.shells.set(shellId, meta)

      const emit = (d) => {
        const buf = Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8')
        if (!meta.attached) {
          meta.pending.push(buf)
          meta.pendingBytes += buf.length
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
          this.send(`local:data:${shellId}`, buf)
        }
      }

      proc.stdout.on('data', emit)
      proc.stderr.on('data', emit)
      proc.on('error', (err) => {
        meta.closed = true
        this.shells.delete(shellId)
        reject(new Error('本地 shell 启动失败：' + err.message))
      })
      proc.on('close', (code) => {
        meta.closed = true
        this.shells.delete(shellId)
        this.send(`local:close:${shellId}`, { code })
      })

      // Windows 启动序列：UTF-8 代码页（防中文乱码）+ 清屏去 banner
      if (isWin) {
        setTimeout(() => {
          try { proc.stdin.write('chcp 65001\r\ncls\r\n') } catch { /* 已退出 */ }
        }, 150)
      }
      // 给启动一点时间，失败会在 error/close 暴露
      setTimeout(() => {
        if (!meta.closed) resolve({ shellId })
      }, 250)
    })
  }

  // 首次订阅：把缓冲一次性冲给渲染层（与 sshManager.attach 同款契约：合并 Buffer 或 null）
  attach(shellId) {
    const meta = this.shells.get(shellId)
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

  // 写入用户输入。xterm 回车发 \r：Windows 换行 \r\n，Unix \n
  write(shellId, data) {
    const meta = this.shells.get(shellId)
    if (!meta || meta.closed) throw new Error('本地终端已关闭')
    let s = String(data).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (process.platform === 'win32') s = s.replace(/\n/g, '\r\n')
    meta.proc.stdin.write(s)
  }

  kill(shellId) {
    const meta = this.shells.get(shellId)
    if (!meta) return
    meta.closed = true
    this.shells.delete(shellId)
    try { meta.proc.kill() } catch { /* 已退出 */ }
  }

  alive(shellId) {
    return this.shells.has(shellId)
  }
}

module.exports = { LocalShellManager }
