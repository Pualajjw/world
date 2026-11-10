import assert from 'node:assert/strict'

/** Dragging desktop icons: free placement, per-mode persistence, reset actions and click safety. */
export async function checkIconDrag(browser, bundleText) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const open = async () => {
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')
  }
  try {
    await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.route('http://127.0.0.1/world-icons-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
    await page.goto('http://127.0.0.1/world-icons-fixture')
    await page.addScriptTag({ content: bundleText })
    await open()
    // 设置 / 日记 / 待办只在开始菜单里（0.2.73 起），拖拽用桌面上的 DSH 图标验证。
    const icon = page.locator('[data-world-icon-id="dsh"]')
    const before = await icon.boundingBox()
    const beforeScale = await icon.evaluate(node => Number((/scale\(([\d.]+)\)/.exec(node.style.transform) || [])[1] || 0))

    // Depth on: drag toward the viewer → the icon grows and its feet follow the pointer.
    await page.mouse.move(before.x + 20, before.y + 20)
    await page.mouse.down()
    await page.mouse.move(before.x + 220, before.y + 140, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(120)
    const after = await icon.boundingBox()
    const afterScale = await icon.evaluate(node => Number((/scale\(([\d.]+)\)/.exec(node.style.transform) || [])[1] || 0))
    assert.ok(after.x > before.x + 80, 'the icon must follow the drag horizontally')
    assert.ok(afterScale > beforeScale + .01, 'dragging nearer must scale the icon up')
    assert.equal(await page.locator('.world-window-frame').evaluate(node => node.classList.contains('is-closed')), true, 'a drag must not open the app')
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.world.iconPositions') || '{}').depth?.['dsh'])
    assert.ok(saved && Number.isFinite(saved.x) && Number.isFinite(saved.y))

    // Reload: the saved floor position is restored.
    await page.reload()
    await page.addScriptTag({ content: bundleText })
    await open()
    const restored = await icon.boundingBox()
    assert.ok(Math.abs(restored.x - after.x) < 2 && Math.abs(restored.y - after.y) < 2, 'saved icon position must survive a reload')

    // Right-click reset for one icon returns it to the automatic grid.
    await icon.click({ button: 'right' })
    await page.locator('.world-context-menu').getByRole('button', { name: '还原位置', exact: true }).click()
    await page.waitForTimeout(120)
    const reset = await icon.boundingBox()
    assert.ok(Math.abs(reset.x - before.x) < 2 && Math.abs(reset.y - before.y) < 2, '还原位置 restores the automatic slot')
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.world.iconPositions') || '{}').depth?.['dsh']), undefined)

    // Drag another icon, then clear every saved position from its menu.
    const trash = page.locator('[data-world-icon-id="plugin:world-trash"]')
    const trashBefore = await trash.boundingBox()
    await page.mouse.move(trashBefore.x + 20, trashBefore.y + 20)
    await page.mouse.down()
    await page.mouse.move(trashBefore.x + 240, trashBefore.y + 60, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(120)
    await trash.click({ button: 'right' })
    await page.locator('.world-context-menu').getByRole('button', { name: '重排全部图标', exact: true }).click()
    await page.waitForTimeout(120)
    const trashReset = await trash.boundingBox()
    assert.ok(Math.abs(trashReset.x - trashBefore.x) < 2 && Math.abs(trashReset.y - trashBefore.y) < 2)
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.world.iconPositions') || '{}')), { flat: {}, depth: {} })

    // Flat desktop: drag stays in the container, is stored separately and survives reload.
    await page.locator('.world-depth-toggle').click()
    await page.waitForFunction(() => document.body.dataset.worldDepth === 'off')
    await page.waitForTimeout(60)
    const flatBefore = await icon.boundingBox()
    await page.mouse.move(flatBefore.x + 20, flatBefore.y + 20)
    await page.mouse.down()
    await page.mouse.move(flatBefore.x + 180, flatBefore.y + 60, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(120)
    const flatStored = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.world.iconPositions') || '{}').flat?.['dsh'])
    assert.ok(flatStored && Number.isFinite(flatStored.x) && Number.isFinite(flatStored.y))
    await page.reload()
    await page.addScriptTag({ content: bundleText })
    await open()
    const flatRestored = await icon.boundingBox()
    assert.ok(flatRestored.x > flatBefore.x + 80, 'flat icon position must survive a reload')

    // Double-click still opens the app after a reset.
    await icon.click({ button: 'right' })
    await page.locator('.world-context-menu').getByRole('button', { name: '还原位置', exact: true }).click()
    await icon.dblclick()
    await page.waitForFunction(() => document.body.dataset.worldWindow !== 'closed')
    assert.deepEqual(errors, [])
    console.log('Icon drag passed: depth scaling, per-mode persistence, single reset, reset-all and unchanged double-click.')
  } finally {
    await page.close()
  }
}
