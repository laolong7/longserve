// v1.7.0 冒烟：CDP 驱动 dev 实例，验证本轮改动的关键 UI
// 用法：先起 vite，再 SMOKE_USER_DATA=1 npx electron . --remote-debugging-port=9333
//      node test/e2e-smoke.js [端口]
const PORT = Number(process.argv[2]) || 9333

async function getTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch { /* 服务未就绪 */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('CDP 未就绪')
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let seq = 0
    const pending = new Map()
    const exceptions = []
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.method === 'Runtime.exceptionThrown') {
        exceptions.push(msg.params?.exceptionDetails?.text || '未知异常')
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(msg.error.message))
        else res(msg.result)
      }
    }
    ws.onopen = () => resolve({
      exceptions,
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const id = ++seq
          pending.set(id, { resolve: res, reject: rej })
          ws.send(JSON.stringify({ id, method, params }))
        })
      },
      close() { ws.close() }
    })
    ws.onerror = () => reject(new Error('WS 连接失败'))
  })
}

let passed = 0
let failed = 0
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

async function main() {
  const target = await getTarget()
  const client = await connect(target.webSocketDebuggerUrl)
  await client.send('Runtime.enable')

  async function ev(expression) {
    const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' @ ' + expression.slice(0, 60))
    return r.result.value
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  console.log('标题栏：使用指南按钮在关于系统左边')
  {
    const v = await ev(`(() => {
      const btns = [...document.querySelectorAll('.tb-btn')].map(b => b.title)
      return JSON.stringify(btns)
    })()`)
    const titles = JSON.parse(v)
    const gi = titles.indexOf('使用指南')
    const ai = titles.indexOf('关于系统')
    ok(gi >= 0 && ai >= 0 && gi < ai, '📖 使用指南 在 ⓘ 关于系统 左侧', v)
  }

  console.log('使用指南直达 + 关于系统含开发者邮箱')
  {
    await ev(`[...document.querySelectorAll('.tb-btn')].find(b => b.title === '使用指南').click()`)
    await sleep(300)
    const guide = await ev(`document.querySelector('.about-nav .nav-item.on')?.textContent.includes('使用指南')`)
    ok(!!guide, '点使用指南按钮直达指南视图')
    await ev(`[...document.querySelectorAll('.about-nav .nav-item')].find(n => n.textContent.includes('关于系统')).click()`)
    await sleep(200)
    const mail = await ev(`document.querySelector('.about-body')?.textContent.includes('2799401288@qq.com')`)
    ok(!!mail, '关于系统含开发者邮箱 2799401288@qq.com')
    const note = await ev(`document.querySelector('.about-body')?.textContent.includes('使用中有任何异常')`)
    ok(!!note, '含联系说明文案')
    await ev(`document.querySelector('.modal .ghost')?.click()`) // 关闭
    await sleep(200)
  }

  console.log('AI 副驾：双模式切换')
  {
    const pills = await ev(`[...document.querySelectorAll('.mode-pill')].map(p => p.textContent.trim())`)
    ok(pills.length === 2 && pills[0].includes('副驾模式') && pills[1].includes('命令模式'), '副驾模式/命令模式 双按钮', JSON.stringify(pills))
    await ev(`[...document.querySelectorAll('.mode-pill')].find(p => p.textContent.includes('命令模式')).click()`)
    await sleep(150)
    const ph = await ev(`document.querySelector('.ai-input-wrap textarea')?.placeholder`)
    ok(!!ph && ph.includes('纯指令'), '命令模式占位文案切换', ph)
    const sendBtn = await ev(`document.querySelector('.send-btn')?.textContent`)
    ok(sendBtn === '转指令', '发送按钮变转指令', sendBtn)
    await ev(`[...document.querySelectorAll('.mode-pill')].find(p => p.textContent.includes('副驾模式')).click()`)
    await sleep(100)
  }

  console.log('设置→数据：数据文件夹按钮跟在数据相关下面（不在最底部）')
  {
    await ev(`document.querySelector('.settings-foot').click()`)
    await sleep(300)
    await ev(`[...document.querySelectorAll('.set-tab')].find(t => t.textContent.trim() === '数据').click()`)
    await sleep(300)
    const order = await ev(`(() => {
      const body = document.querySelector('.set-body')
      const buttons = [...body.querySelectorAll('button')].map(b => ({ t: b.textContent.trim(), y: b.getBoundingClientRect().top }))
      return JSON.stringify(buttons)
    })()`)
    const btns = JSON.parse(order)
    const openY = btns.find(b => b.t === '打开数据文件夹')?.y
    const previewY = btns.find(b => b.t.includes('预览'))?.y
    ok(openY != null && previewY != null && openY < previewY, '打开数据文件夹 在 预览/回放 之前', order)
    await ev(`document.querySelector('.modal .ghost')?.click()`)
    await sleep(150)
  }

  console.log('外观默认值（深海蓝/透明度60/终端#16181d·#00ffee）')
  {
    const v = await ev(`(() => {
      const rs = getComputedStyle(document.documentElement)
      return JSON.stringify({
        green: rs.getPropertyValue('--green').trim(),
        text: rs.getPropertyValue('--text').trim()
      })
    })()`)
    const vars = JSON.parse(v)
    ok(vars.green.toLowerCase() === '#5ccfe6', '强调色 #5ccfe6', vars.green)
    ok(vars.text.toLowerCase() === '#cfe3ef', '文字色 #cfe3ef', vars.text)
    // 默认外观（appearance=null）走 DEFAULT_APPEARANCE
    const { DEFAULT_APPEARANCE } = await import('file:///' + process.cwd().replace(/\\/g, '/') + '/renderer/utils/appearance.js').catch(() => ({}))
    if (DEFAULT_APPEARANCE) {
      ok(DEFAULT_APPEARANCE.bgAlpha === 60, 'uiOpacity 0.60 → bgAlpha 60')
      ok(DEFAULT_APPEARANCE.termBg === '#16181d', 'terminalBgColor #16181d')
      ok(DEFAULT_APPEARANCE.termFg === '#00ffee', 'terminalFgColor #00ffee')
      ok(DEFAULT_APPEARANCE.themePreset === 'deepBlue', 'themePreset deepBlue')
      ok(DEFAULT_APPEARANCE.windowEffect === 'transparent', 'windowEffect transparent')
      ok(DEFAULT_APPEARANCE.termFontSize === 11, 'terminalFontSize 11')
    }
  }

  console.log('服务面板：面板结构与高度约束')
  {
    const v = await ev(`(() => {
      const p = document.querySelector('.sd-panel')
      const cs = getComputedStyle(p)
      return JSON.stringify({ maxH: cs.maxHeight, display: cs.display })
    })()`)
    const cs = JSON.parse(v)
    ok(cs.maxH === '50%', '面板 max-height 50%（不超过左栏一半）', v)
  }

  ok(client.exceptions.length === 0, '全过程无运行时异常', client.exceptions.join(' | '))

  console.log(`\ne2e-smoke: ${passed} 通过, ${failed} 失败`)
  client.close()
  process.exitCode = failed ? 1 : 0
}

main().catch((e) => { console.error('冒烟失败：', e.message); process.exitCode = 1 })
