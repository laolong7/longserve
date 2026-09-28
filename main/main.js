// ============================================================
// 牢笼服务器工具 - Electron 主进程入口
// 职责：窗口创建、IPC 注册、子管理器装配、退出清理
// ============================================================
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')

const store = require('./store')
const SshManager = require('./ssh-manager')
const SftpManager = require('./sftp-manager')
const aiProxy = require('./ai-proxy')

let sshManager = null
let sftpManager = null

// 单实例锁：防止双开导致配置与连接混乱
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', () => {
  // 再次双击 exe：不再聚焦旧窗口，而是新开一个平铺窗口（多开并列）
  if (app.isReady()) createWindow({ cascade: true })
})

const wins = new Set() // 多窗口：每个 BrowserWindow 都能各自开终端

// 窗口效果：none=不透明 / acrylic=Win11 磨砂 / transparent=真透明（看到桌面）
function currentEffect() {
  try {
    const a = store.load().appearance
    return (a && a.windowEffect) || 'none'
  } catch { return 'none' }
}

function createWindow(opts = {}) {
  const { screen } = require('electron')
  const wa = screen.getPrimaryDisplay().workAreaSize
  const width = Math.min(1440, Math.floor(wa.width * 0.92))
  const height = Math.min(900, Math.floor(wa.height * 0.92))
  const effect = currentEffect()

  // 多开平铺：新窗口错开到原窗口右侧，放不下则下移一行
  let x
  let y
  if (opts.cascade && wins.size) {
    const prev = [...wins][wins.size - 1].getBounds()
    x = prev.x + prev.width + 8
    y = prev.y + 28
    if (x + width > wa.x + wa.width) { x = wa.x + 16; y = prev.y + prev.height + 8 }
    if (y + height > wa.y + wa.height) y = wa.y + 16
  }

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 1080,
    minHeight: 640,
    title: 'Laolong Server Utilities',
    backgroundColor: effect === 'none' ? '#131519' : '#00000000',
    autoHideMenuBar: true,
    frame: false, // 自绘标题栏（真透明/磨砂必需）
    ...(effect === 'transparent' ? { transparent: true } : {}),
    ...(effect === 'acrylic' ? { backgroundMaterial: 'acrylic' } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })
  wins.add(win)

  // 阻止拖拽文件到窗口触发默认导航
  win.webContents.on('will-navigate', e => e.preventDefault())

  // 最大化状态变化通知渲染层（标题栏图标切换）
  const emitMax = () => send('win:maximized-changed', win.isMaximized())
  win.on('maximize', emitMax)
  win.on('unmaximize', emitMax)

  // 开发模式：渲染层 console 转发到主进程 stdout，便于自检
  if (!app.isPackaged) {
    win.webContents.on('console-message', (event) => {
      const message = event && event.message
      if (message) console.log('[renderer]', message)
    })
  }

  if (!app.isPackaged) {
    win.loadURL('http://127.0.0.1:5173')
  } else {
    win.loadFile(path.join(__dirname, '..', 'renderer', 'dist', 'index.html'))
  }

  win.on('closed', () => { wins.delete(win) })
  return win
}

