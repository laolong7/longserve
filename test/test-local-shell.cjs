// ============================================================
// 本地 Shell 管理器冒烟测试（本机 cmd/bash，不碰网络）
// 覆盖：open 启动 / attach 缓冲契约 / write 输入回显 / kill 关闭事件
// 运行：node test/test-local-shell.cjs
// ============================================================
const { LocalShellManager } = require('../main/local-shell')

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name) }
}

const events = [] // { ch, payload }
const mgr = new LocalShellManager((ch, payload) => events.push({ ch, payload }))

;(async () => {
  // 1. 打开 shell
  const { shellId } = await mgr.open()
  ok(/^local_\d+/.test(shellId), 'shellId 形如 local_*（渲染层按前缀路由）')
  ok(mgr.alive(shellId), 'shell 已存活')

  // 2. 输入 echo 回显（Windows cmd / Unix bash 通用命令）
  await new Promise((r) => setTimeout(r, 400)) // 等 shell 起完（chcp 等）
  mgr.write(shellId, 'echo local-shell-ok\n')
  await new Promise((r) => setTimeout(r, 700))

  // 3. attach 契约：合并 Buffer 或 null（与 sshManager.attach 同构）
  const merged = mgr.attach(shellId)
  ok(merged === null || merged instanceof Buffer, 'attach 返回合并 Buffer 或 null')
  const text = String(merged || '') + events.map((e) => String(e.payload)).join('')
  ok(text.includes('local-shell-ok'), '写入的命令有回显输出')

  // 4. attach 后数据走事件通道
  mgr.write(shellId, 'echo after-attach\n')
  await new Promise((r) => setTimeout(r, 700))
  const after = events.filter((e) => e.ch === `local:data:${shellId}`).map((e) => String(e.payload)).join('')
  ok(after.includes('after-attach'), 'attach 后输出经 local:data 事件送达')

  // 5. kill：关闭事件 + 不再存活
  mgr.kill(shellId)
  await new Promise((r) => setTimeout(r, 500))
  ok(!mgr.alive(shellId), 'kill 后 shell 已移除')
  ok(events.some((e) => e.ch === `local:close:${shellId}`), '关闭事件 local:close 已发出')

  // 6. 写入已关闭 shell 抛错（不静默）
  let threw = false
  try { mgr.write(shellId, 'x') } catch { threw = true }
  ok(threw, '向已关闭 shell 写入抛错')

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  process.exitCode = failed ? 1 : 0
  process.exit() // shell 全关了，直接退
})().catch((e) => {
  console.error('测试执行异常:', e)
  process.exit(1)
})
