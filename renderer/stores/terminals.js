// 终端标签 store：多开连接、激活切换、断线重连
// TerminalPane 组件把自己注册进 paneRefs，供 AI 读写当前终端
import { defineStore } from 'pinia'

let uidSeq = 0 // tab 稳定 uid：pending -> conn_ 的 id 变化不影响 v-for key

export const useTerminalStore = defineStore('terminals', {
  state: () => ({
    tabs: [], // { id(connId), instanceId, name, status: connecting|connected|closed, instance快照 }
    activeTabId: null,
    paneRefs: new Map() // tab 对象引用 -> { term, readScreen }（用对象引用做 key，重连换 id 也不失效）
  }),
  getters: {
    activeTab(state) {
      return state.tabs.find((t) => t.id === state.activeTabId) || null
    },
    activePane(state) {
      return state.activeTab ? state.paneRefs.get(state.activeTab) : null
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
      this.activeTabId = tabId
    },

    async closeTab(tabId) {
      const idx = this.tabs.findIndex((t) => t.id === tabId)
      if (idx === -1) return
      const tab = this.tabs[idx]
      if (tab.id && tab.id.startsWith('conn_')) {
        await window.api.sshClose(tab.id).catch(() => {})
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
    }
  }
})
