// 配置 store：实例列表 + AI 多配置（读写走主进程持久化）
import { defineStore } from 'pinia'

export const useConfigStore = defineStore('config', {
  state: () => ({
    instances: [],
    aiProviders: [],
    activeAiProviderId: null,
    skills: [],
    pipelines: [], // { id, name, steps: [{ skillId, checkpoint }] } 技能流水线
    recordDir: '', // 会话录制保存目录（空=默认）
    appearance: null,
    defaultsVersion: 0, // 预设技能/流水线版本标记（主进程 store.js 用，保存时必须透传）
    runtimeEffect: null, // 当前窗口实际生效的窗口效果（运行时状态，不持久化；改效果选"下次应用"时与 appearance.windowEffect 短暂不一致）
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
      this.pipelines = cfg.pipelines || []
      this.recordDir = cfg.recordDir || ''
      this.appearance = cfg.appearance || null
      this.defaultsVersion = Number(cfg.defaultsVersion) || 0
      this.runtimeEffect = this.appearance?.windowEffect || 'none'
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
        pipelines: JSON.parse(JSON.stringify(this.pipelines)),
        recordDir: this.recordDir,
        appearance: this.appearance ? JSON.parse(JSON.stringify(this.appearance)) : null,
        defaultsVersion: this.defaultsVersion,
        seq: Date.now() % 100000
      })
    },
    newInstanceId() {
      return `inst_${Date.now()}_${Math.floor(Math.random() * 1e5)}`
    },
    newPipelineId() {
      return `pl_${Date.now()}_${Math.floor(Math.random() * 1e5)}`
    },
    newProviderId() {
      return `ai_${Date.now()}_${Math.floor(Math.random() * 1e5)}`
    },
    newSkillId() {
      return `sk_${Date.now()}_${Math.floor(Math.random() * 1e5)}`
    }
  }
})
