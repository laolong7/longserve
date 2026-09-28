// 通用对话框 store：确认 + 文本输入（Electron 渲染层无原生 prompt）
import { defineStore } from 'pinia'

export const useDialogStore = defineStore('dialog', {
  state: () => ({
    // 确认框
    confirmVisible: false,
    confirmTitle: '',
    confirmMessage: '',
    confirmCommand: '',
    confirmReasons: [],
    _confirmResolve: null,
    // 输入框
    promptVisible: false,
    promptTitle: '',
    promptValue: '',
    _promptResolve: null,
    // 轻提示
    toast: '',
    _toastTimer: null
  }),
  actions: {
    // 确认框：Promise<boolean>
    askConfirm({ title, message = '', command = '', reasons = [] }) {
      this.confirmTitle = title || '操作确认'
      this.confirmMessage = message
      this.confirmCommand = command
      this.confirmReasons = reasons
      this.confirmVisible = true
      return new Promise((resolve) => {
        if (this._confirmResolve) this._confirmResolve(false)
        this._confirmResolve = resolve
      })
    },
    answerConfirm(ok) {
      this.confirmVisible = false
      if (this._confirmResolve) { this._confirmResolve(ok); this._confirmResolve = null }
    },

    // 文本输入：Promise<string|null>
    askInput({ title, value = '' }) {
      this.promptTitle = title || '请输入'
      this.promptValue = value
      this.promptVisible = true
      return new Promise((resolve) => {
        if (this._promptResolve) this._promptResolve(null)
        this._promptResolve = resolve
      })
    },
    answerInput(val) {
      this.promptVisible = false
      if (this._promptResolve) { this._promptResolve(val); this._promptResolve = null }
    },

    // 轻提示（自动消失）
    showToast(msg) {
      this.toast = msg
      clearTimeout(this._toastTimer)
      this._toastTimer = setTimeout(() => { this.toast = '' }, 2200)
    }
  }
})
