// ============================================================
// AI 上下文构建（纯函数，渲染层与测试共用）
// 核心：assistant 历史消息可携带 reasoning_content 回传——
// DeepSeek 思考模式 + 工具调用同时开启时，API 强制要求把上一轮
// 思考内容原样放回 assistant message，否则拒绝请求
// ============================================================

/**
 * 把渲染层消息数组转成 OpenAI 兼容 messages
 * @param {Array} recentMsgs 渲染层消息（role/content/reasoning/toolCalls）
 * @param {string} systemContent 系统提示词
 * @param {{ reasoningBack?: boolean }} opts reasoningBack=false 时不回传思考内容
 * @returns {Array} OpenAI 风格 messages
 */
export function buildOpenAiMessages(recentMsgs, systemContent, { reasoningBack = true } = {}) {
  const out = [{ role: 'system', content: systemContent }]
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
      // 思考内容回传（DeepSeek 思考模式+工具调用必需）：
      // 同时携带 reasoning_content 与 thinking 两种字段名 —— 不同网关/模型版本
      // 要求的字段名不同（旧版认 reasoning_content，v4 思考模式按 thinking 校验），
      // 宽松网关忽略不认的字段；严格拒绝时渲染层有自动去字段重试兜底
      if (reasoningBack && m.reasoning) {
        msg.reasoning_content = m.reasoning
        msg.thinking = m.reasoning
      }
      if (toolCalls.length) {
        msg.tool_calls = toolCalls
      } else if (!m.content) {
        // 只输出思考、正文为空且未调工具的轮次（DeepSeek 思考模式偶发）：
        // content/tool_calls 双空会被 DeepSeek 拒绝（Invalid assistant message），
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

// 网关明确拒绝思考回传字段的报错特征（命中则自动去掉该字段重试一次）
export const REASONING_ERR_RE =
  /reasoning_content|reasoningContent|content\[\.?thinking\]|thinking mode|Unrecognized request argument.*reasoning|unexpected.*reasoning|unknown field.*reasoning/i
