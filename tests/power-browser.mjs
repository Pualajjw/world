import assert from 'node:assert/strict'

/**
 * 开始菜单右下角的电源：先探活（桌面版才给点），再确认，再让宿主去关机 / 重启。
 * 这里不打桩「真的关掉自己」，只断言按钮、菜单、确认与 RPC 的顺序。
 */
export async function checkPowerMenu(browser, bundleText) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const calls = []
  try {
    await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.exposeBinding('__worldPowerCall', (_source, operation) => {
      calls.push(operation)
      if (operation === 'probe') return { supported: true, appPid: 4242, exe: 'C:\\Apps\\DeepSeek Harness.exe', name: 'DeepSeek Harness.exe' }
      return { action: operation, appPid: 4242 }
    })
    // 确认框已经换成世界内的卡片；万一又冒出原生框，这里记下来并在结尾断言它没出现。
    const nativeDialogs = []
    page.on('dialog', dialog => { nativeDialogs.push(dialog.message()); void dialog.accept() })
    await page.route('http://127.0.0.1/world-power-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
    await page.goto('http://127.0.0.1/world-power-fixture')
    await page.addScriptTag({ content: bundleText })
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')

    await page.locator('.world-start-button').click()
    await page.waitForFunction(() => document.querySelector('.world-start')?.classList.contains('open'))
    const power = page.locator('[data-world-power]')
    assert.equal(await power.count(), 1, '页脚右侧有一颗电源')

    await power.click()
    await page.waitForFunction(() => document.querySelector('[data-world-power-menu]') !== null)
    assert.deepEqual(calls, ['probe'], '展开菜单前先问宿主支不支持')
    assert.deepEqual(
      await page.locator('[data-world-power-menu] button').evaluateAll(nodes => nodes.map(node => node.textContent)),
      ['关机', '重启'])
    // 菜单位于电源上方，且不越出视口。
    const box = await page.locator('[data-world-power-menu]').boundingBox()
    const button = await power.boundingBox()
    assert.ok(box.y < button.y, '菜单在按钮上方展开')
    assert.ok(box.x >= 0 && box.x + box.width <= 1280, '菜单不出视口')

    // 关机前先在世界内的确认框里点「关机」——原生 window.confirm 已经在 0.2.96 换掉了。
    await page.locator('[data-world-power-menu] [data-role="shutdown"]').click()
    await page.waitForFunction(() => document.querySelector('[data-world-confirm]') !== null)
    const confirmCard = page.locator('[data-world-confirm-card]')
    assert.equal(await confirmCard.locator('.world-confirm-title').textContent(), '关机 DSH 主程序')
    assert.match(await confirmCard.locator('.world-confirm-message').textContent(), /正在进行的回合会被中断/)
    assert.deepEqual(calls, ['probe'], '确认之前不发指令')
    await page.locator('[data-world-confirm] [data-role="confirm"]').click()
    await page.waitForFunction(() => document.querySelector('[data-world-confirm]') === null)
    await page.waitForFunction(() => document.querySelector('[data-world-power-menu]') === null)
    await page.waitForFunction(() => document.querySelector('.world-toast')?.textContent.includes('正在关机'))
    assert.deepEqual(calls, ['probe', 'shutdown'], '确认之后才发指令')
    assert.equal(await page.locator('.world-start').evaluate(node => node.classList.contains('open')), false, '按完就把开始菜单收起')

    // 搜索框里也能直接找到这两项（手机页面没有）。
    await page.locator('.world-start-button').click()
    await page.locator('[data-world-start-search]').fill('关机')
    await page.waitForFunction(() => document.querySelectorAll('[data-world-search-result]').length > 0)
    assert.deepEqual(await page.locator('[data-world-search-result]')
      .evaluateAll(nodes => nodes.map(node => node.dataset.worldSearchResult)), ['power:shutdown'])
    assert.deepEqual(nativeDialogs, [], '不再弹原生 confirm')
    assert.deepEqual(errors, [])
  } finally { await page.close() }

  // 手机页面（world 的手机入口）不给关机：按下去会把连着手机的服务一起关掉。
  const phone = await browser.newPage({ viewport: { width: 420, height: 860 } })
  try {
    await phone.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
    await phone.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await phone.route('http://127.0.0.1/world-power-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
    await phone.goto('http://127.0.0.1/world-power-fixture')
    await phone.addScriptTag({ content: bundleText })
    await phone.waitForFunction(() => document.body.dataset.worldWindow === 'closed')
    assert.equal(await phone.locator('[data-world-power]').count(), 0, '手机布局里没有电源')
  } finally { await phone.close() }
}
