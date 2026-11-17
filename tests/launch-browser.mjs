import assert from 'node:assert/strict'

/** 双击快捷方式后：world 打开指定应用、铺满 DSH 视图，F11 退出沉浸。 */
export async function checkLaunchImmersive(browser, bundleText) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let pending = { app: 'vscode', arg: '/workspace', argKind: 'folder', nonce: 'launch-1', immersive: true }
  try {
    await page.addInitScript(() => {
      localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode', 'browser', 'terminal']))
    })
    await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.exposeBinding('__worldLaunchPoll', () => {
      const value = pending
      pending = null
      return value
    })
    await page.route('http://127.0.0.1/world-launch-fixture', route => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html style="--dsh-windows-titlebar-height:40px" data-platform="win32"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}.app-frame::before{content:"";position:absolute;inset:0 0 auto;height:40px;-webkit-app-region:drag}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div data-windows-menu style="position:fixed;top:0;left:48px;height:40px">应用 编辑</div><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>',
    }))
    await page.goto('http://127.0.0.1/world-launch-fixture')
    await page.addScriptTag({ content: bundleText })
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')

    await page.waitForFunction(() => document.body.dataset.worldImmersive === 'true')
    const window = page.locator('.world-vscode-window.is-max')
    await window.waitFor()
    assert.equal(await page.locator('.world-taskbar').isVisible(), false, '沉浸模式隐藏 world 任务栏')
    const titlebar = window.locator('.world-vscode-titlebar')
    await page.waitForFunction(() => {
      const node = document.querySelector('.world-vscode-window.is-max .world-vscode-titlebar')
      return node && Number.parseFloat(getComputedStyle(node).opacity) < 0.05
    })
    assert.ok(Number.parseFloat(await titlebar.evaluate(node => getComputedStyle(node).opacity)) < 0.05,
      '沉浸时标题栏收起，只留顶部热区')
    assert.equal(await page.locator('[data-windows-menu]').isVisible(), false, '沉浸模式收起 DSH 的应用/编辑菜单，避免压住应用')
    assert.equal(await page.locator('[data-world-immersive-exit]').count(), 0, '不再显示退出全屏按钮')
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#root div:has(> [data-shell-overlay])'), '::before').display), 'none',
      '沉浸模式收起 DSH 的 40px 窗口拖动带，左上角点击不被吞')
    const box = await window.boundingBox()
    assert.ok(box && box.width >= 1270 && box.height >= 790, '应用窗口铺满 DSH 视图')
    assert.equal(await page.evaluate(() => window.__worldTesting.calls.some(call => call.method === 'world-launch/poll')), true)

    const chat = page.locator('[data-world-vscode-chat]')
    assert.equal(await chat.isVisible(), true, '沉浸模式仍保留 VSCode 对话入口')
    await chat.click()
    await page.locator('.world-vscode-chat').waitFor()

    await titlebar.hover()
    await page.waitForFunction(() => {
      const node = document.querySelector('.world-vscode-window.is-max .world-vscode-titlebar')
      return node && getComputedStyle(node).opacity === '1' && node.getBoundingClientRect().height >= 30
    })
    assert.equal(await titlebar.isVisible(), true, '鼠标移到顶部会展开可拖动的标题栏')
    assert.equal(await titlebar.evaluate(node => getComputedStyle(node).getPropertyValue('-webkit-app-region')), 'drag',
      '标题栏交给 Electron 原生拖动，拖的是整个 DSH 窗口')

    await page.keyboard.press('F11')
    await page.waitForFunction(() => !document.body.dataset.worldImmersive)
    assert.equal(await page.locator('.world-taskbar').isVisible(), true, 'F11 恢复 world 任务栏')
    assert.equal(await page.locator('.world-vscode-window .world-vscode-titlebar').isVisible(), true, 'F11 恢复应用标题栏')
    assert.equal(await page.locator('[data-windows-menu]').isVisible(), true, 'F11 恢复 DSH 的应用/编辑菜单')
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector('#root div:has(> [data-shell-overlay])'), '::before').display), 'none',
      'F11 恢复 DSH 的窗口拖动带')
    await page.waitForFunction(() => !document.querySelector('.world-vscode-window')?.classList.contains('is-max'))
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
}
