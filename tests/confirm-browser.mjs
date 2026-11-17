import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 世界内确认框（替代 window.confirm）：几何、主题、键盘、焦点回收、排队与手机布局。
 * 只在 0.2.96 之后存在——原生框顶部会写「localhost 说…」，这里要确保它一次都不出现。
 */
const HTML = '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>'
  + ':root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#f7f9fd;--dsw-alias-bg-layer-2:#f1f3f5;--dsw-alias-label-primary:#17233c;--dsw-alias-label-secondary:#646e82;--dsw-alias-border-l2:#e1e6ee}'
  + 'body{margin:0}#root{width:100vw;height:100vh}.app-frame{position:relative;height:100%;padding-top:40px;box-sizing:border-box}'
  + '#host-ui{position:absolute;inset:40px 0 0;background:#262626}[data-shell-overlay]{pointer-events:none}[data-shell-overlay]>*{pointer-events:auto}'
  + '</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>'

export async function checkConfirmDialog(browser, bundleText, shotsDirectory) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  const nativeDialogs = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('dialog', dialog => { nativeDialogs.push(dialog.message()); void dialog.accept() })
  const shot = async name => {
    if (!shotsDirectory) return
    await mkdir(shotsDirectory, { recursive: true })
    await page.screenshot({ path: join(shotsDirectory, `${name}.png`) })
  }
  // 打开一条确认框并立刻返回（等 Promise 会让 evaluate 卡死）。
  const open = options => page.evaluate(value => {
    window.__answer = 'pending'
    void window.__worldTesting.confirm(value).then(answer => { window.__answer = answer })
  }, options)
  const answer = () => page.waitForFunction(() => window.__answer !== 'pending').then(() => page.evaluate(() => window.__answer))
  const card = () => page.locator('[data-world-confirm-card]')
  const geometry = () => page.evaluate(() => {
    const node = document.querySelector('[data-world-confirm-card]')
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    const title = node.querySelector('.world-confirm-title')
    const buttons = [...node.querySelectorAll('button')].map(button => {
      const rect = button.getBoundingClientRect()
      const computed = getComputedStyle(button)
      return {
        role: button.dataset.role, width: Math.round(rect.width), height: Math.round(rect.height),
        background: computed.backgroundColor, color: computed.color,
      }
    })
    return {
      width: Math.round(box.width), height: Math.round(box.height),
      x: Math.round(box.x), y: Math.round(box.y),
      centerX: Math.round(box.x + box.width / 2), centerY: Math.round(box.y + box.height / 2),
      padding: style.padding, radius: style.borderRadius,
      titleSize: getComputedStyle(title).fontSize, titleWeight: getComputedStyle(title).fontWeight,
      role: node.getAttribute('role'), modal: node.getAttribute('aria-modal'),
      buttons,
    }
  })

  try {
    await page.route('http://127.0.0.1/world-confirm-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML }))
    await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.goto('http://127.0.0.1/world-confirm-fixture')
    await page.addScriptTag({ content: bundleText })
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')
    assert.equal(await page.locator('[data-world-confirm]').count(), 0, '平时没有确认框')

    // ── 危险动作：红色主按钮、初始焦点在「取消」 ──────────────────────────
    await open({ title: '从桌面移除', message: '移走「docs」的桌面图标？', detail: '只移除桌面记录，磁盘上的文件不会删除。',
      confirmLabel: '移除', danger: true })
    await card().waitFor()
    const danger = await geometry()
    assert.equal(danger.width, 360, '卡片宽 360')
    assert.equal(danger.padding, '24px')
    assert.equal(danger.radius, '8px')
    assert.equal(danger.titleSize, '20px', '标题 20px')
    assert.equal(danger.titleWeight, '600')
    assert.equal(danger.role, 'alertdialog')
    assert.equal(danger.modal, 'true')
    assert.equal(danger.centerX, 640, '水平居中')
    // 桌面区 = 顶部标题栏 40 + 任务栏 48，卡片要落在中间而不是整屏中间。
    assert.ok(Math.abs(danger.centerY - (40 + (800 - 40 - 48) / 2)) <= 1, `垂直居中于桌面区（实际 ${danger.centerY}）`)
    assert.deepEqual(danger.buttons.map(button => [button.role, button.height]), [['cancel', 32], ['confirm', 32]])
    assert.equal(danger.buttons[1].background, 'rgb(196, 43, 28)', '危险动作主按钮是关窗口那颗红')
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.role), 'cancel', '危险动作默认停在取消上')
    assert.equal(await page.locator('.world-confirm-detail').textContent(), '只移除桌面记录，磁盘上的文件不会删除。')
    await shot('confirm-danger-desktop')

    // Tab 在两个按钮之间循环，不会跑到桌面上去。
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.role), 'confirm')
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.role), 'cancel', 'Tab 回到取消')
    await page.keyboard.press('Shift+Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.role), 'confirm', 'Shift+Tab 反向循环')

    // Esc = 取消，并把焦点还给打开前的元素。
    await page.keyboard.press('Escape')
    assert.equal(await answer(), false, 'Esc 返回 false')
    await page.waitForFunction(() => document.querySelector('[data-world-confirm]') === null)
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true, '焦点回到原处')

    // ── 普通确认：焦点在「确定」，回车直接答应 ────────────────────────────
    await open({ title: '关闭标签', message: '「notes.txt」还有未保存的修改，关闭后就没了。', confirmLabel: '仍然关闭' })
    await card().waitFor()
    const plain = await geometry()
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.role), 'confirm', '普通确认默认停在确定上')
    assert.notEqual(plain.buttons[1].background, 'rgb(196, 43, 28)', '非危险动作不用红色')
    await page.keyboard.press('Enter')
    assert.equal(await answer(), true, '回车返回 true')
    await page.waitForFunction(() => document.querySelector('[data-world-confirm]') === null)

    // ── 点遮罩 = 取消；点卡片本身不关 ────────────────────────────────────
    await open({ title: '解散收纳盒', message: '里面的 3 个项目会回到桌面。', danger: true })
    await card().waitFor()
    await card().click({ position: { x: 8, y: 8 } })
    assert.equal(await page.locator('[data-world-confirm]').count(), 1, '点卡片不关')
    await page.mouse.click(60, 120)
    assert.equal(await answer(), false, '点遮罩返回 false')

    // ── 同时来两条：排队，一次只显示一条 ─────────────────────────────────
    await page.evaluate(() => {
      window.__order = []
      void window.__worldTesting.confirm({ title: '第一条', message: '1' }).then(value => window.__order.push(`a:${value}`))
      void window.__worldTesting.confirm({ title: '第二条', message: '2' }).then(value => window.__order.push(`b:${value}`))
    })
    await card().waitFor()
    assert.equal(await page.locator('.world-confirm-title').textContent(), '第一条')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('.world-confirm-title')?.textContent === '第二条')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('[data-world-confirm]') === null)
    assert.deepEqual(await page.evaluate(() => window.__order), ['a:true', 'b:false'], '按顺序结算')

    // ── 手机：360px 宽时铺满留 12px 边，按钮放大到 40px 好点 ──────────────
    await page.setViewportSize({ width: 360, height: 640 })
    await page.waitForFunction(() => document.body.dataset.worldLayout === 'phone')
    await open({ title: '删除对话', message: '这条对话和它的记忆会一起消失。', confirmLabel: '删除', danger: true })
    await card().waitFor()
    const phone = await geometry()
    assert.equal(phone.width, 336, '360 - 2×12')
    assert.equal(phone.x, 12)
    assert.deepEqual(phone.buttons.map(button => button.height), [40, 40], '手机按钮 40px')
    assert.equal(await page.evaluate(() => {
      const box = document.querySelector('[data-world-confirm-card]').getBoundingClientRect()
      const bar = getComputedStyle(document.documentElement).getPropertyValue('--world-taskbar-height').trim()
      return box.y + box.height <= window.innerHeight - parseInt(bar, 10)
    }), true, '不压到任务栏')
    await shot('confirm-phone')
    await page.keyboard.press('Escape')
    assert.equal(await answer(), false)

    // ── 深色主题：卡片跟窗口用同一套 layer-1，字跟着反色 ──────────────────
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.evaluate(() => {
      const root = document.documentElement
      root.setAttribute('data-ds-dark-theme', '')
      root.style.setProperty('--dsw-alias-bg-base', '#151517')
      root.style.setProperty('--dsw-alias-bg-layer-1', '#1e2024')
      root.style.setProperty('--dsw-alias-label-primary', '#f9fafb')
      root.style.setProperty('--dsw-alias-border-l2', '#414650')
    })
    await page.waitForFunction(() => document.body.dataset.worldTheme === 'dark')
    await open({ title: '关闭终端', message: '还有命令在跑，关闭会中断它。', confirmLabel: '仍然关闭', danger: true })
    await card().waitFor()
    const dark = await page.evaluate(() => {
      const node = document.querySelector('[data-world-confirm-card]')
      return { background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node.querySelector('.world-confirm-title')).color }
    })
    assert.equal(dark.background, 'rgb(30, 32, 36)', '深色主题用 layer-1')
    assert.equal(dark.color, 'rgb(249, 250, 251)', '标题跟着反色')
    await shot('confirm-dark-desktop')
    await page.keyboard.press('Escape')
    assert.equal(await answer(), false)

    assert.deepEqual(nativeDialogs, [], '一次原生 confirm 都不该出现')
    assert.deepEqual(errors, [])
    console.log(`Confirm dialog passed: ${JSON.stringify({ desktop: [danger.width, danger.height, danger.centerX, danger.centerY], phone: [phone.width, phone.buttons[0].height] })}; geometry, danger colour, focus, Tab loop, Esc/Enter, overlay dismiss, queueing, phone layout.`)
  } finally {
    await page.close()
  }
}
