// 命令模式：AI 输出 → 若干条纯指令（纯函数，便于单测）
// 优先取代码块内容，否则整段；去掉 $/# 提示符与空行，每行一条指令
export function splitCmds(text) {
  const m = (text || '').match(/```[a-zA-Z]*\n?([\s\S]*?)```/)
  const raw = (m ? m[1] : text || '').trim()
  return raw
    .replace(/^[$#]\s*/gm, '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}
