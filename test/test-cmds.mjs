// 命令模式：AI 输出 → 若干条纯指令 拆分测试
import { splitCmds } from '../renderer/utils/cmds.mjs'

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name) }
}

console.log('代码块多指令拆分')
{
  const out = splitCmds('```bash\njournalctl -u nginx -n 100\ntruncate -s 0 /var/log/nginx/error.log\nsystemctl reload nginx\n```')
  ok(out.length === 3, '3 条指令')
  ok(out[0] === 'journalctl -u nginx -n 100', '第 1 条正确')
  ok(out[2] === 'systemctl reload nginx', '第 3 条正确')
}

console.log('去掉 $/# 提示符与空行')
{
  const out = splitCmds('```\n$ df -h\n\n# 看磁盘\nsudo rm -rf /tmp/x\n```')
  ok(out[0] === 'df -h', '$ 提示符已去掉')
  ok(out[1] === '看磁盘', '# 提示符已去掉')
  ok(out.length === 3, '空行被过滤')
}

console.log('无代码块取整段')
{
  const out = splitCmds('ls -la\ncd /var/www')
  ok(out.length === 2 && out[1] === 'cd /var/www', '整段按行拆分')
}

console.log('单条指令')
{
  const out = splitCmds('```sh\nuptime\n```')
  ok(out.length === 1 && out[0] === 'uptime', '单条直译')
}

console.log('空/无输出')
{
  ok(splitCmds('').length === 0, '空串返回空数组')
  ok(splitCmds('   \n  \n').length === 0, '纯空白返回空数组')
}

console.log(`\ntest-cmds: ${passed} 通过, ${failed} 失败`)
process.exitCode = failed ? 1 : 0
