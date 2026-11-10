import assert from 'node:assert/strict'

/** Desktop keeps only what you work with; the start menu searches apps, files and plugins by name. */
export async function checkStartSearch(browser, bundleText) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const openMenu = async () => {
    if (!(await page.locator('.world-start').evaluate(node => node.classList.contains('open')))) await page.locator('.world-start-button').click()
    await page.waitForFunction(() => document.querySelector('.world-start')?.classList.contains('open'))
  }
  const results = () => page.locator('[data-world-search-result]').evaluateAll(nodes => nodes.map(node => node.dataset.worldSearchResult))
  try {
    await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.route('http://127.0.0.1/world-search-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
    await page.goto('http://127.0.0.1/world-search-fixture')
    await page.addScriptTag({ content: bundleText })
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')

    // 设置 / 日记 / 待办只在开始菜单里，桌面上不摆这三个图标。
    for (const id of ['settings', 'plugin:world-diary', 'plugin:world-tasks']) {
      assert.equal(await page.locator(`[data-world-icon-id="${id}"]`).count(), 0, `${id} stays off the desktop`)
    }
    assert.equal(await page.locator('[data-world-icon-id="dsh"]').count(), 1, 'the apps you work with stay on the desktop')
    assert.equal(await page.locator('[data-world-app-card="world-diary"]').count(), 1, 'the diary card is still in the start menu')
    assert.equal(await page.locator('[data-world-app-card="world-tasks"]').count(), 1)
    assert.equal(await page.locator('[data-world-icon-id="plugin:world-trash"]').count(), 1, 'the bin stays on the desktop')

    await openMenu()
    const search = page.locator('[data-world-start-search]')
    await search.waitFor()
    assert.match(await page.locator('.world-start-group-title').first().innerText(), /^应用/, 'nothing is searched until you type')
    assert.equal(await search.evaluate(node => node === document.activeElement), true, 'opening the menu puts the caret in the search field')

    // 名字匹配：日记只剩一张卡片，标题换成搜索结果。
    await search.fill('日记')
    await page.waitForFunction(() => document.querySelectorAll('[data-world-search-result]').length > 0)
    // 日记与垃圾箱的说明里都有「日记」：匹配的是名字与说明，不只是标题。
    assert.deepEqual(await results(), ['plugin:world-diary', 'plugin:world-trash'])
    assert.match(await page.locator('.world-start-group-title').first().innerText(), /^搜索结果/)
    await search.fill('垃圾箱')
    await page.waitForFunction(() => document.querySelectorAll('[data-world-search-result]').length === 1)
    assert.deepEqual(await results(), ['plugin:world-trash'])
    await search.fill('日记')
    await page.waitForFunction(() => document.querySelectorAll('[data-world-search-result]').length > 0)

    // 大小写、前后空格、内部 id 都参与匹配。
    await search.fill('  DSH ')
    await page.waitForFunction(() => document.querySelectorAll('[data-world-search-result]').length > 0)
    assert.ok((await results()).includes('dsh'), 'a query is trimmed, case-folded and matched against the entry id')

    // 匹配不到时给一句人话，而不是空白。
    await search.fill('不存在的应用')
    await page.waitForFunction(() => document.querySelector('.world-start-empty')?.textContent.includes('没有找到'))

    // Escape 先清空输入，再按一次才关菜单。
    await page.keyboard.press('Escape')
    assert.equal(await search.inputValue(), '')
    assert.equal(await page.locator('.world-start').evaluate(node => node.classList.contains('open')), true, 'the first Escape only clears the query')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.world-start').classList.contains('open'))

    // Enter 打开高亮的那一条，菜单收起。
    await openMenu()
    assert.equal(await search.inputValue(), '', 'reopening starts with an empty query')
    await search.fill('日记')
    await page.waitForFunction(() => document.querySelectorAll('[data-world-search-result]').length > 0)
    await page.keyboard.press('Enter')
    await page.locator('[data-world-plugin="world-diary"]').waitFor()
    await page.waitForFunction(() => !document.querySelector('.world-start').classList.contains('open'))
    await page.locator('.world-plugin-window [aria-label="关闭"]').click()

    // 键盘上下移动高亮，不会越界。
    await openMenu()
    await search.fill('应用')
    await page.waitForFunction(() => document.querySelectorAll('[data-world-search-result]').length > 1)
    const first = await page.locator('[data-world-search-result].on').getAttribute('data-world-search-result')
    await page.keyboard.press('ArrowDown')
    const second = await page.locator('[data-world-search-result].on').getAttribute('data-world-search-result')
    assert.notEqual(first, second, 'ArrowDown moves the highlight')
    for (let index = 0; index < 4; index += 1) await page.keyboard.press('ArrowUp')
    const top = await page.locator('[data-world-search-result].on').getAttribute('data-world-search-result')
    assert.equal(top, first, 'ArrowUp stops at the first result')

    // 插件页搬不进虚拟窗口（它自己声明了 9 个子槽位），按「设置」的模式：立起 DSH 窗口再切面板。
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.world-start').classList.contains('open'))
    await page.locator('.world-start-button').click()
    await page.locator('[data-world-app-card="plugins"] button[data-world-host-panel]').waitFor()
    await page.locator('[data-world-app-card="plugins"] button[data-world-host-panel]').click()
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'normal')
    assert.deepEqual(await page.evaluate(() => window.__worldTesting.layoutCalls), ['plugins'], 'the host panel is selected inside the DSH window')
    assert.equal(await page.locator('.world-start').evaluate(node => node.classList.contains('open')), false, 'choosing it closes the menu')
    assert.equal(await page.locator('[data-world-icon-id="plugins"]').count(), 0, 'it never becomes a desktop icon')

    assert.deepEqual(errors, [])
    console.log('Start menu search passed: hidden desktop icons, name/id matching, empty result, Escape layering, Enter and arrow keys, host-panel entry for the plugin manager.')
  } finally {
    await page.close()
  }
}
