// 终端标签 store：多开连接、激活切换、断线重连
// TerminalPane 组件把自己注册进 paneRefs，供 AI 读写当前终端
// 扩展：连接质量缓存（conn:quality 事件）、会话录制（asciinema v2）
import { defineStore } from 'pinia'
import { useConfigStore } from './config'

let uidSeq = 0 // tab 稳定 uid：pending -> conn_ 的 id 变化不影响 v-for key
const qualityUnsubs = new Map() // connId -> 解绑函数（非响应式）

export const useTerminalStore = defineStore('terminals', {
  state: () => ({
    tabs: [], // { id(connId), instanceId, name, status: connecting|connected|closed, instance快照 }
    activeTabId: null,
    paneRefs: new Map(), // tab 对象引用 -> { term, readScreen }（用对象引用做 key，重连换 id 也不失效）
    split: null, // 并列模式：{ top, bottom } 两个 tab 对象引用上下各占 1/2（存引用不存 id，重连换 id 不失效）
    quality: new Map(), // connId -> { ok, rtt, loss }（标签栏延迟/丢包显示）
    recording: null // { connId, tabName, startedAt, buffer: [{t, s}] } 会话录制状态
  }),
  getters: {
    activeTab(state) {
      return state.tabs.find((t) => t.id === state.activeTabId) || null
    },
    activePane(state) {
      return state.activeTab ? state.paneRefs.get(state.activeTab) : null
    },
    // 并列模式下面板可见性判断（App.vue 用）
    // 并列关系一旦建立就保留：切到第三个 tab 时临时全屏显示它，
    // 点回并列成员自动恢复上下并列（不再像旧版一样切走就拆散）
    isPaneVisible(state) {
      return (tab) => {
        if (!state.split) return tab.id === state.activeTabId
        const inSplit = tab === state.split.top || tab === state.split.bottom
        const activeInSplit = state.activeTabId === state.split.top.id || state.activeTabId === state.split.bottom.id
        return activeInSplit ? inSplit : tab.id === state.activeTabId
      }
    },
    qualityOf(state) {
      return (connId) => state.quality.get(connId) || null
    }
  },
  actions: {
    // 打开新连接（多开同一实例即对同一实例重复调用）
    async openTab(instance) {
      const tempId = `pending_${Date.now()}_${Math.floor(Math.random() * 1e5)}`
      this.tabs.push({
        __uid: `uid_${Date.now()}_${++uidSeq}`,
        id: tempId,
        instanceId: instance.id,
        name: instance.name,
        status: 'connecting',
        error: null,
        instance: JSON.parse(JSON.stringify(instance))
      })
      this.activeTabId = tempId
      await this.establish(tempId)
    },

    // 并列：把指定服务器的连接与当前终端上下各占 1/2 高度
    // instance 由"并列"按钮的选择器传入（可以是当前服务器也可以是别的服务器）
    // 返回 'ok' | 'max'（已并列两个） | 'none'（无当前连接）
    async openSplit(instance) {
      if (this.split) return 'max'
      const cur = this.activeTab
      if (!cur || !instance) return 'none'
      const count = this.tabs.length
      await this.openTab(instance)
      const newTab = this.tabs.length > count ? this.tabs[this.tabs.length - 1] : null
      if (!newTab) return 'error'
      this.split = { top: cur, bottom: newTab }
      this.activeTabId = cur.id // 焦点留在用户正看着的上半格
      return 'ok'
    },

    exitSplit() {
      this.split = null
    },

    // 实际建立 SSH 连接（新建与重连共用；接受 tab 对象引用）
    async establish(tabOrId) {
      const tab = typeof tabOrId === 'object' ? tabOrId : this.tabs.find((t) => t.id === tabOrId)
      if (!tab) return
      tab.status = 'connecting'
      // 深拷贝为纯对象：reactive 代理无法通过 IPC 结构化克隆
      let res
      try {
        res = await window.api.sshConnect(JSON.parse(JSON.stringify(tab.instance)))
      } catch (err) {
        tab.status = 'closed'
        tab.error = '连接发起失败：' + err.message
        return
      }
      if (!res.ok) {
        tab.status = 'closed'
        tab.error = res.error
        // 连接失败且是 pending 新标签：保留标签展示错误，用户可关闭或重试
        return
      }
      const oldId = tab.id
      tab.id = res.connId
      tab.status = 'connected'
      tab.error = null
      tab.__retryCount = 0 // 连上了就清零自动重连计数
      if (this.activeTabId === oldId) this.activeTabId = res.connId
      this.watchQuality(res.connId)
    },

    // 订阅连接质量事件（重复调用幂等；重连换 id 后旧订阅随连接关闭自动失效）
    watchQuality(connId) {
      if (qualityUnsubs.has(connId)) return
      const unsub = window.api.on(`conn:quality:${connId}`, (q) => {
        this.quality.set(connId, q)
        if (q.offline) {
          const u = qualityUnsubs.get(connId)
          if (u) { u(); qualityUnsubs.delete(connId) }
        }
      })
      qualityUnsubs.set(connId, unsub)
    },

    // 断线重连（接受 tab 对象引用，重连后 tab.id 会被替换为新 connId）
    async reconnect(tabOrId) {
      const tab = typeof tabOrId === 'object' ? tabOrId : this.tabs.find((t) => t.id === tabOrId)
      if (!tab || tab.status === 'connecting') return
      if (tab.id && tab.id.startsWith('conn_')) {
        // 尽力清理旧连接资源
        await window.api.sshClose(tab.id).catch(() => {})
      }
      await this.establish(tab)
    },

    setActive(tabId) {
      // 并列关系不因切换标签而销毁：切到第三个 tab 全屏显示，切回并列成员自动恢复
      this.activeTabId = tabId
    },

    // 并列格独立关闭（pane 右上角红叉）：关掉谁就退出并列，另一格恢复全屏
    async closeSplitPane(tab) {
      if (!this.split) return
      const other = tab === this.split.top ? this.split.bottom : this.split.top
      this.split = null
      await this.closeTab(tab.id)
      if (other && this.tabs.includes(other)) this.activeTabId = other.id
    },

    async closeTab(tabId) {
      const idx = this.tabs.findIndex((t) => t.id === tabId)
      if (idx === -1) return
      const tab = this.tabs[idx]
      if (tab.id && tab.id.startsWith('conn_')) {
        await window.api.sshClose(tab.id).catch(() => {})
      }
      // 关掉的是并列格之一：退出并列，另一个恢复全屏
      if (this.split && (tab === this.split.top || tab === this.split.bottom)) {
        this.split = null
      }
      // 关闭的是录制目标连接：先停录（不落盘没有意义，丢弃数据）
      if (this.recording && this.recording.connId === tab.id) {
        this.recording = null
      }
      this.paneRefs.delete(tab)
      this.tabs.splice(idx, 1)
      if (this.activeTabId === tabId) {
        this.activeTabId = this.tabs.length ? this.tabs[Math.max(0, idx - 1)].id : null
      }
    },

    // 意外掉线自动重连：最多 3 次，间隔 3s（手动断开不触发）
    scheduleReconnect(tab) {
      if (!tab || tab.__manualClosed) return
      tab.__retryCount = (tab.__retryCount || 0) + 1
      if (tab.__retryCount > 3) {
        tab.error = '自动重连 3 次均失败，请检查网络后手动重连'
        return
      }
      setTimeout(() => {
        // 期间用户已手动关标签或已手动重连成功则跳过
        if (!this.tabs.includes(tab) || tab.status !== 'closed') return
        this.reconnect(tab)
      }, 3000)
    },

    // 注册/注销终端面板（由 TerminalPane 调用）
    registerPane(tab, pane) {
      this.paneRefs.set(tab, pane)
    },
    unregisterPane(tab) {
      this.paneRefs.delete(tab)
    },

    // AI 向当前终端打字（等同用户手敲，服务器 echo 回显）
    writeActive(data) {
      const tab = this.activeTab
      if (!tab || !tab.id.startsWith('conn_')) throw new Error('当前没有已连接的终端')
      window.api.sshWrite(tab.id, data)
    },

    // ---------- 会话录制（asciinema v2） ----------
    startRecording(tab) {
      if (this.recording) return 'busy'
      if (!tab || !tab.id.startsWith('conn_')) return 'none'
      this.recording = {
        connId: tab.id,
        tabName: tab.name,
        startedAt: Date.now(),
        cols: 120,
        rows: 30,
        buffer: []
      }
      return 'ok'
    },

    // TerminalPane 数据回调里调用；只录开始时指定的连接
    recordChunk(connId, u8) {
      const rec = this.recording
      if (!rec || rec.connId !== connId) return
      const text = new TextDecoder('utf8').decode(u8)
      if (text) rec.buffer.push({ t: (Date.now() - rec.startedAt) / 1000, s: text })
    },

    // 停止并落盘为 .cast 文件；返回 { ok, path?, error? }
    async stopRecording() {
      const rec = this.recording
      if (!rec) return { ok: false, error: '没有进行中的录制' }
      this.recording = null
      if (!rec.buffer.length) return { ok: false, error: '录制内容为空（期间无终端输出）' }
      const config = useConfigStore()
      let dir = config.recordDir
      if (!dir) {
        try { dir = await window.api.recordingsDefaultDir() } catch { dir = '' }
        if (!dir) return { ok: false, error: '拿不到录制保存目录，请到设置→数据里指定' }
      }
      const d = new Date(rec.startedAt)
      const p = (n) => String(n).padStart(2, '0')
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
      const safeName = (rec.tabName || 'session').replace(/[\\/:*?"<>|]/g, '_')
      const filePath = (dir.replace(/[\\/]+$/, '')) + '\\' + `${safeName}_${stamp}.cast`
      // asciinema v2：首行元信息，其后每行 [相对秒, "o", 文本]
      const header = JSON.stringify({ version: 2, width: rec.cols, height: rec.rows, timestamp: Math.floor(rec.startedAt / 1000), title: rec.tabName })
      const body = rec.buffer.map((c) => JSON.stringify([Number(c.t.toFixed(3)), 'o', c.s])).join('\n')
      const res = await window.api.localWrite(filePath, header + '\n' + body + '\n')
      if (!res.ok) return { ok: false, error: '保存失败：' + res.error }
      return { ok: true, path: filePath }
    }
  }
})
