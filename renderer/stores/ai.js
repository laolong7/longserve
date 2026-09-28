// ============================================================
// AI 副驾 store
// OpenAI 兼容流式对话 + 原生 function calling 工具循环：
//   run_command   -> 向当前可见终端打字执行（危险命令先弹确认）
//   read_terminal -> 读取当前终端屏幕 + 最近输出缓冲
//   sftp_list     -> 列出远程目录
// ============================================================
import { defineStore } from 'pinia'
import { useConfigStore } from './config'
import { useTerminalStore } from './terminals'
import { useDialogStore } from './dialog'
import { checkDanger } from '../utils/danger'

// ---------- 工具定义（OpenAI tools 格式） ----------
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        '在当前连接的服务器终端中执行一条命令。命令会真实输入到用户可见的终端并回车执行，用户能全程看到。' +
        '危险命令（删除、重启、改配置等）会先弹窗请求用户确认。执行后如需查看结果，请再调用 read_terminal。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的完整命令' },
          purpose: { type: 'string', description: '一句话说明执行目的，会展示给用户' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_terminal',
      description: '读取当前终端屏幕内容与最近输出（含滚动缓冲），用于了解命令执行结果或当前服务器状态。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'sftp_list',
      description: '列出服务器上指定目录的文件与子目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '远程目录绝对路径，如 /var/www' }
        },
        required: ['path']
      }
    }
  }
]

const SYSTEM_PROMPT = `你是牢笼的服务器管理 AI 副驾，运行在一款桌面 SSH 终端工具的右侧对话框中。

你的能力：
- 用 run_command 在用户可见的终端里执行命令（像坐在用户旁边的运维搭档，用户全程看得到）
- 用 read_terminal 读取终端当前画面与最近输出
- 用 sftp_list 查看远程目录

工作守则：
1. 执行命令前先用一句话说明要做什么、为什么；执行后主动 read_terminal 确认结果再向用户汇报
2. 涉及删除、重启、修改配置、影响在线业务的操作属于重大操作，务必在 run_command 的 purpose 里写清楚影响；系统会自动弹窗让用户二次确认
3. 一次只执行一条命令；避免执行长时间阻塞的命令（如 tail -f、top 交互模式、vim）
4. 回答用中文，简洁专业，给出可操作的建议
5. 不确定的事情就先用工具查证，不要凭空猜测`

let msgSeq = 0
const newMsgId = () => `msg_${Date.now()}_${++msgSeq}`

