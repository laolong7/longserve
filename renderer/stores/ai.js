// ============================================================
// AI 副驾 store
// OpenAI 兼容流式对话 + 原生 function calling 工具循环
// 工具分三类：
//   终端类：run_command / read_terminal / sftp_list
//   本地类：list_local / read_local_file / write_local_file / delete_local / download_server_file
//   技能类：use_skill（加载牢笼自定义技能后继续任务）
// 历史会话：按服务器与时间自动持久化，可搜索、可恢复
// ============================================================
import { defineStore } from 'pinia'
import { useConfigStore } from './config'
import { useTerminalStore } from './terminals'
import { useDialogStore } from './dialog'
import { checkDanger } from '../utils/danger'
import { splitCmds } from '../utils/cmds.mjs'
import { buildOpenAiMessages, REASONING_ERR_RE } from '../utils/aictx.mjs'

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
  },
  {
    type: 'function',
    function: {
      name: 'list_local',
      description: '列出本机（用户的电脑）某个目录的文件与子目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本机目录绝对路径，如 C:\\Users\\xx\\Desktop' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_local_file',
      description: '读取本机文本文件内容（限 200KB 内的文本文件）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本机文件绝对路径' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_local_file',
      description:
        '写入/创建本机文件（覆盖或新建）。会先弹窗请用户确认。可用于在桌面生成报告、日志、配置等文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本机文件绝对路径' },
          content: { type: 'string', description: '要写入的完整文本内容' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_local',
      description: '删除本机文件或文件夹（文件夹递归删除）。会先弹窗请用户确认。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本机路径' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'download_server_file',
      description:
        '把服务器上的文件/文件夹下载到本机指定路径（SFTP 下载，支持文件夹递归）。会先弹窗请用户确认。' +
        '适合"把服务器上的日志调一份到我桌面"这类需求。',
      parameters: {
        type: 'object',
        properties: {
          remotePath: { type: 'string', description: '服务器上的文件/目录绝对路径' },
          localPath: { type: 'string', description: '本机目标绝对路径（目录或文件路径）' }
        },
        required: ['remotePath', 'localPath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'use_skill',
      description: '加载一个用户自定义技能的完整内容。当任务匹配某个技能的触发场景时，先调用本工具获取技能指导，再按技能内容执行。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '技能名称（须与可用技能列表中的名称完全一致）' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'backup_file',
      description:
        '修改服务器上的任何配置文件/重要文件之前，先备份原文件（cp -a 原文件 原文件.laoji-bak-时间戳）。' +
        '这是强制安全网：之后可以用 restore_file 一键还原。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要备份的文件绝对路径' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'restore_file',
      description: '把之前用 backup_file 备份的文件还原回原路径。会先弹窗请用户确认。用于撤销修改、回滚配置。',
      parameters: {
        type: 'object',
        properties: {
          backupPath: { type: 'string', description: '备份文件路径（.laoji-bak- 结尾的那份）' },
          restoreTo: { type: 'string', description: '还原到的原路径' }
        },
        required: ['backupPath', 'restoreTo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_snapshots',
      description: '列出本会话中所有已备份的文件快照（路径、备份位置、时间）。用户问"改了哪些文件/怎么撤销"时调用。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  }
]

const SYSTEM_PROMPT = `你是牢笼的服务器管理 AI 副驾，运行在一款桌面 SSH 终端工具的右侧对话框中。

你的能力分三类：
1. 服务器操作：run_command（在用户可见的终端里执行命令）、read_terminal（读终端画面）、sftp_list（查远程目录）
2. 本机操作：list_local / read_local_file（查本机文件）、write_local_file（写本机文件，会请求确认）、delete_local（删本机文件，会请求确认）、download_server_file（服务器文件下载到本机，会请求确认）
3. 安全网与技能：backup_file（改文件前先备份，强制）、restore_file（一键还原）、list_snapshots（查看快照）、use_skill（加载用户自定义的技能内容）

工作守则：
1. 执行命令前先用一句话说明要做什么、为什么；执行后主动 read_terminal 确认结果再向用户汇报
2. 涉及删除、重启、修改配置、影响在线业务的操作属于重大操作，务必在 run_command 的 purpose 里写清楚影响；系统会自动弹窗让用户二次确认
3. 【铁律】修改服务器上的任何配置文件或重要文件之前，必须先调用 backup_file 备份原文件；用户要求撤销/回滚时用 restore_file 还原，并 read_terminal 验证还原结果
4. 一次只执行一条命令；避免执行长时间阻塞的命令（如 tail -f、top 交互模式、vim）
5. 用户的本机是 Windows，路径用反斜杠（如 C:\\Users\\...）；给用户的桌面生成文件时用 systemContext 里提供的桌面路径
6. 回答用中文，简洁专业，给出可操作的建议
7. 不确定的事情就先用工具查证，不要凭空猜测`

// 自然语言→命令模式（不走工具、不进历史上下文）
// 输出若干条纯指令（按执行顺序），不是一条命令，也不是带解释的方案
const CMD_SYSTEM = `你是 Linux 指令转换器。把用户的自然语言需求转化成若干条纯 Linux 指令（按执行顺序排列）。
规则：
1. 只输出指令本身：每条指令一行，放在一个代码块里，不写任何解释、序号或多余文字
2. 需求简单就给 1 条；复杂需求拆成多条（如先查看再操作、先备份再修改）
3. 指令面向典型 Linux 服务器（systemd 发行版），可用 sudo
4. 尽量安全：优先查看类指令；涉及修改/删除时保持最小影响面`

let msgSeq = 0
const newMsgId = () => `msg_${Date.now()}_${++msgSeq}`
let sessionSeq = 0

export const useAiStore = defineStore('ai', {
  state: () => ({
    messages: [],
    running: false,
    lastError: '',
    cmdMode: false, // 命令模式：输入自然语言直译成若干条纯指令（不调用工具）；默认为副驾模式
    snapshots: [], // 本会话文件快照 { path, backup, time, server, local? }
    _desktopPath: '', // 桌面路径缓存（本机文件工具/系统上下文用）
    // 当前会话元信息（历史记录用）
    sessionMeta: null // { id, title, serverName, host, createdAt, updatedAt, hasDanger }
  }),
  actions: {
    clear() {
      if (this.running) return
      this.messages = []
      this.sessionMeta = null
      this.lastError = ''
      this.snapshots = []
    },

    abort() {
      if (this._activeEventId) window.api.aiAbort(this._activeEventId)
      this._typingAbort = true // 同时中断正在打字的命令
    },

    // ---------- 历史会话 ----------
    async persistSession() {
      if (!this.messages.length) return
      const terminals = useTerminalStore()
      const tab = terminals.activeTab
      const now = Date.now()
      if (!this.sessionMeta) {
        this.sessionMeta = {
          id: `ses_${now}_${++sessionSeq}`,
          title: (this.messages.find((m) => m.role === 'user')?.content || '新会话').slice(0, 40),
          serverName: tab ? tab.name : '未连接',
          host: tab ? `${tab.instance.username}@${tab.instance.host}` : '',
          createdAt: now,
          hasDanger: false
        }
      }
      this.sessionMeta.updatedAt = now
      this.sessionMeta.messageCount = this.messages.length

      // 存到主进程
      const sessions = await window.api.historyList()
      const simplified = this.messages.map((m) => ({
        role: m.role,
        content: m.content,
        reasoning: m.reasoning || '', // 思考内容随历史保存：恢复会话后 DeepSeek 思考模式仍可正常续传
        tools: (m.toolCalls || []).map((tc) => ({
          name: tc.name,
          args: tc.argsJson,
          result: (tc.result || '').slice(0, 2000),
          status: tc.status
        }))
      }))
      const rec = { ...JSON.parse(JSON.stringify(this.sessionMeta)), messages: simplified }
      const idx = sessions.findIndex((s) => s.id === rec.id)
      if (idx >= 0) sessions[idx] = rec
      else sessions.unshift(rec)
      // 上限 200 个会话，防文件无限膨胀
      await window.api.historySave(sessions.slice(0, 200))
    },

    async loadSessions() {
      return await window.api.historyList()
    },

    // 调取历史：恢复到当前对话面板
    restoreSession(rec) {
      if (this.running) return
      this.messages = (rec.messages || []).map((m, i) => ({
        id: `msg_restore_${rec.id}_${i}`,
        role: m.role,
        content: m.content,
        reasoning: m.reasoning || '',
        toolCalls: (m.tools || []).map((tc, j) => ({
          id: `tc_${i}_${j}`,
          name: tc.name,
          argsJson: tc.args || '{}',
          purpose: '',
          status: tc.status || 'done',
          result: tc.result || ''
        })),
        status: 'done'
      }))
      this.sessionMeta = {
        id: `ses_${Date.now()}_restore`,
        title: rec.title,
        serverName: rec.serverName,
        host: rec.host,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        hasDanger: rec.hasDanger
      }
    },

    async deleteSession(id) {
      const sessions = await window.api.historyList()
      await window.api.historySave(sessions.filter((s) => s.id !== id))
    },

    // ---------- 发送与工具循环 ----------
    async send(text) {
      if (this.running || !text.trim()) return
      const config = useConfigStore()
      if (!config.activeProvider) {
        this.lastError = '请先在左下角「实例与 AI 设置」中添加并选择一个 AI 配置'
        return
      }
      // 密钥解密失败/为空：直接拦截，不发请求（哨兵值由主进程 store.js 注入）
      const key = config.activeProvider.apiKey || ''
      if (key.includes('DECRYPT_FAILED') || !key.trim()) {
        this.lastError = 'API Key 解密失败或未填写，请到 AI 设置重新填写 API Key'
        return
      }
      // 缓存桌面路径（systemContext 注入用；失败不阻塞对话）
      if (!this._desktopPath) {
        try { this._desktopPath = await window.api.localDesktop() } catch { /* 忽略 */ }
      }
      // 命令模式：直译成若干条纯指令，不走工具循环
      if (this.cmdMode) return this.translate(text)
      this.lastError = ''
      this.messages.push({ id: newMsgId(), role: 'user', content: text.trim() })
      await this.runLoop()
    },

    // ---------- 自然语言 → 若干条纯指令 ----------
    async translate(text) {
      const config = useConfigStore()
      const dialog = useDialogStore()
      this.lastError = ''
      const msg = {
        id: newMsgId(),
        role: 'assistant',
        kind: 'cmd',
        prompt: text.trim(),
        content: '',
        cmds: [], // [{ text, done }] 若干条纯指令，逐条或一键顺序执行
        reasoning: '',
        model: config.activeProvider.model || '',
        toolCalls: [],
        status: 'streaming'
      }
      this.messages.push(msg)
      this.running = true
      try {
        const res = await this.streamOnce(config.activeProvider, msg, {
          messages: [
            { role: 'system', content: CMD_SYSTEM },
            { role: 'user', content: text.trim() }
          ],
          tools: null
        })
        msg.status = 'done'
        if (res.aborted) msg.content += '\n\n（已停止）'
        else if (res.error) {
          this.lastError = res.error
          if (!msg.content) msg.content = '（请求失败）'
        } else {
          // 提取指令：每行一条纯指令（见 utils/cmds.mjs）
          msg.cmds = splitCmds(msg.content).map((t) => ({ text: t, done: false }))
          if (!msg.cmds.length) this.lastError = 'AI 没有给出有效指令，换个说法试试'
        }
      } finally {
        this.running = false
        this._activeEventId = null
      }
    },

    // 执行 cmd 消息里第 i 条指令（复用危险拦截 + 打字机）
    async executeCmd(msg, i) {
      const dialog = useDialogStore()
      const terminals = useTerminalStore()
      const c = (msg.cmds || [])[i]
      if (!c || c.done) return
      if (!terminals.activeTab || terminals.activeTab.status !== 'connected') {
        this.lastError = '当前没有已连接的终端，无法执行'
        return
      }
      const { danger, reasons } = checkDanger(c.text)
      if (danger) {
        const ok = await dialog.askConfirm({ title: `执行 AI 生成的指令（${i + 1}/${msg.cmds.length}）`, command: c.text, reasons })
        if (!ok) return
        if (this.sessionMeta) this.sessionMeta.hasDanger = true
      }
      const typed = await this.typeIntoTerminal(c.text)
      if (typed) c.done = true
      else dialog.showToast('已中止输入')
    },

    // 一键顺序执行全部未执行的指令（每条仍走危险拦截；被拒/中止则停下）
    async executeAllCmds(msg) {
      for (let i = 0; i < (msg.cmds || []).length; i++) {
        if (msg.cmds[i].done) continue
        await this.executeCmd(msg, i)
        if (!msg.cmds[i].done) break // 用户拒绝或中止：不再继续后面的指令
      }
    },

    // ---------- 选中终端输出问 AI（带上下文） ----------
    async askSelection(selText, screenText, serverName) {
      if (this.running) {
        this.lastError = 'AI 正在处理上一条消息，稍等一下'
        return
      }
      const config = useConfigStore()
      if (!config.activeProvider) {
        this.lastError = '请先在左下角「实例与 AI 设置」中添加并选择一个 AI 配置'
        return
      }
      this.lastError = ''
      const text =
        `我在终端里选中了这段输出（来自 ${serverName}）：\n\`\`\`\n${selText.slice(0, 2000)}\n\`\`\`\n` +
        (screenText ? `\n当前终端屏幕（供参考）：\n\`\`\`\n${screenText}\n\`\`\`\n` : '') +
        `请解释这段内容；如果是报错，分析原因并给出修复命令（重大操作会弹窗确认）。`
      this.messages.push({ id: newMsgId(), role: 'user', content: text })
      await this.runLoop()
    },

    // ---------- 快照还原（快照面板入口） ----------
    async restoreSnapshot(snap) {
      const dialog = useDialogStore()
      if (snap.local) {
        // 本机快照：直接写回
        const orig = await window.api.localRead(snap.backup)
        if (!orig.ok) { this.lastError = '备份文件读取失败：' + orig.error; return }
        const res = await window.api.localWrite(snap.path, orig.content)
        dialog.showToast(res.ok ? '已还原本机文件：' + snap.path : '还原失败：' + res.error)
        return
      }
      const terminals = useTerminalStore()
      const tab = terminals.activeTab
      if (!tab || tab.status !== 'connected') {
        this.lastError = '请先连接对应服务器再还原'
        return
      }
      const ok = await dialog.askConfirm({
        title: '还原文件快照',
        message: `将用备份覆盖现有文件：\n${snap.backup} → ${snap.path}\n（服务器：${snap.server}，请确认当前连接的是该服务器）`
      })
      if (!ok) return
      const res = await window.api.sshExec(tab.id, `cp -a -- ${shQuote(snap.backup)} ${shQuote(snap.path)}`, 15000)
      if (res.ok) dialog.showToast('已还原：' + snap.path)
      else this.lastError = '还原失败：' + res.error
    },

    // ---------- 技能流水线：按步骤执行，检查点暂停确认 ----------
    async runPipeline(pl) {
      const dialog = useDialogStore()
      const config = useConfigStore()
      if (this.running) {
        dialog.showToast('AI 正忙，等当前任务结束再跑流水线')
        return
      }
      for (let i = 0; i < pl.steps.length; i++) {
        const skill = config.skills.find((s) => s.id === pl.steps[i].skillId)
        if (!skill) {
          this.lastError = `流水线「${pl.name}」步骤 ${i + 1} 的技能不存在（可能已删除）`
          return
        }
        await this.send(
          `【流水线「${pl.name}」步骤 ${i + 1}/${pl.steps.length}】请按技能「${skill.name}」执行该步骤的任务，完成后简要汇报结果并停下等我确认。`
        )
        if (this.lastError) return
        if (pl.steps[i].checkpoint !== false) {
          const ok = await dialog.askConfirm({
            title: `流水线检查点：步骤 ${i + 1}/${pl.steps.length}`,
            message: `「${skill.name}」已执行完毕。请检查终端与服务器状态，确认无误后继续。`
          })
          if (!ok) {
            dialog.showToast(`流水线「${pl.name}」已在步骤 ${i + 1} 中止`)
            return
          }
        }
      }
      dialog.showToast(`流水线「${pl.name}」全部步骤执行完毕 ✓`)
    },

    async runLoop() {
      const config = useConfigStore()
      const terminals = useTerminalStore()
      this.running = true
      this._typingAbort = false // 每轮循环重置打字中断标记

      try {
        for (let hop = 0; hop < 8; hop++) {
          const assistant = {
            id: newMsgId(),
            role: 'assistant',
            content: '',
            reasoning: '', // 思考过程（推理模型流式输出，不进上下文/历史）
            model: config.activeProvider.model || '', // 消息标签显示具体模型
            toolCalls: [],
            status: 'streaming'
          }
          this.messages.push(assistant)

          const result = await this.streamOnce(config.activeProvider, assistant)
          assistant.status = 'done'
          if (result.degraded) {
            useDialogStore().showToast('当前网关不支持「回传思考内容」，已自动改用普通模式发送')
          }

          if (result.aborted) {
            assistant.content += '\n\n（已停止）'
            break
          }
          if (result.error) {
            this.lastError = result.error
            if (!assistant.content) assistant.content = '（请求失败）'
            break
          }

          if (!assistant.toolCalls.length) break

          for (const tc of assistant.toolCalls) {
            tc.status = 'running'
            tc.result = await this.executeTool(tc)
            tc.status = tc.result.startsWith('[已拒绝]') ? 'denied'
              : tc.result.startsWith('[错误]') ? 'error' : 'done'
            if (tc.status === 'done' && tc.name !== 'read_terminal' && tc.name !== 'list_local' && tc.name !== 'sftp_list') {
              // 有实际动作的会话，标记为事件型（历史分类用）
              if (this.sessionMeta) this.sessionMeta.hasDanger = this.sessionMeta.hasDanger || false
            }
          }
        }
      } finally {
        this.running = false
        this._activeEventId = null
        // 会话结束自动落盘（历史记录）
        this.persistSession().catch(() => {})
      }
    },

    // 外层包装：网关明确拒绝 reasoning_content 字段时（个别严格校验的中转），
    // 自动去掉思考回传重试一次，把"配置问题"变成无感降级
    async streamOnce(provider, msg, overrides = {}) {
      const res = await this.rawStreamOnce(provider, msg, overrides)
      if (
        res.error &&
        overrides.forceNoReasoning !== true &&
        provider.reasoningBack !== false &&
        REASONING_ERR_RE.test(res.error)
      ) {
        const retry = await this.rawStreamOnce(provider, msg, { ...overrides, forceNoReasoning: true })
        if (!retry.error) retry.degraded = true
        return retry
      }
      return res
    },

    rawStreamOnce(provider, msg, overrides = {}) {
      return new Promise((resolve) => {
        const eventId = `evt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
        this._activeEventId = eventId

        const pendingCalls = []

        const unsubs = [
          window.api.on(`ai:delta:${eventId}`, (piece) => {
            if (piece.reasoning) msg.reasoning += piece.reasoning
            if (piece.content) msg.content += piece.content
            if (piece.toolCalls) {
              for (const t of piece.toolCalls) {
                let cur = pendingCalls[t.index]
                if (!cur) cur = pendingCalls[t.index] = { id: '', name: '', argsJson: '', purpose: '' }
                if (t.id) cur.id += t.id
                if (t.name) cur.name += t.name
                if (t.argsFragment) cur.argsJson += t.argsFragment
              }
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

        const cleanup = () => {
          clearTimeout(watchdog)
          unsubs.forEach((u) => u())
        }

        // 渲染层兜底看门狗：主进程看门狗（总时长 5 分钟）失效时强制结束，
        // 保证 running 状态永远能回到 false，"…"不会永远转
        const watchdog = setTimeout(() => {
          cleanup()
          resolve({ error: 'AI 响应超时（5 分钟无回应），请重试；若持续出现请检查网络或重填 API Key' })
        }, 330000)

        const baseMessages = overrides.messages || this.toOpenAiMessages()
        const body = {
          // 降级重试时剥掉所有 assistant 消息的 reasoning_content 字段
          messages: overrides.forceNoReasoning
            ? baseMessages.map((m) => {
                if (m.role !== 'assistant' || !m.reasoning_content) return m
                const { reasoning_content, ...rest } = m
                return rest
              })
            : baseMessages,
          temperature: 0.4
        }
        // tools: null 表示本轮禁用工具（命令模式）；默认带全量工具
        if (overrides.tools !== null) body.tools = TOOLS

        window.api
          .aiChat({ eventId, provider: JSON.parse(JSON.stringify(provider)), body })
          .catch((err) => {
            cleanup()
            resolve({ error: '请求异常：' + err.message })
          })
      })
    },

    toOpenAiMessages() {
      const config = useConfigStore()
      // reasoningBack：AI 配置级开关（默认开启），DeepSeek 思考模式+工具调用必需
      const reasoningBack = config.activeProvider?.reasoningBack !== false
      return buildOpenAiMessages(this.messages.slice(-40), this.systemContext(), { reasoningBack })
    },

    systemContext() {
      const terminals = useTerminalStore()
      const config = useConfigStore()
      const tab = terminals.activeTab
      let ctx = SYSTEM_PROMPT

      if (tab) {
        ctx += `\n\n当前连接的服务器：${tab.name}（${tab.instance.username}@${tab.instance.host}:${tab.instance.port}），状态：${tab.status === 'connected' ? '已连接' : '未连接'}`
      } else {
        ctx += '\n\n当前没有连接任何服务器。本机操作类工具（list_local 等）不依赖服务器连接。'
      }

      // 技能清单注入：AI 据此决定何时 use_skill
      const skills = (config.skills || []).filter((s) => s.enabled)
      if (skills.length) {
        ctx += '\n\n可用技能（任务匹配触发场景时先调用 use_skill 加载）：'
        for (const s of skills) {
          ctx += `\n- ${s.name}：${s.description}`
        }
      }

      // 本机常用路径注入（send 时已缓存桌面路径）
      ctx += `\n\n本机信息：Windows 系统。桌面路径：${this._desktopPath || '（获取中）'}`
      return ctx
    },

    // ---------- 工具执行 ----------
    async executeTool(tc) {
      const terminals = useTerminalStore()
      const dialog = useDialogStore()
      const config = useConfigStore()
      let args = {}
      try { args = JSON.parse(tc.argsJson || '{}') } catch { /* 参数解析失败按空处理 */ }

      try {
        // ---- 终端类 ----
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

        // ---- 本机类 ----
        if (tc.name === 'list_local') {
          const res = await window.api.localList(args.path || (await window.api.localHome()))
          if (!res.ok) return '[错误] ' + res.error
          if (!res.entries.length) return '（目录为空）'
          return res.entries
            .map((e) => `${e.isDir ? 'd' : '-'} ${e.isDir ? '' : formatSize(e.size) + ' '}${e.name}`)
            .join('\n')
        }
        if (tc.name === 'read_local_file') {
          const res = await window.api.localRead(args.path)
          if (!res.ok) return '[错误] ' + res.error
          return res.content
        }
        if (tc.name === 'write_local_file') {
          const ok = await dialog.askConfirm({
            title: 'AI 请求写入本机文件',
            message: `目标路径：${args.path}\n内容长度：${(args.content || '').length} 字符`,
            command: (args.content || '').slice(0, 600) + ((args.content || '').length > 600 ? '...' : ''),
            reasons: ['本机文件写入：' + args.path]
          })
          if (!ok) return '[已拒绝] 用户取消了写入'
          // 安全网：覆盖已有文件前先留一份备份（还原走文件管理器手工处理）
          let bakNote = ''
          try {
            const orig = await window.api.localRead(args.path)
            if (orig.ok) {
              const bakPath = `${args.path}.laoji-bak-${Date.now()}`
              const saved = await window.api.localWrite(bakPath, orig.content)
              if (saved.ok) {
                this.snapshots.push({ path: args.path, backup: bakPath, time: Date.now(), server: '本机', local: true })
                bakNote = `\n原文件已自动备份：${bakPath}`
              }
            }
          } catch { /* 备份失败不阻塞写入 */ }
          const res = await window.api.localWrite(args.path, args.content || '')
          if (!res.ok) return '[错误] ' + res.error
          if (this.sessionMeta) this.sessionMeta.hasDanger = true
          return `已写入本机文件：${args.path}（${(args.content || '').length} 字符）${bakNote}`
        }
        if (tc.name === 'delete_local') {
          const ok = await dialog.askConfirm({
            title: 'AI 请求删除本机文件',
            message: `将删除：${args.path}（不可恢复）`
          })
          if (!ok) return '[已拒绝] 用户取消了删除'
          const res = await window.api.localDelete(args.path, true)
          if (!res.ok) return '[错误] ' + res.error
          if (this.sessionMeta) this.sessionMeta.hasDanger = true
          return `已删除：${args.path}`
        }
        if (tc.name === 'download_server_file') {
          const tab = terminals.activeTab
          if (!tab || tab.status !== 'connected') return '[错误] 当前没有已连接的服务器，无法下载'
          const ok = await dialog.askConfirm({
            title: 'AI 请求下载服务器文件到本机',
            message: `服务器：${tab.name}\n远程：${args.remotePath}\n保存到：${args.localPath}`
          })
          if (!ok) return '[已拒绝] 用户取消了下载'
          const taskId = window.api.sftpNewTaskId()
          const res = await window.api.sftpTransfer({
            connId: tab.id,
            taskId,
            direction: 'download',
            localPath: args.localPath,
            remotePath: args.remotePath
          })
          if (!res.ok) return '[错误] 下载失败：' + res.error
          if (this.sessionMeta) this.sessionMeta.hasDanger = true
          return `已下载到本机：${args.localPath}`
        }

        // ---- 快照类（改配置前的安全网） ----
        if (tc.name === 'backup_file') {
          const tab = terminals.activeTab
          if (!tab || tab.status !== 'connected') return '[错误] 当前没有已连接的服务器，无法备份'
          const p = String(args.path || '').trim()
          if (!p) return '[错误] 缺少文件路径'
          const bak = `${p}.laoji-bak-${Date.now()}`
          const res = await window.api.sshExec(tab.id, `cp -a -- ${shQuote(p)} ${shQuote(bak)}`, 15000)
          if (!res.ok) return '[错误] 备份失败：' + res.error
          this.snapshots.push({ path: p, backup: bak, time: Date.now(), server: tab.name })
          return `已备份：${p} → ${bak}。现在可以安全修改原文件；撤销时用 restore_file。`
        }
        if (tc.name === 'restore_file') {
          const tab = terminals.activeTab
          if (!tab || tab.status !== 'connected') return '[错误] 当前没有已连接的服务器，无法还原'
          const bak = String(args.backupPath || '').trim()
          const to = String(args.restoreTo || '').trim()
          if (!bak || !to) return '[错误] 缺少备份路径或还原目标路径'
          const ok = await dialog.askConfirm({
            title: 'AI 请求还原文件',
            message: `将用备份覆盖现有文件（不可恢复现有内容）：\n备份：${bak}\n还原到：${to}`
          })
          if (!ok) return '[已拒绝] 用户取消了还原'
          const res = await window.api.sshExec(tab.id, `cp -a -- ${shQuote(bak)} ${shQuote(to)}`, 15000)
          if (!res.ok) return '[错误] 还原失败：' + res.error
          if (this.sessionMeta) this.sessionMeta.hasDanger = true
          return `已还原：${bak} → ${to}。建议 read_terminal 或读取文件确认还原结果。`
        }
        if (tc.name === 'list_snapshots') {
          if (!this.snapshots.length) return '（本会话还没有文件快照）'
          return this.snapshots
            .map((s) => `${new Date(s.time).toLocaleTimeString()} [${s.server}] ${s.path} ← ${s.backup}`)
            .join('\n')
        }

        // ---- 技能类 ----
        if (tc.name === 'use_skill') {
          const skill = (config.skills || []).find(
            (s) => s.enabled && (s.name === args.name || s.id === args.name)
          )
          if (!skill) {
            const names = (config.skills || []).filter((s) => s.enabled).map((s) => s.name).join('、') || '（无）'
            return `[错误] 找不到技能「${args.name}」。可用技能：${names}`
          }
          return `【技能：${skill.name}】内容如下，请严格按此执行：\n\n${skill.content}`
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
        if (this.sessionMeta) this.sessionMeta.hasDanger = true
      }

      // 流式打字到可见终端：逐块输入模拟手敲节奏（服务器回显，用户全程可见）
      const typed = await this.typeIntoTerminal(cmd)
      if (!typed) return '[已中止] 用户停止了输入，命令未执行完毕'
      return `命令已输入终端执行：${cmd}。请用 read_terminal 查看执行结果。`
    },

    // 逐块写入终端，模拟真人打字速度；用户点"停止"可中断
    async typeIntoTerminal(cmd) {
      const terminals = useTerminalStore()
      const CHUNK = 3   // 每次写入字符数
      const DELAY = 16  // 间隔 ms（60 字符命令约 0.3s，观感为快速打字）
      for (let i = 0; i < cmd.length; i += CHUNK) {
        if (this._typingAbort) return false
        terminals.writeActive(cmd.slice(i, i + CHUNK))
        await new Promise((r) => setTimeout(r, DELAY))
      }
      if (this._typingAbort) return false
      terminals.writeActive('\r') // 回车执行
      return true
    }
  }
})

// shell 单引号包裹（防注入；POSIX 无单字符转义，用 '"'"' 断接）
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

function formatSize(bytes) {
  if (bytes == null) return ''
  if (bytes < 1024) return bytes + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'M'
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + 'G'
}
