// ============================================================
// 本地 Mock SSH 服务器（自检专用，永远只监听 127.0.0.1）
// shell：支持 pwd/ls/cd/cat/echo/uname 等简单命令 + 回显
// sftp：基于临时沙箱目录的完整实现（列目录/读写/建删改名）
// 用法：node test/mock-ssh.js [端口]   账号密码任意
// ============================================================
const ssh2 = require('ssh2')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const PORT = Number(process.argv[2]) || 2222
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mockssh-'))

// 沙箱初始内容
function initSandbox() {
  fs.writeFileSync(path.join(SANDBOX, 'readme.txt'), '这是 mock 服务器的说明文件\n第二行内容\n')
  fs.writeFileSync(path.join(SANDBOX, 'app.log'), '2026-09-28 10:00:00 INFO app started\n2026-09-28 10:01:00 WARN slow query\n')
  fs.mkdirSync(path.join(SANDBOX, 'var'))
  fs.mkdirSync(path.join(SANDBOX, 'var', 'www'))
  fs.writeFileSync(path.join(SANDBOX, 'var', 'www', 'index.html'), '<h1>mock</h1>\n')
  fs.mkdirSync(path.join(SANDBOX, 'etc'))
  fs.writeFileSync(path.join(SANDBOX, 'etc', 'app.conf'), 'port=8080\n')
}
initSandbox()

// 路径解析：远端路径一律相对 home（~），映射到沙箱目录，防止越界
// cwdRel 是相对沙箱根的目录（如 'var/www'，根为 ''）
function resolve(p, cwdRel = '') {
  if (!p || p === '~') p = cwdRel || ''
  else if (p.startsWith('~/')) p = p.slice(2)
  else if (p.startsWith('/')) p = p.slice(1)
  else p = (cwdRel ? cwdRel + '/' : '') + p
  const norm = path.normalize(path.join(SANDBOX, ...p.split('/').filter(Boolean)))
  if (!norm.startsWith(SANDBOX)) return SANDBOX
  return norm
}
const toRemote = (rel) => '/' + (rel || '')
const toRel = (abs) => path.relative(SANDBOX, abs).split(path.sep).join('/')

