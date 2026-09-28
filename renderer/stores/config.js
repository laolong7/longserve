// 配置 store：实例列表 + AI 多配置（读写走主进程持久化）
import { defineStore } from 'pinia'

export const useConfigStore = defineStore('config', {
  state: () => ({
    instances: [],
    aiProviders: [],
    activeAiProviderId: null,
    skills: [],
    appearance: null,
    loaded: false
  }),
  getters: {
    activeProvider(state) {
      return state.aiProviders.find((p) => p.id === state.activeAiProviderId) || null
    }
  },
  actions: {
    async init() {
      if (this.loaded) return
      const cfg = await window.api.loadConfig()
      this.instances = cfg.instances || []
      this.aiProviders = cfg.aiProviders || []
      this.activeAiProviderId = cfg.activeAiProviderId || null
      this.skills = cfg.skills || []
      this.appearance = cfg.appearance || null
      // 自动选中第一个 AI 配置
      if (!this.activeAiProviderId && this.aiProviders.length) {
        this.activeAiProviderId = this.aiProviders[0].id
      }
      this.loaded = true
    },
    async save() {
      await window.api.saveConfig({
        instances: JSON.parse(JSON.stringify(this.instances)),
        aiProviders: JSON.parse(JSON.stringify(this.aiProviders)),
        activeAiProviderId: this.activeAiProviderId,
        skills: JSON.parse(JSON.stringify(this.skills)),
        appearance: this.appearance ? JSON.parse(JSON.stringify(this.appearance)) : null,
        seq: Date.now() % 100000
      })
    },
    newInstanceId() {
      return `inst_${Date.now()}_${Math.floor(Math.random() * 1e5)}`
    },
    newProviderId() {
      return `ai_${Date.now()}_${Math.floor(Math.random() * 1e5)}`
    },
    newSkillId() {
      return `sk_${Date.now()}_${Math.floor(Math.random() * 1e5)}`
    }
  }
})