export const useAiStore = defineStore('ai', {
  state: () => ({
    messages: [],
    running: false,
    lastError: ''
  }),
  actions: {
    clear() {
      if (this.running) return
      this.messages = []
      this.lastError = ''
    },

    abort() {
      if (this._activeEventId) window.api.aiAbort(this._activeEventId)
    },

    async send(text) {
      if (this.running || !text.trim()) return
      const config = useConfigStore()
      if (!config.activeProvider) {
        this.lastError = '请先在右上角 AI 设置中添加并选择一个 AI 配置'
        return
      }
      this.lastError = ''
      this.messages.push({ id: newMsgId(), role: 'user', content: text.trim() })
      await this.runLoop()
    },

    // ---------- 工具循环主流程 ----------
    async runLoop() {
      const config = useConfigStore()
      const terminals = useTerminalStore()
      this.running = true

      try {
        for (let hop = 0; hop < 8; hop++) {
          const assistant = {
            id: newMsgId(),
            role: 'assistant',
            content: '',
            toolCalls: [], // { id, name, argsJson, purpose, status, result }
            status: 'streaming'
          }
          this.messages.push(assistant)

          const result = await this.streamOnce(config.activeProvider, assistant)
          assistant.status = 'done'

          if (result.aborted) {
            assistant.content += '\n\n（已停止）'
            break
          }
          if (result.error) {
            this.lastError = result.error
            if (!assistant.content) assistant.content = '（请求失败）'
            break
          }

          // 无工具调用 -> 对话结束
          if (!assistant.toolCalls.length) break

          // 逐个执行工具，结果回填后继续下一轮
          for (const tc of assistant.toolCalls) {
            tc.status = 'running'
            tc.result = await this.executeTool(tc)
            tc.status = tc.result.startsWith('[已拒绝]') ? 'denied'
              : tc.result.startsWith('[错误]') ? 'error' : 'done'
          }
          // 循环继续 -> 携带工具结果再请求
        }
      } finally {
        this.running = false
        this._activeEventId = null
      }
    },

    // 单轮流式请求：把 assistant 的 content / toolCalls 实时写入 msg 对象
    streamOnce(provider, msg) {
      return new Promise((resolve) => {
        const eventId = `evt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
        this._activeEventId = eventId

        const pendingCalls = [] // index -> { id, name, argsJson }

        const unsubs = [
          window.api.on(`ai:delta:${eventId}`, (piece) => {
            if (piece.content) msg.content += piece.content
            if (piece.toolCalls) {
              for (const t of piece.toolCalls) {
                let cur = pendingCalls[t.index]
                if (!cur) cur = pendingCalls[t.index] = { id: '', name: '', argsJson: '', purpose: '' }
                if (t.id) cur.id += t.id
                if (t.name) cur.name += t.name
                if (t.argsFragment) cur.argsJson += t.argsFragment
              }
              // 同步到消息对象（保持顺序渲染）
              msg.toolCalls = pendingCalls.filter(Boolean).map((c) => ({
                id: c.id || `call_pending_${Math.random().toString(36).slice(2, 8)}`,
                name: c.name,
                argsJson: c.argsJson,
                purpose: '',
                status: 'pending',
                result: ''
              }))
            }
          }),
          window.api.on(`ai:done:${eventId}`, (info) => {
            cleanup()
            resolve({ aborted: !!info.aborted })
          }),
          window.api.on(`ai:error:${eventId}`, (info) => {
            cleanup()
            resolve({ error: info.message })
          })
        ]

        const cleanup = () => unsubs.forEach((u) => u())

        const body = {
          messages: this.toOpenAiMessages(),
          tools: TOOLS,
          temperature: 0.4
        }

        window.api
          .aiChat({ eventId, provider: JSON.parse(JSON.stringify(provider)), body })
          .catch((err) => {
            cleanup()
            resolve({ error: '请求异常：' + err.message })
          })
      })
    },

    // 内部消息结构 -> OpenAI messages 格式（只发最近 40 条防爆上下文）
    toOpenAiMessages() {
      const out = [{ role: 'system', content: this.systemContext() }]
      const recent = this.messages.slice(-40)
      for (const m of recent) {
        if (m.role === 'user') {
          out.push({ role: 'user', content: m.content })
        } else if (m.role === 'assistant') {
          const toolCalls = (m.toolCalls || []).map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.argsJson || '{}' }
          }))
          out.push({
            role: 'assistant',
            content: m.content || null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {})
          })
          for (const tc of m.toolCalls || []) {
            out.push({ role: 'tool', tool_call_id: tc.id, content: tc.result || '' })
          }
        }
      }
      return out
    },

    // 系统提示 + 当前连接上下文
    systemContext() {
      const terminals = useTerminalStore()
      const tab = terminals.activeTab
      let ctx = SYSTEM_PROMPT
      if (tab) {
        ctx += `\n\n当前连接的服务器：${tab.name}（${tab.instance.username}@${tab.instance.host}:${tab.instance.port}），状态：${tab.status === 'connected' ? '已连接' : '未连接'}`
      } else {
        ctx += '\n\n当前没有连接任何服务器。'
      }
      return ctx
    },

    // ---------- 工具执行 ----------
    async executeTool(tc) {
      const terminals = useTerminalStore()
      let args = {}
      try { args = JSON.parse(tc.argsJson || '{}') } catch { /* 参数解析失败按空处理 */ }

      try {
        if (tc.name === 'run_command') return await this.toolRunCommand(args)
        if (tc.name === 'read_terminal') {
          const pane = terminals.activePane
          if (!pane || !terminals.activeTab || terminals.activeTab.status !== 'connected') {
            return '[错误] 当前没有已连接的终端，无法读取'
          }
          return pane.readScreen()
        }
        if (tc.name === 'sftp_list') {
          const tab = terminals.activeTab
          if (!tab || tab.status !== 'connected') return '[错误] 当前没有已连接的服务器'
          const res = await window.api.sftpList(tab.id, args.path || '/')
          if (!res.ok) return '[错误] ' + res.error
          if (!res.entries.length) return '（目录为空）'
          return res.entries
            .map((e) => `${e.isDir ? 'd' : '-'} ${e.isDir ? '' : formatSize(e.size) + ' '}${e.name}`)
            .join('\n')
        }
        return `[错误] 未知工具 ${tc.name}`
      } catch (err) {
        return '[错误] ' + err.message
      }
    },

    async toolRunCommand(args) {
      const terminals = useTerminalStore()
      const dialog = useDialogStore()
      const cmd = (args.command || '').trim()
      if (!cmd) return '[错误] 命令为空'
      if (!terminals.activeTab || terminals.activeTab.status !== 'connected') {
        return '[错误] 当前没有已连接的终端，命令未执行'
      }

      // 双保险：规则清单 + AI 自评高风险，任一命中都弹确认
      const { danger, reasons } = checkDanger(cmd)
      if (danger || args.risk === 'high') {
        const ok = await dialog.askConfirm({
          title: 'AI 请求执行危险命令',
          command: cmd,
          reasons: args.purpose ? [...reasons, 'AI 说明：' + args.purpose] : reasons
        })
        if (!ok) return '[已拒绝] 用户取消了该命令，请向用户说明并询问下一步'
      }

      // 打字到可见终端（服务器回显，用户全程可见）
      terminals.writeActive(cmd + '\r')
      return `命令已输入终端执行：${cmd}。请用 read_terminal 查看执行结果。`
    }
  }
})

function formatSize(bytes) {
  if (bytes == null) return ''
  if (bytes < 1024) return bytes + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'M'
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + 'G'
}