// 主进程 → 渲染层事件转发器（多窗口广播：各窗口只关心自己订阅的 connId）
function send(channel, payload) {
  for (const w of wins) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

function registerIpc() {
  // ---------- 配置 ----------
  ipcMain.handle('config:load', () => store.load())
  ipcMain.handle('config:save', (_e, cfg) => { store.save(cfg) })

  // ---------- SSH ----------
  ipcMain.handle('ssh:connect', async (_e, instance) => {
    try {
      return { ok: true, ...(await sshManager.connect(instance)) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
  ipcMain.handle('ssh:attach', (_e, connId) => {
    const pending = sshManager.attach(connId)
    return { pending }
  })
  ipcMain.on('ssh:write', (_e, connId, data) => sshManager.write(connId, data))
  ipcMain.on('ssh:resize', (_e, connId, rows, cols) => sshManager.resize(connId, rows, cols))
  ipcMain.handle('ssh:close', (_e, connId) => sshManager.close(connId))
  ipcMain.handle('ssh:reconnect', async (_e, connId, instance) => {
    // 断线重连：关闭旧连接，建立新连接并返回新 connId
    try {
      sshManager.close(connId)
      return { ok: true, ...(await sshManager.connect(instance)) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // ---------- SFTP ----------
  ipcMain.handle('sftp:home', async (_e, connId) => {
    try { return { ok: true, path: await sftpManager.home(connId) } }
    catch (err) { return { ok: false, error: err.message } }
  })
  ipcMain.handle('sftp:list', async (_e, connId, dirPath) => {
    try { return { ok: true, entries: await sftpManager.list(connId, dirPath) } }
    catch (err) { return { ok: false, error: err.message } }
  })
  ipcMain.handle('sftp:mkdir', async (_e, connId, dirPath) => {
    try { await sftpManager.mkdir(connId, dirPath); return { ok: true } }
    catch (err) { return { ok: false, error: err.message } }
  })
  ipcMain.handle('sftp:delete', async (_e, connId, targetPath, isDir) => {
    try { await sftpManager.remove(connId, targetPath, isDir); return { ok: true } }
    catch (err) { return { ok: false, error: err.message } }
  })
  ipcMain.handle('sftp:rename', async (_e, connId, oldPath, newPath) => {
    try { await sftpManager.rename(connId, oldPath, newPath); return { ok: true } }
    catch (err) { return { ok: false, error: err.message } }
  })
  ipcMain.handle('sftp:transfer', async (_e, opts) => {
    // opts: { connId, taskId, direction: 'upload'|'download', localPath, remotePath }
    try {
      await sftpManager.transfer(opts, (p) => send(`sftp:progress:${opts.taskId}`, p))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
  ipcMain.on('sftp:cancel', (_e, taskId) => sftpManager.cancel(taskId))

  // ---------- 本地文件系统 ----------
  ipcMain.handle('local:list', async (_e, dirPath) => {
    try {
      const items = fs.readdirSync(dirPath, { withFileTypes: true })
      const entries = []
      for (const it of items) {
        const full = path.join(dirPath, it.name)
        let size = null, mtime = null
        try {
          const st = fs.statSync(full)
          size = st.size
          mtime = st.mtimeMs
        } catch { /* 无权限等情况，仍列出条目 */ }
        entries.push({
          name: it.name,
          isDir: it.isDirectory(),
          size,
          mtime,
          path: full
        })
      }
      // 文件夹在前，同类型按名称排序
      entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh-CN'))
      return { ok: true, entries }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
  ipcMain.handle('local:home', () => app.getPath('home'))
  // 盘符列表（"此电脑"视图）：枚举可用磁盘 + 容量
  ipcMain.handle('local:drives', () => {
    const drives = []
    for (let i = 65; i <= 90; i++) {
      const letter = String.fromCharCode(i)
      const root = letter + ':\\'
      try {
        fs.accessSync(root, fs.constants.R_OK)
        let total = null
        let free = null
        try {
          const st = fs.statfsSync(root)
          total = st.blocks * st.bsize
          free = st.bavail * st.bsize
        } catch { /* 容量不可得（如虚拟光驱）仍列出 */ }
        drives.push({
          name: '本地磁盘 (' + letter + ':)',
          isDir: true,
          size: total,
          free,
          mtime: null,
          path: root
        })
      } catch { /* 无此盘符 */ }
    }
    return { ok: true, entries: drives }
  })
  ipcMain.handle('local:mkdir', async (_e, dirPath) => {
    try { fs.mkdirSync(dirPath, { recursive: true }); return { ok: true } }
    catch (err) { return { ok: false, error: err.message } }
  })
  ipcMain.handle('local:delete', async (_e, targetPath, isDir) => {
    try {
      if (isDir) fs.rmSync(targetPath, { recursive: true, force: true })
      else fs.rmSync(targetPath, { force: true })
      return { ok: true }
    } catch (err) { return { ok: false, error: err.message } }
  })
  ipcMain.handle('local:rename', async (_e, oldPath, newPath) => {
    try { fs.renameSync(oldPath, newPath); return { ok: true } }
    catch (err) { return { ok: false, error: err.message } }
  })

  // ---------- AI ----------
  ipcMain.handle('history:list', () => store.loadHistory())
  ipcMain.handle('history:save', (_e, sessions) => store.saveHistory(sessions))

  // AI 本地文件操作工具（读写删一律由渲染层弹确认后才调用）
  ipcMain.handle('local:read', async (_e, filePath) => {
    try {
      const st = fs.statSync(filePath)
      if (st.isDirectory()) return { ok: false, error: '目标是文件夹，不是文件' }
      if (st.size > 200 * 1024) return { ok: false, error: `文件过大（${Math.round(st.size / 1024)}KB），仅支持读取 200KB 内的文本文件` }
      const content = fs.readFileSync(filePath, 'utf8')
      return { ok: true, content }
    } catch (err) { return { ok: false, error: err.message } }
  })
  ipcMain.handle('local:write', async (_e, filePath, content) => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, content, 'utf8')
      return { ok: true }
    } catch (err) { return { ok: false, error: err.message } }
  })
  ipcMain.handle('local:desktop', () => app.getPath('desktop'))

  // ---------- 窗口控制（自绘标题栏） ----------
  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.on('win:new', () => createWindow({ cascade: true }))
  ipcMain.handle('win:is-maximized', (e) => !!BrowserWindow.fromWebContents(e.sender)?.isMaximized())
  // 窗口效果是原生窗口属性，热切换不了：保存后重启应用生效
  ipcMain.on('app:relaunch', () => {
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle('ai:chat', async (_e, opts) => {
    // opts: { eventId, provider: {baseUrl, apiKey, model}, body: OpenAI 请求体 }
    await aiProxy.chatStream(opts, (type, data) => send(`ai:${type}:${opts.eventId}`, data))
    return { ok: true }
  })
  ipcMain.on('ai:abort', (_e, eventId) => aiProxy.abort(eventId))
  ipcMain.handle('ai:listModels', async (_e, provider) => {
    try { return { ok: true, models: await aiProxy.listModels(provider) } }
    catch (err) { return { ok: false, error: err.message } }
  })

  // ---------- 系统 ----------
  // （拖拽文件路径转换在 preload 中用 webUtils 处理，无需主进程参与）
}

app.whenReady().then(() => {
  store.init(app)
  sshManager = new SshManager(send)
  sftpManager = new SftpManager(sshManager)
  sshManager.onClosed = (connId) => sftpManager.dropCache(connId)
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 窗口全部关闭：清理所有 SSH 连接后退出
app.on('window-all-closed', () => {
  if (sshManager) sshManager.closeAll()
  if (process.platform !== 'darwin') app.quit()
})
