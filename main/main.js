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

let win = null
let sshManager = null
let sftpManager = null

// 单实例锁：防止双开导致配置与连接混乱
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

function createWindow() {
  // 初始尺寸自适应屏幕（90%），避免小屏溢出
  const { screen } = require('electron')
  const wa = screen.getPrimaryDisplay().workAreaSize
  win = new BrowserWindow({
    width: Math.min(1440, Math.floor(wa.width * 0.92)),
    height: Math.min(900, Math.floor(wa.height * 0.92)),
    minWidth: 1080,
    minHeight: 640,
    title: '牢笼服务器工具',
    backgroundColor: '#131519',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  // 阻止拖拽文件到窗口触发默认导航
  win.webContents.on('will-navigate', e => e.preventDefault())

  // 开发模式：渲染层 console 转发到主进程 stdout，便于自检
  if (!app.isPackaged) {
    win.webContents.on('console-message', (event) => {
      const message = event && event.message
      if (message) console.log('[renderer]', message)
    })
    // 布局诊断：页面截图（自检用，仅开发模式）
    win.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const fs = require('fs')
          const img = await win.webContents.capturePage()
          fs.writeFileSync(path.join(app.getPath('temp'), 'laogtool_page.png'), img.toPNG())
          console.log('[diag] page captured')
        } catch (err) {
          console.log('[diag-capture-err]', err.message)
        }
      }, 2500)
    })
  }

  if (!app.isPackaged) {
    win.loadURL('http://127.0.0.1:5173')
    // win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '..', 'renderer', 'dist', 'index.html'))
  }

  win.on('closed', () => { win = null })
}

// 主进程 → 渲染层事件转发器
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
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