const server = new ssh2.Server(
  { hostKeys: [genKey()] },
  (client) => {
    client.on('error', (err) => console.log('[mock] client error:', err.message))
    client.on('end', () => {})
    let cwdRel = '' // 相对沙箱根
    client.on('authentication', (ctx) => ctx.accept())
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        // ssh2 服务端事件名是 'pty'（不是 'pty-req'），必须 accept 否则 shell 无法开终端
        session.on('pty', (acceptPty) => acceptPty())
        session.on('shell', (acceptShell) => {
          const channel = acceptShell()
          const prompt = () => channel.write(`\r\nroot@mock:${toRemote(cwdRel)}# `)
          let buf = ''
          channel.write('Welcome to Mock SSH Server (牢笼自检用)\r\n')
          prompt()
          channel.on('data', (d) => {
            buf += d.toString('utf8')
            while (buf.includes('\r')) {
              const idx = buf.indexOf('\r')
              let line = buf.slice(0, idx)
              buf = buf.slice(idx + 1)
              line = line.replace(/\x7f.*/g, '') // 粗略退格处理
              runCmd(line, channel, cwdRel, (nw) => { cwdRel = nw })
              prompt()
            }
          })
        })
        session.on('sftp', (acceptSftp) => handleSftp(acceptSftp))
      })
    })
  }
)

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-ssh] listening 127.0.0.1:${PORT}  sandbox=${SANDBOX}`)
})

// 全局错误兜底：客户端异常断开不让进程崩掉
server.on('error', (err) => console.log('[mock] server error:', err.message))
process.on('uncaughtException', (err) => console.log('[mock] uncaught:', err.message))
process.on('unhandledRejection', (err) => console.log('[mock] unhandled:', err && err.message))

function runCmd(line, channel, cwdRel, setCwd) {
  const out = (s) => channel.write(s + '\r\n')
  const parts = line.trim().split(/\s+/)
  const cmd = parts[0]
  if (!cmd) return
  try {
    switch (cmd) {
      case 'pwd': out(toRemote(cwdRel)); break
      case 'ls': {
        const items = fs.readdirSync(resolve(parts[1], cwdRel))
        out(items.join('  '))
        break
      }
      case 'cd': {
        const t = resolve(parts[1] || '', cwdRel)
        if (fs.statSync(t).isDirectory()) setCwd(toRel(t))
        else out(`cd: ${parts[1]}: Not a directory`)
        break
      }
      case 'cat': out(fs.readFileSync(resolve(parts[1], cwdRel), 'utf8').replace(/\n/g, '\r\n')); break
      case 'echo': out(parts.slice(1).join(' ')); break
      case 'uname': out('Linux mock 5.15.0 x86_64 GNU/Linux'); break
      case 'df': out('Filesystem  1K-blocks  Used Available Use% Mounted on\n/dev/sda1   41265436  8362400  30785432  22% /'); break
      case 'free': out('       total   used   free\nMem:    2048000 819200 1228800'); break
      case 'whoami': out('root'); break
      case 'clear': channel.write('\x1b[2J\x1b[H'); break
      default: out(`bash: ${cmd}: command not found (mock)`)
    }
  } catch (err) {
    out(`${cmd}: ${err.message}`)
  }
}

// ---------- SFTP 服务端实现（基于沙箱目录） ----------
function handleSftp(accept) {
  const sftpStream = accept()
  const handles = new Map() // handleId -> { type: 'read'|'write'|'dir', ... }
  sftpStream.on('REALPATH', (reqid, p) => {
    const abs = resolve(p)
    sftpStream.name(reqid, [{ filename: toRemote(toRel(abs)) }])
  })
  sftpStream.on('STAT', (reqid, p) => statReply(reqid, p))
  sftpStream.on('LSTAT', (reqid, p) => statReply(reqid, p))
  sftpStream.on('OPENDIR', (reqid, p) => {
    try {
      const abs = resolve(p)
      const items = fs.readdirSync(abs, { withFileTypes: true }).map((d) => ({
        filename: d.name,
        longname: d.isDirectory() ? `drwxr-xr-x  ${d.name}` : `-rw-r--r--  ${d.name}`,
        attrs: attrsOf(abs, d.name)
      }))
      const h = crypto.randomBytes(4).toString('hex')
      handles.set(h, { type: 'dir', items, offset: 0 })
      sftpStream.handle(reqid, Buffer.from(h))
    } catch (err) {
      sftpStream.status(reqid, ssh2.utils ? ssh2.utils.sftp.STATUS_CODE.NO_SUCH_FILE : 2, err.message)
    }
  })
  sftpStream.on('READDIR', (reqid, handle) => {
    const h = handles.get(handle.toString())
    if (!h || h.type !== 'dir') return sftpStream.status(reqid, 2, 'bad handle')
    if (h.offset >= h.items.length) {
      sftpStream.status(reqid, 1) // EOF
      handles.delete(handle.toString())
      return
    }
    const batch = h.items.slice(h.offset, h.offset + 50)
    h.offset += batch.length
    sftpStream.name(reqid, batch)
  })
  sftpStream.on('OPEN', (reqid, p, flags, attrs) => {
    try {
      const abs = resolve(p)
      const flagStr = String(flags)
      const isWrite = flagStr.includes('w') || flagStr.includes('a') || flagStr.includes('t') || Number(flags) & 0b11
      let fd
      if (flagStr.includes('a')) fd = fs.openSync(abs, 'a')
      else if (isWrite) fd = fs.openSync(abs, 'w')
      else fd = fs.openSync(abs, 'r')
      const h = crypto.randomBytes(4).toString('hex')
      handles.set(h, { type: isWrite ? 'write' : 'read', fd, abs })
      sftpStream.handle(reqid, Buffer.from(h))
    } catch (err) {
      sftpStream.status(reqid, 2, err.message)
    }
  })
  sftpStream.on('WRITE', (reqid, handle, offset, data) => {
    const h = handles.get(handle.toString())
    if (!h || h.type !== 'write') return sftpStream.status(reqid, 2, 'bad handle')
    fs.writeSync(h.fd, data, 0, data.length, offset)
    sftpStream.status(reqid, 0)
  })
  sftpStream.on('READ', (reqid, handle, offset, len) => {
    const h = handles.get(handle.toString())
    if (!h || h.type !== 'read') return sftpStream.status(reqid, 2, 'bad handle')
    const buf = Buffer.alloc(len)
    const n = fs.readSync(h.fd, buf, 0, len, offset)
    if (n === 0) sftpStream.status(reqid, 1)
    else sftpStream.data(reqid, buf.slice(0, n))
  })
  sftpStream.on('CLOSE', (reqid, handle) => {
    const h = handles.get(handle.toString())
    if (h && h.fd != null) { try { fs.closeSync(h.fd) } catch { /* ignore */ } }
    handles.delete(handle.toString())
    sftpStream.status(reqid, 0)
  })
  sftpStream.on('MKDIR', (reqid, p) => {
    try { fs.mkdirSync(resolve(p), { recursive: true }); sftpStream.status(reqid, 0) }
    catch (err) { sftpStream.status(reqid, 2, err.message) }
  })
  sftpStream.on('RMDIR', (reqid, p) => {
    try { fs.rmdirSync(resolve(p)); sftpStream.status(reqid, 0) }
    catch (err) { sftpStream.status(reqid, 2, err.message) }
  })
  sftpStream.on('REMOVE', (reqid, p) => {
    try { fs.unlinkSync(resolve(p)); sftpStream.status(reqid, 0) }
    catch (err) { sftpStream.status(reqid, 2, err.message) }
  })
  sftpStream.on('RENAME', (reqid, oldP, newP) => {
    try { fs.renameSync(resolve(oldP), resolve(newP)); sftpStream.status(reqid, 0) }
    catch (err) { sftpStream.status(reqid, 2, err.message) }
  })
  sftpStream.on('SETSTAT', (reqid) => sftpStream.status(reqid, 0))

  function statReply(reqid, p) {
    try {
      const st = fs.statSync(resolve(p))
      sftpStream.attrs(reqid, attrsFromStat(st))
    } catch {
      sftpStream.status(reqid, 2, 'no such file')
    }
  }
  function attrsOf(dir, name) {
    try { return attrsFromStat(fs.statSync(path.join(dir, name))) } catch { return {} }
  }
  function attrsFromStat(st) {
    return {
      mode: st.mode,
      uid: 0, gid: 0,
      size: st.size,
      atime: Math.floor(st.atimeMs / 1000),
      mtime: Math.floor(st.mtimeMs / 1000)
    }
  }
}

function genKey() {
  // 用 ssh2 自带的密钥生成（OPENSSH 格式，保证它自己能解析）
  const { private: privateKey } = ssh2.utils.generateKeyPairSync('ed25519')
  return privateKey
}
