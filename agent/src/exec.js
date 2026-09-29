// ============================================================
// 命令执行 + 危险命令确认挂起
// AI 与手动指令共用一条执行通道：危险命令一律挂起，
// 等待控制台（手机）二次确认后才执行，超时自动拒绝
// ============================================================
const { exec: childExec } = require('child_process')
const { checkDanger } = require('./danger')
const store = require('./store')

const CONFIRM_TIMEOUT = 5 * 60 * 1000 // 确认等待超时：5 分钟自动拒绝

let confirmSeq = 0
// confirmId -> { id, command, reasons, source, resolve, timer }
const pending = new Map()

// 执行 shell 命令（收集 stdout/stderr，限时）
function runShell(cmd, timeout = 120000) {
  return new Promise((resolve) => {
    childExec(cmd, { timeout, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      // 非零退出码：err.code 携带码但 stdout 可能仍有有用输出，一并返回
      resolve({
        code: err ? (err.code != null ? err.code : -1) : 0,
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
        killed: !!(err && err.killed)
      })
    })
  })
}

// 输出摘要（审计与 AI 工具结果共用；太长的输出截断）
function summarize(r, limit = 4000) {
  const text = ((r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')).trim()
  if (!text) return r.code === 0 ? '（无输出，退出码 0）' : `（无输出，退出码 ${r.code}）`
  const head = text.length > limit ? text.slice(0, limit) + `\n…（输出过长，已截断，共 ${text.length} 字符）` : text
  return r.code === 0 ? head : `[退出码 ${r.code}]\n` + head
}

/**
 * 申请执行命令（AI 工具通道；手动指令走 index.js 的两段式确认）
 * 危险命令挂起等待手机端裁决，其余直接执行
 * @param {string} command
 * @param {'ai'} source 来源（审计用）
 * @param {(evt: object) => void} [onEvent] 挂起时通知（AI 流式通道推 confirm 事件用）
 * @returns {Promise<{ needConfirm?: boolean, confirmId?: string, reasons?: string[], output?: string, code?: number }>}
 */
async function requestExec(command, source, onEvent) {
  const { danger, reasons } = checkDanger(command)
  if (!danger) {
    const r = await runShell(command)
    store.appendAudit({ time: Date.now(), source, command, danger: false, approved: null, code: r.code, output: summarize(r, 300) })
    return { output: summarize(r), code: r.code }
  }

  // 危险命令：注册待确认，等待手机端裁决
  const id = `cf_${Date.now()}_${++confirmSeq}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      store.appendAudit({ time: Date.now(), source, command, danger: true, approved: false, note: '确认超时自动拒绝' })
      resolve({ output: '[已拒绝] 确认超时（5 分钟未处理），命令未执行。如需执行请重新发起。' })
    }, CONFIRM_TIMEOUT)
    pending.set(id, {
      id, command, reasons, source, timer,
      onEvent,
      resolve: async (approved) => {
        clearTimeout(timer)
        pending.delete(id)
        if (!approved) {
          store.appendAudit({ time: Date.now(), source, command, danger: true, approved: false, note: '用户拒绝' })
          resolve({ output: '[已拒绝] 用户在控制台拒绝了该命令，未执行。请向用户说明并询问下一步。' })
          return
        }
        const r = await runShell(command)
        store.appendAudit({ time: Date.now(), source, command, danger: true, approved: true, code: r.code, output: summarize(r, 300) })
        resolve({ output: summarize(r), code: r.code })
      }
    })
    // 通知调用方有确认请求（AI 通道推 SSE 事件；手动通道由路由层直接返回 needConfirm）
    store.appendAudit({ time: Date.now(), source, command, danger: true, approved: null, note: '等待确认' })
    if (onEvent) onEvent({ type: 'confirm', id, command, reasons })
  })
}

// 用户裁决
function resolveConfirm(id, approve) {
  const p = pending.get(id)
  if (!p) return false
  p.resolve(!!approve)
  return true
}

// 当前待确认列表（断线重连后恢复视图用）
function listPending() {
  return [...pending.values()].map((p) => ({ id: p.id, command: p.command, reasons: p.reasons, source: p.source }))
}

module.exports = { requestExec, resolveConfirm, listPending, runShell, summarize }
