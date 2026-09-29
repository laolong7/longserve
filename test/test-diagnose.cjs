// ============================================================
// AI 部署诊断 - parseDiagnosis 容错解析测试
// 运行：node test/test-diagnose.cjs
// ============================================================
const { parseDiagnosis } = require('../main/agent-diagnose')

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name) }
}

// 标准 JSON
let r = parseDiagnosis('{"rootCause":"glibc 过老","fix":"换 glibc-217 构建","confidence":"high"}')
ok(r.rootCause === 'glibc 过老' && r.confidence === 'high' && r.fix === '换 glibc-217 构建', '标准 JSON 解析')

// ```json 包裹
r = parseDiagnosis('```json\n{"rootCause":"端口占用","fix":"换端口","confidence":"high"}\n```')
ok(r.rootCause === '端口占用', 'markdown 代码块包裹解析')

// 前后带杂文
r = parseDiagnosis('好的，分析结果如下：\n{"rootCause":"安全组拦截","fix":"云控制台放行 37777","confidence":"medium"}\n希望对你有帮助')
ok(r.rootCause === '安全组拦截' && r.confidence === 'medium', '前后杂文中的 JSON 提取')

// 非法 confidence 降级为 medium
r = parseDiagnosis('{"rootCause":"x","fix":"y","confidence":"很确定"}')
ok(r.confidence === 'medium', '非法 confidence 降级 medium')

// 缺 fix 字段容忍
r = parseDiagnosis('{"rootCause":"只有根因"}')
ok(r.rootCause === '只有根因' && r.fix === '', '缺 fix 字段容忍为空串')

// 纯文本降级（AI 不按 JSON 说）
r = parseDiagnosis('这个日志看起来是 glibc 版本太低了，建议升级系统。')
ok(r.confidence === 'low' && r.rootCause.includes('glibc'), '纯文本降级为低把握诊断')

// 空文本
r = parseDiagnosis('')
ok(r.rootCause.includes('空内容') && r.confidence === 'low', '空文本兜底')

// 坏 JSON（{ 开头但不完整）
r = parseDiagnosis('{"rootCause": "没写完')
ok(r.confidence === 'low', '截断 JSON 降级纯文本')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exitCode = failed ? 1 : 0
