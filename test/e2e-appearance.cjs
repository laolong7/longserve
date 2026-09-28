// ============================================================
// 外观系统 e2e：CDP 驱动打包版实例，验证色彩/透明度是否真实作用到主工作页
// 用法：node test/e2e-appearance.mjs [调试端口]
// 前置：以 --remote-debugging-port=<端口> 启动应用实例
// ============================================================
const PORT = Number(process.argv[2]) || 9333
const fs = require('fs')
const os = require('os')
const path = require('path')

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
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(msg.error.message))
        else res(msg.result)
      }
    }
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const id = ++seq
          pending.set(id, { resolve: res, reject: rej })
          ws.send(JSON.stringify({ id, method, params }))
        })
      },
      close() { ws.close() }
    })
    ws.onerror = (e) => reject(new Error('WS 连接失败'))
  })
}

const PROBE = `(() => {
  const g = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const cs = getComputedStyle(el)
    return { bg: cs.backgroundColor, color: cs.color, border: cs.borderTopColor }
  }
  const st = document.documentElement.style
  return JSON.stringify({
    vars: {
      bg0: st.getPropertyValue('--bg0').trim(),
      bg1: st.getPropertyValue('--bg1').trim(),
      green: st.getPropertyValue('--green').trim(),
      text: st.getPropertyValue('--text').trim()
    },
    leftCol: g('.left-col'),
    rightCol: g('.right-col'),
    tabsBar: g('.tabs-bar, .tab-bar, .term-tabs'),
    paneWrap: g('.pane-wrap'),
    emptyHint: g('.empty-hint'),
    body: g('body')
  })
})()`

const SET_APPEARANCE = (a) => `(() => {
  const app = document.querySelector('#app').__vue_app__
  const pinia = app.config.globalProperties.$pinia
  pinia.state.value.config.appearance = ${JSON.stringify(a)}
  return 'ok'
})()`

async function main() {
  const target = await getTarget()
  const cdp = await connect(target.webSocketDebuggerUrl)
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails))
    return r.result.value
  }
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const p = path.join(os.tmpdir(), `laogtool_${name}.png`)
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'))
    console.log('截图:', p)
    return p
  }

  console.log('=== 默认外观探针 ===')
  console.log(await ev(PROBE))
  await shot('a_default')

  console.log('=== 写入极端外观（色相0/透明30%/红强调）===')
  console.log(await ev(SET_APPEARANCE({ accent: '#ff0000', text: '#00ff00', bgHue: 0, bgAlpha: 30, termFontSize: 18 })))
  await new Promise((r) => setTimeout(r, 300))
  console.log(await ev(PROBE))
  await shot('b_extreme')

  console.log('=== 再写默认（对比还原力）===')
  console.log(await ev(SET_APPEARANCE({ accent: '#3fdc97', text: '#d8dce4', bgHue: 222, bgAlpha: 100, termFontSize: 14 })))
  await new Promise((r) => setTimeout(r, 300))
  console.log(await ev(PROBE))
  await shot('c_back')

  cdp.close()
  console.log('DONE')
  process.exit(0)
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
