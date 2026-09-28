// ============================================================
// 预加载桥：安全暴露主进程能力给渲染层
// contextIsolation 开启，渲染层通过 window.api 访问
// ============================================================
const { contextBridge, ipcRenderer, webUtils } = require('electron')

// 允许订阅的事件通道白名单（前缀匹配）
const EVENT_PREFIXES = ['term:data:', 'term:close:', 'conn:stage:', 'sftp:progress:', 'ai:delta:', 'ai:done:', 'ai:error:', 'log:data:', 'log:close:', 'conn:quality:', 'tunnel:stopped']

function isAllowedChannel(ch) {
  return EVENT_PREFIXES.some((p) => ch.startsWith(p))
}

contextBridge.exposeInMainWorld('api', {
  // ---------- 配置 ----------
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),

  // ---------- SSH ----------
  sshConnect: (instance) => ipcRenderer.invoke('ssh:connect', instance),
  // 订阅该连接的数据流，返回缓冲的首屏数据（Buffer/ArrayBuffer 或 null）
  sshAttach: async (connId) => {
    const { pending } = await ipcRenderer.invoke('ssh:attach', connId)
    return pending
  },
  sshWrite: (connId, data) => ipcRenderer.send('ssh:write', connId, data),
  sshResize: (connId, rows, cols) => ipcRenderer.send('ssh:resize', connId, rows, cols),
  sshClose: (connId) => ipcRenderer.invoke('ssh:close', connId),
  sshReconnect: (connId, instance) => ipcRenderer.invoke('ssh:reconnect', connId, instance),
  sshExec: (connId, cmd, timeout) => ipcRenderer.invoke('ssh:exec', connId, cmd, timeout),

  // ---------- 日志流 / 端口转发 / 录制 ----------
  logStart: (connId, file) => ipcRenderer.invoke('log:start', connId, file),
  logStop: (streamId) => ipcRenderer.send('log:stop', streamId),
  tunnelAdd: (connId, spec) => ipcRenderer.invoke('tunnel:add', connId, spec),
  tunnelStop: (tunnelId) => ipcRenderer.send('tunnel:stop', tunnelId),
  tunnelList: (connId) => ipcRenderer.invoke('tunnel:list', connId),
  recordingsDefaultDir: () => ipcRenderer.invoke('recordings:default-dir'),

  // ---------- SFTP ----------
  sftpHome: (connId) => ipcRenderer.invoke('sftp:home', connId),
  sftpList: (connId, dirPath) => ipcRenderer.invoke('sftp:list', connId, dirPath),
  sftpMkdir: (connId, dirPath) => ipcRenderer.invoke('sftp:mkdir', connId, dirPath),
  sftpDelete: (connId, targetPath, isDir) => ipcRenderer.invoke('sftp:delete', connId, targetPath, isDir),
  sftpRename: (connId, oldPath, newPath) => ipcRenderer.invoke('sftp:rename', connId, oldPath, newPath),
  sftpTransfer: (opts) => ipcRenderer.invoke('sftp:transfer', opts),
  sftpCancel: (taskId) => ipcRenderer.send('sftp:cancel', taskId),
  sftpNewTaskId: () => `task_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,

  // ---------- 本地文件 ----------
  localList: (dirPath) => ipcRenderer.invoke('local:list', dirPath),
  localDrives: () => ipcRenderer.invoke('local:drives'),
  localHome: () => ipcRenderer.invoke('local:home'),
  localDesktop: () => ipcRenderer.invoke('local:desktop'),
  localRead: (filePath) => ipcRenderer.invoke('local:read', filePath),
  localWrite: (filePath, content) => ipcRenderer.invoke('local:write', filePath, content),
  localMkdir: (dirPath) => ipcRenderer.invoke('local:mkdir', dirPath),
  localDelete: (targetPath, isDir) => ipcRenderer.invoke('local:delete', targetPath, isDir),
  localRename: (oldPath, newPath) => ipcRenderer.invoke('local:rename', oldPath, newPath),

  // ---------- AI ----------
  historyList: () => ipcRenderer.invoke('history:list'),
  historySave: (sessions) => ipcRenderer.invoke('history:save', sessions),
  aiChat: (opts) => ipcRenderer.invoke('ai:chat', opts),
  aiAbort: (eventId) => ipcRenderer.send('ai:abort', eventId),
  aiListModels: (provider) => ipcRenderer.invoke('ai:listModels', provider),

  // ---------- 系统 ----------
  filePathForDrop: (file) => {
    try { return webUtils.getPathForFile(file) } catch { return null }
  },

  // ---------- 窗口控制（自绘标题栏用） ----------
  winMinimize: () => ipcRenderer.send('win:minimize'),
  winMaximize: () => ipcRenderer.send('win:maximize'),
  winClose: () => ipcRenderer.send('win:close'),
  winNew: () => ipcRenderer.send('win:new'),
  winIsMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  appRelaunch: () => ipcRenderer.send('app:relaunch'),

  // ---------- 数据目录 ----------
  dataDir: () => ipcRenderer.invoke('data:dir'),
  dataOpen: () => ipcRenderer.invoke('data:open'),
  dataChange: () => ipcRenderer.invoke('data:change'),
  dataReset: () => ipcRenderer.invoke('data:reset'),

  // ---------- 关于系统 ----------
  appInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  onWinMaximizeChanged: (cb) => {
    const listener = (_e, v) => cb(v)
    ipcRenderer.on('win:maximized-changed', listener)
    return () => ipcRenderer.removeListener('win:maximized-changed', listener)
  },

  // ---------- 事件订阅 ----------
  on(channel, cb) {
    if (!isAllowedChannel(channel)) throw new Error('非法事件通道: ' + channel)
    const listener = (_e, payload) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  off(channel, cb) {
    // off 只用于移除上面 on 返回的解绑函数，这里提供独立解绑以支持组件卸载
    ipcRenderer.removeAllListeners(channel)
  }
})
