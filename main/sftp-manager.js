// ============================================================
// SFTP 文件操作管理器
// 复用 SSH 连接的 sftp 子系统；传输用 fastPut/fastGet 分块并发
// 支持进度回调与取消；文件夹递归上传/下载
// ============================================================
const fs = require('fs')
const path = require('path')

class SftpManager {
  constructor(sshManager) {
    this.ssh = sshManager
    this.sftpCache = new Map()   // connId -> sftp 对象
    this.cancelled = new Set()   // 已取消的 taskId
    this.seq = 0
  }

  newTaskId() {
    return `task_${Date.now()}_${++this.seq}`
  }

  // 获取（并缓存）某个连接的 sftp 子系统
  requestSftp(connId) {
    const cached = this.sftpCache.get(connId)
    if (cached) return Promise.resolve(cached)
    const conn = this.ssh.getClient(connId)
    return new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(new Error('SFTP 子系统打开失败：' + err.message))
        this.sftpCache.set(connId, sftp)
        resolve(sftp)
      })
    })
  }

  dropCache(connId) {
    this.sftpCache.delete(connId)
  }

  // ---------- 目录操作 ----------

  // 探测登录用户的 home 目录（realpath '.'）
  async home(connId) {
    const sftp = await this.requestSftp(connId)
    return new Promise((resolve, reject) => {
      sftp.realpath('.', (err, p) => (err ? reject(new Error(err.message)) : resolve(p)))
    })
  }

  async list(connId, dirPath) {
    const sftp = await this.requestSftp(connId)
    const raw = await sftp.readdir(dirPath)
    const entries = raw.map((it) => {
      const st = it.attrs
      return {
        name: it.filename,
        isDir: (st.mode & 0o170000) === 0o040000, // S_IFDIR
        size: st.size,
        mtime: st.mtime * 1000,
        path: joinRemote(dirPath, it.filename)
      }
    })
    entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh-CN'))
    return entries
  }

  async mkdir(connId, dirPath) {
    const sftp = await this.requestSftp(connId)
    await new Promise((resolve, reject) => {
      sftp.mkdir(dirPath, (err) => (err ? reject(new Error(err.message)) : resolve()))
    })
  }

  // 递归建目录（逐级检查，sftp 没有原生 mkdir -p）
  async mkdirp(connId, dirPath) {
    const sftp = await this.requestSftp(connId)
    const parts = dirPath.split('/').filter(Boolean)
    let cur = dirPath.startsWith('/') ? '' : '.'
    for (const p of parts) {
      cur = cur === '' ? '/' + p : cur === '.' ? p : cur + '/' + p
      await new Promise((resolve) => {
        sftp.mkdir(cur, () => resolve()) // 已存在时 mkdir 会报错，直接吞掉继续
      })
    }
  }

  // 删除文件/文件夹（文件夹递归）
  async remove(connId, targetPath, isDir) {
    const sftp = await this.requestSftp(connId)
    if (!isDir) {
      await new Promise((resolve, reject) => {
        sftp.unlink(targetPath, (err) => (err ? reject(new Error(err.message)) : resolve()))
      })
      return
    }
    const raw = await sftp.readdir(targetPath)
    for (const it of raw) {
      const childIsDir = (it.attrs.mode & 0o170000) === 0o040000
      await this.remove(connId, joinRemote(targetPath, it.filename), childIsDir)
    }
    await new Promise((resolve, reject) => {
      sftp.rmdir(targetPath, (err) => (err ? reject(new Error(err.message)) : resolve()))
    })
  }

  async rename(connId, oldPath, newPath) {
    const sftp = await this.requestSftp(connId)
    await new Promise((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err) => (err ? reject(new Error(err.message)) : resolve()))
    })
  }

  // ---------- 传输 ----------

  // opts: { connId, taskId, direction: 'upload'|'download', localPath, remotePath }
  // onProgress: ({ taskId, phase, percent, transferred, total, currentFile, filesDone, filesTotal })
  async transfer(opts, onProgress) {
    const { connId, taskId, direction, localPath, remotePath } = opts
    const sftp = await this.requestSftp(connId)

    // 收集要传的文件清单：文件直接一条，文件夹递归展开
    const isDirSrc = direction === 'upload'
      ? fs.statSync(localPath).isDirectory()
      : await this.remoteIsDir(sftp, remotePath)

    const jobs = [] // { local, remote, size }
    if (!isDirSrc) {
      const size = direction === 'upload'
        ? fs.statSync(localPath).size
        : await this.remoteSize(sftp, remotePath)
      jobs.push({ local: localPath, remote: remotePath, size })
    } else {
      await this.collectJobs(direction, sftp, localPath, remotePath, jobs)
    }
    const totalBytes = jobs.reduce((s, j) => s + (j.size || 0), 0)
    let doneBytes = 0

    let lastEmit = 0
    const emit = (phase, extra = {}) => {
      const now = Date.now()
      if (phase !== 'done' && now - lastEmit < 100) return // 进度节流 100ms
      lastEmit = now
      onProgress({
        taskId,
        phase,
        percent: totalBytes ? Math.floor((doneBytes / totalBytes) * 100) : 0,
        transferred: doneBytes,
        total: totalBytes,
        filesDone: jobs.filter((j) => j.finished).length,
        filesTotal: jobs.length,
        ...extra
      })
    }

    emit('start')

    for (const job of jobs) {
      if (this.cancelled.has(taskId)) {
        this.cancelled.delete(taskId)
        emit('cancelled')
        throw new Error('传输已取消')
      }
      emit('transferring', { currentFile: path.posix.basename(job.remote) })

      // 确保目标父目录存在（文件夹传输场景）
      const targetParent = direction === 'upload'
        ? path.posix.dirname(job.remote)
        : path.dirname(job.local)
      if (direction === 'upload') await this.mkdirp(connId, targetParent)
      else fs.mkdirSync(targetParent, { recursive: true })

      let lastStepEmit = 0
      const step = (transferred, _chunk, fileTotal) => {
        if (this.cancelled.has(taskId)) {
          throw Object.assign(new Error('传输已取消'), { cancelled: true })
        }
        // step 里的进度：以文件增量记账（transferred 是当前文件已传字节）
        if (fileTotal != null) {
          doneBytes = doneBytes // 全局记账在下面 done 时统一处理
        }
        const now = Date.now()
        if (now - lastStepEmit > 100) {
          lastStepEmit = now
          onProgress({
            taskId,
            phase: 'transferring',
            percent: totalBytes ? Math.min(99, Math.floor((doneBytes / totalBytes) * 100)) : 0,
            transferred: doneBytes,
            total: totalBytes,
            filesDone: jobs.filter((j) => j.finished).length,
            filesTotal: jobs.length,
            currentFile: path.posix.basename(job.remote)
          })
        }
      }

      const run = direction === 'upload'
        ? new Promise((resolve, reject) => {
            sftp.fastPut(job.local, job.remote, { step }, (err) => (err ? reject(err) : resolve()))
          })
        : new Promise((resolve, reject) => {
            sftp.fastGet(job.remote, job.local, { step }, (err) => (err ? reject(err) : resolve()))
          })

      try {
        await run
      } catch (err) {
        if (err.cancelled || this.cancelled.has(taskId)) {
          this.cancelled.delete(taskId)
          emit('cancelled')
          throw new Error('传输已取消')
        }
        throw new Error('传输失败：' + err.message)
      }
      job.finished = true
      doneBytes += job.size || 0
      emit('transferring')
    }

    emit('done')
  }

  cancel(taskId) {
    this.cancelled.add(taskId)
  }

  // ---------- 内部工具 ----------

  async remoteIsDir(sftp, p) {
    return new Promise((resolve) => {
      sftp.stat(p, (err, st) => resolve(!err && st.isDirectory()))
    })
  }

  async remoteSize(sftp, p) {
    return new Promise((resolve) => {
      sftp.stat(p, (err, st) => resolve(err ? 0 : st.size))
    })
  }

  // 递归展开文件夹为传输任务清单
  async collectJobs(direction, sftp, localRoot, remoteRoot, jobs) {
    if (direction === 'upload') {
      fs.mkdirSync(localRoot, { recursive: true }) // 确保可读
      const items = fs.readdirSync(localRoot, { withFileTypes: true })
      for (const it of items) {
        const lp = path.join(localRoot, it.name)
        const rp = joinRemote(remoteRoot, it.name)
        if (it.isDirectory()) {
          await this.collectJobs(direction, sftp, lp, rp, jobs)
        } else {
          jobs.push({ local: lp, remote: rp, size: fs.statSync(lp).size })
        }
      }
    } else {
      const raw = await sftp.readdir(remoteRoot)
      for (const it of raw) {
        const rp = joinRemote(remoteRoot, it.filename)
        const lp = path.join(localRoot, it.filename)
        const isDir = (it.attrs.mode & 0o170000) === 0o040000
        if (isDir) {
          await this.collectJobs(direction, sftp, lp, rp, jobs)
        } else {
          jobs.push({ local: lp, remote: rp, size: it.attrs.size })
        }
      }
    }
  }
}

// 远程路径拼接（统一 POSIX 风格）
function joinRemote(dir, name) {
  return (dir === '/' ? '' : dir.replace(/\/+$/, '')) + '/' + name
}

module.exports = SftpManager
