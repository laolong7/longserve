// ============================================================
// AI 上下文构建（纯函数，渲染层与测试共用）
// DeepSeek 思考模式 + 工具调用的硬性要求（官方文档 2026-09）：
//   携带 tools 的请求，历史里【每一条】assistant 消息都必须完整回传
//   reasoning_content 字段——哪怕该条没有思考内容（回传空串），
//   缺字段一律 400："The 'reasoning_content' in the thinking mode
//   must be passed back to the API"。字段名兼容策略可配置：
//   reasoning_content（DeepSeek/多数网关）/ thinking（个别 v4 校验）/ both
// ============================================================

/**
 * 把渲染层消息数组转成 OpenAI 兼容 messages
 * @param {Array} recentMsgs 渲染层消息（role/content/reasoning/toolCalls）
 * @param {string} systemContent 系统提示词
 * @param {{ reasoningBack?: boolean, reasoningField?: 'auto'|'reasoning_content'|'thinking'|'both' }} opts
 *   reasoningBack=false 时不回传思考内容；
 *   reasoningField 控制 assistant 消息上思考字段名（auto=reasoning_content）
 * @returns {Array} OpenAI 风格 messages
 */
export function buildOpenAiMessages(recentMsgs, systemContent, { reasoningBack = true, reasoningField = 'auto' } = {}) {
  const out = [{ role: 'system', content: systemContent }]
  const fieldMode = reasoningField || 'auto'
  for (const m of recentMsgs) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      const toolCalls = (m.toolCalls || []).map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.argsJson || '{}' }
      }))
      const msg = { role: 'assistant', content: m.content || null }
      // 思考内容回传：开启时【每条】 assistant 消息都带字段（无思考回传空串），
      // 这是 DeepSeek 400 "must be passed back" 的根治点——缺字段=必炸
      if (reasoningBack) {
        const r = m.reasoning || ''
        if (fieldMode === 'reasoning_content' || fieldMode === 'auto' || fieldMode === 'both') {
          msg.reasoning_content = r
        }
        if (fieldMode === 'thinking' || fieldMode === 'both') {
          msg.thinking = r
        }
      }
      if (toolCalls.length) {
        msg.tool_calls = toolCalls
      } else if (!m.content) {
        // 只输出思考、正文为空且未调工具的轮次（DeepSeek 思考模式偶发）：
        // content/tool_calls 双空会被 DeepSeek 拒（Invalid assistant message），
        // 用空格占位保住这条消息的思考回传
        msg.content = ' '
      }
      out.push(msg)
      for (const tc of m.toolCalls || []) {
        out.push({ role: 'tool', tool_call_id: tc.id, content: tc.result || '' })
      }
    }
  }
  return out
}

// ---------- 报错分类（决定重试策略，两类方向相反，绝不能混） ----------
// A. 网关【拒绝】思考字段（字段多余/不认）→ 剥掉字段重试
export const REASONING_REJECT_RE =
  /Unrecognized request argument.*reasoning|unexpected.*reasoning|unknown field.*reasoning|unknown parameter.*reasoning|Extra inputs are not permitted.*reasoning|Invalid 'reasoning|thinking.*not.*support/i

// B. 网关【要求】思考回传（字段缺失）→ 绝不能剥字段（越剥越错），提示用户
export const REASONING_MISSING_RE =
  /must be passed back|reasoning_content.*must|must.*reasoning_content|required.*reasoning_content/i

// 兼容旧引用：两类任一命中（旧语义=“与 reasoning 字段有关的报错”）
export const REASONING_ERR_RE = new RegExp(
  `(${REASONING_REJECT_RE.source})|(${REASONING_MISSING_RE.source})`,
  'i'
)
