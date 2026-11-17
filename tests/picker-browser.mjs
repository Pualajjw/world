import assert from 'node:assert/strict'

/** 「打开文件夹」历史/插件位置很多时，底部操作栏不能被挤出卡片。 */
export async function checkPickerOverflow(browser, bundleText) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const projects = Array.from({ length: 24 }, (_, index) => ({
    id: `pbnpm-pbd:E:/pb/project-${index}.pbt`,
    plugin: 'pbnpm-pbd', kind: 'pbt', name: `project-${index}.pbt`,
    root: `E:/pb/project-${index}.workspace`, pbtPath: `E:/pb/project-${index}.pbt`,
    pbVersion: 90, libraries: 1,
  }))
  const folders = Array.from({ length: 8 }, (_, index) => `/workspace/history-${index}`)
  try {
    await page.addInitScript(value => {
      localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode', 'browser', 'terminal']))
      localStorage.setItem('dsh.world.vscode.folders', JSON.stringify(value))
    }, folders)
    await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.exposeBinding('__worldRootsCall', () => ({
      ima: { available: false, path: '', label: 'IMA', error: '' },
      projects, tools: [], truncated: false,
    }))
    await page.exposeBinding('__worldWorkspaceList', (_source, payload) => ({
      ok: true, value: { path: String(payload?.path || ''), parent: '', entries: [], truncated: false },
    }))
    await page.route('http://127.0.0.1/world-picker-fixture', route => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html style="--dsh-windows-titlebar-height:40px" data-platform="win32"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>',
    }))
    await page.goto('http://127.0.0.1/world-picker-fixture')
    await page.addScriptTag({ content: bundleText })
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')

    await page.locator('.world-start-button').click()
    const card = page.locator('[data-world-app-card="vscode"]')
    await card.waitFor()
    const install = card.locator('.world-app-install')
    if (await install.count()) await install.first().click()
    await card.locator('.world-app-open').first().click()
    await page.locator('.world-vscode-window').waitFor()

    await page.locator('.world-vscode-title-btn[aria-label="打开文件夹"]').click()
    const picker = page.locator('.world-vscode-picker')
    await picker.waitFor()
    await picker.locator('.world-vscode-picker-root').first().waitFor()
    assert.ok(await picker.locator('.world-vscode-picker-root').count() >= 20)
    const body = picker.locator('.world-vscode-picker-body')
    const overflow = await body.evaluate(node => ({ scroll: node.scrollHeight, client: node.clientHeight }))
    assert.ok(overflow.scroll > overflow.client, '内容和历史记录应该在中间区域滚动')

    const cardBox = await picker.locator('.world-vscode-picker-card').boundingBox()
    const footBox = await picker.locator('.world-vscode-picker-foot').boundingBox()
    assert.ok(cardBox && footBox, '底部操作栏必须仍在布局里')
    assert.ok(footBox.y + footBox.height <= cardBox.y + cardBox.height + 1, '底部操作栏不能被挤出卡片')
    assert.equal(await picker.getByRole('button', { name: '取消' }).isVisible(), true)
    await picker.getByRole('button', { name: '取消' }).click()
    await page.waitForFunction(() => !document.querySelector('.world-vscode-picker'))
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
}
