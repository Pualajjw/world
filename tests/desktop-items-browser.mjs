import assert from 'node:assert/strict'

const FIXTURE_HTML = '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>'

/** Desktop file links, holder merge/rename/remove and the VSCode collection tree. */
export async function checkDesktopItems(browser, bundleText) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = [], dialogs = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.accept() })
  const open = async () => page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')
  const dropFiles = async (names, dropX = 900, dropY = 600) => {
    await page.evaluate(({ names, dropX, dropY }) => {
      const dt = new DataTransfer()
      for (const name of names) dt.items.add(new File([name.endsWith('.txt') ? 'hello from disk' : ''], name, { type: 'text/plain' }))
      const portal = document.querySelector('[data-world-portal="dsh-world"]')
      for (const type of ['dragenter', 'dragover', 'drop'])
        portal.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: dropX, clientY: dropY }))
    }, { names, dropX, dropY })
  }
  const dragIcon = async (source, target) => {
    const from = await source.boundingBox(), to = await target.boundingBox()
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(160)
  }
  try {
    await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.route('http://127.0.0.1/world-items-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: FIXTURE_HTML }))
    await page.goto('http://127.0.0.1/world-items-fixture')
    await page.evaluate(() => {
      localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode', 'browser']))
      localStorage.setItem('dsh.world.browser.migrated', '1')
      window.__DSH_HOST_PATHS__ = { pathFor: file => ({ 'notes.txt': 'C:/fixtures/notes.txt', 'docs': 'C:/fixtures/docs' })[file.name] || '' }
    })
    await page.reload()
    await page.addScriptTag({ content: bundleText })
    await open()
    await page.evaluate(() => {
      window.__DSH_HOST_PATHS__ = { pathFor: file => ({ 'notes.txt': 'C:/fixtures/notes.txt', 'docs': 'C:/fixtures/docs' })[file.name] || '' }
    })

    await dropFiles(['notes.txt', 'docs'])
    await page.waitForFunction(() => document.querySelectorAll('[data-world-icon-kind="file"], [data-world-icon-kind="directory"]').length === 2)
    const links = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.world.fileLinks') || '[]'))
    assert.deepEqual(links.map(link => [link.path, link.type]), [['C:/fixtures/notes.txt', 'file'], ['C:/fixtures/docs', 'directory']])
    const notesIcon = page.locator('.world-desktop-icon').filter({ hasText: 'notes.txt' })
    const docsIcon = page.locator('.world-desktop-icon').filter({ hasText: 'docs' })

    // Double-click a file link opens the built-in VSCode at its parent folder.
    await notesIcon.dblclick()
    const editor = page.locator('.world-vscode-window')
    await editor.waitFor()
    await editor.locator('.world-vscode-tab').filter({ hasText: 'notes.txt' }).waitFor()
    const opened = await page.evaluate(() => [...window.__worldTesting.calls].reverse().find(call => call.method === 'world-vscode-source/open')?.payload)
    assert.equal(opened.root, 'C:/fixtures')
    assert.equal(opened.path, 'C:/fixtures/notes.txt')
    await editor.getByRole('button', { name: '关闭 Visual Studio Code' }).click()

    // Deleting a shortcut only removes the desktop record.
    await docsIcon.click({ button: 'right' })
    await page.locator('.world-context-menu').getByRole('button', { name: '删除快捷方式', exact: true }).click()
    await page.waitForFunction(() => ![...document.querySelectorAll('.world-icon-label')].some(el => el.textContent === 'docs'))
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.world.fileLinks') || '[]').length), 1)
    assert.match(dialogs.at(-1), /不会删除磁盘上的文件/)

    await dropFiles(['docs'], 700, 470)
    await page.waitForFunction(() => document.querySelectorAll('[data-world-icon-kind="directory"]').length === 1)

    // Merge two icons into a holder and rename it.
    await dragIcon(notesIcon, docsIcon)
    const holder = page.locator('[data-world-icon-kind="holder"]')
    await holder.waitFor()
    assert.equal(await notesIcon.count(), 0)
    assert.equal(await docsIcon.count(), 0)
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.world.holders') || '[]')[0].items.length), 2)
    await holder.click({ button: 'right' })
    await page.locator('.world-context-menu').getByRole('button', { name: '重命名', exact: true }).click()
    const renameInput = page.getByLabel('收纳盒名称')
    await renameInput.fill('资料')
    await page.getByRole('dialog', { name: '重命名收纳盒' }).getByRole('button', { name: '保存', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-world-icon-kind="holder"] .world-icon-label')?.textContent === '资料')
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.world.holders') || '[]')[0].name), '资料')

    // Dragging a third icon onto the existing holder adds it instead of creating another holder.
    // 待办只在开始菜单里（0.2.73 起），这里用桌面上还在的垃圾箱图标。
    const taskIcon = page.locator('[data-world-icon-id="plugin:world-trash"]')
    await dragIcon(taskIcon, holder)
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('dsh.world.holders') || '[]')[0]?.items.length === 3)
    assert.equal(await page.locator('[data-world-icon-id="plugin:world-trash"]').count(), 0)
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.world.holders') || '[]').length), 1)

    await page.waitForTimeout(380)
    await holder.dblclick()
    const holderWindow = page.locator('.world-holder')
    await holderWindow.waitFor()
    assert.equal(await holderWindow.locator('.world-holder-item').count(), 3)
    await page.locator('.world-plugin-window [aria-label="关闭"]').click()

    // Right-click holder → open its files in the VSCode tree.
    await holder.click({ button: 'right' })
    await page.locator('.world-context-menu').getByRole('button', { name: '在 VSCode 中作为文件夹打开', exact: true }).click()
    const collection = page.locator('.world-vscode-window')
    await collection.waitFor()
    await collection.locator('.world-vscode-root-name').filter({ hasText: '资料' }).waitFor()
    await collection.locator('.world-vscode-file').filter({ hasText: 'notes.txt' }).waitFor()
    await collection.locator('.world-vscode-file').filter({ hasText: 'docs' }).click()
    await collection.locator('.world-vscode-file').filter({ hasText: 'README.md' }).waitFor()
    await collection.locator('.world-vscode-file').filter({ hasText: 'README.md' }).click()
    const readme = collection.getByLabel('编辑 README.md')
    await readme.waitFor()
    await readme.fill('# edited through the holder')
    await page.keyboard.press('Control+s')
    await page.waitForFunction(() => window.__worldTesting.files()['C:/fixtures/docs/README.md'] === '# edited through the holder')
    const collectionOpen = await page.evaluate(() => [...window.__worldTesting.calls].reverse().find(call => call.method === 'world-vscode-source/open')?.payload)
    assert.equal(collectionOpen.root, 'C:/fixtures/docs')
    assert.equal(collectionOpen.path, 'C:/fixtures/docs/README.md')
    assert.equal(await collection.getByRole('button', { name: '搜索', exact: true }).count(), 0)
    assert.equal(await collection.getByRole('button', { name: '源代码管理', exact: true }).count(), 0)
    await collection.getByRole('button', { name: '关闭 Visual Studio Code' }).click()

    // Moving items out keeps the holder until only one is left; then it dissolves.
    await page.waitForTimeout(380)
    await holder.dblclick()
    await page.locator('.world-holder').waitFor()
    const tasksItem = page.locator('.world-holder-item').filter({ hasText: '垃圾箱' })
    await tasksItem.hover()
    await tasksItem.locator('.world-holder-remove').click()
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('dsh.world.holders') || '[]')[0]?.items.length === 2)
    assert.equal(await page.locator('[data-world-icon-kind="holder"]').count(), 1)
    assert.equal(await page.locator('[data-world-icon-id="plugin:world-trash"]').count(), 1)
    const notesItem = page.locator('.world-holder-item').filter({ hasText: 'notes.txt' })
    await notesItem.hover()
    await notesItem.locator('.world-holder-remove').click()
    await page.waitForFunction(() => !document.querySelector('[data-world-icon-kind="holder"]'))
    assert.equal(await page.locator('.world-desktop-icon').filter({ hasText: 'notes.txt' }).count(), 1)
    assert.equal(await page.locator('.world-desktop-icon').filter({ hasText: 'docs' }).count(), 1)
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.world.holders') || '[]').length), 0)

    assert.deepEqual(errors, [])
    console.log('Desktop items passed: file links (path only), shortcut delete, merge into holder, rename, VSCode collection tree with save, move-out dissolve.')
  } finally {
    await page.close()
  }
}
