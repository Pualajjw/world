import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { createTasksStore } from '../tasks.js'
import { createDesktopBridge } from '../desktop-bridge.js'
import { atomic } from './journal-fixture.mjs'

/** The shared task window through the RPC boundary and a durable temporary store. */
export async function checkTasks(browser, bundleText, root) {
  const directory = await mkdtemp(join(tmpdir(), 'world-tasks-ui-')), file = join(directory, 'tasks.json')
  const tasks = createTasksStore({ file, atomic }), other = createTasksStore({ file, atomic }), bridge = createDesktopBridge()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push('console: ' + message.text()) })
  try {
    await page.exposeBinding('__worldDesktopCall', (_source, operation, payload) => bridge.call(operation, payload))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.exposeBinding('__worldTasksCall', async (_source, operation, payload) => {
      try { return { ok: true, value: await tasks.call(operation, payload) } }
      catch (error) { return { ok: false, error: { code: error.code, message: error.message } } }
    })
    await page.route('http://127.0.0.1/world-tasks-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
    await page.goto('http://127.0.0.1/world-tasks-fixture')
    await page.addScriptTag({ content: bundleText })
    // 待办只在开始菜单里：0.2.73 起桌面上不再摆这个图标。
    await page.locator('[data-world-icon-id="plugin:world-trash"]').waitFor()
    await page.locator('.world-start-button').click()
    await page.locator('[data-world-app-card="world-tasks"] .world-app-open').click()
    const win = page.locator('[data-world-plugin="world-tasks"]')
    await win.getByRole('button', { name: '新建待办', exact: true }).click()
    const title = win.getByLabel('待办标题', { exact: true }), next = win.getByLabel('下一步', { exact: true })
    await title.fill('检查日记置顶'); await next.fill('打开日记窗口验证')
    await win.getByRole('button', { name: '保存', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-world-plugin="world-tasks"] .world-journal-meta')?.textContent.includes('已保存'))
    let listed = await tasks.call('list', { all: true })
    assert.equal(listed.total, 1)
    assert.equal(listed.items[0].title, '检查日记置顶')
    assert.equal(listed.items[0].createdBy, 'human')
    const geometry = await win.evaluate(node => ({
      width: node.getBoundingClientRect().width,
      listWidth: node.querySelector('.world-journal-list').getBoundingClientRect().width,
      rowHeight: node.querySelector('.world-task-row').getBoundingClientRect().height,
      buttonHeight: node.querySelector('.world-journal-buttons button').getBoundingClientRect().height,
      inputHeight: node.querySelector('[aria-label="待办标题"]').getBoundingClientRect().height,
      dot: getComputedStyle(node.querySelector('.world-task-dot')).backgroundColor,
      font: getComputedStyle(node.querySelector('.world-tasks')).fontSize,
    }))
    assert.equal(geometry.width, 1024); assert.equal(geometry.listWidth, 280)
    assert.ok(geometry.rowHeight >= 64); assert.equal(geometry.buttonHeight, 32); assert.equal(geometry.inputHeight, 32)
    assert.equal(geometry.dot, 'rgb(214, 164, 76)'); assert.equal(geometry.font, '13px')

    await win.locator('.world-task-statuses').getByRole('button', { name: '进行中', exact: true }).click()
    await win.getByRole('button', { name: '保存', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-world-plugin="world-tasks"] .world-journal-meta')?.textContent.includes('已保存'))
    listed = await tasks.call('list')
    assert.equal(listed.items[0].status, 'doing')

    await win.locator('.world-task-statuses').getByRole('button', { name: '已完成', exact: true }).click()
    await win.getByRole('button', { name: '保存', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[data-world-plugin="world-tasks"] .world-task-row'))
    listed = await tasks.call('list', { all: true })
    assert.equal(listed.items[0].status, 'done')
    assert.ok(Number.isFinite(listed.items[0].doneAt))
    await win.getByRole('tab', { name: '已完成', exact: true }).click()
    await win.locator('.world-task-row').filter({ hasText: '检查日记置顶' }).waitFor()
    await win.getByRole('button', { name: /清理已完成/ }).click()
    const dialog = win.getByRole('dialog', { name: '清理已完成', exact: true })
    await dialog.getByRole('button', { name: '清理已完成', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[data-world-plugin="world-tasks"] .world-task-row'))
    assert.equal((await other.call('list', { all: true })).total, 0)

    await win.getByRole('button', { name: '新建待办', exact: true }).click()
    await title.fill('未保存的草稿')
    const protectedDraft = await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented
    })
    assert.equal(protectedDraft, true, 'an unsaved task draft protects the page from unload')

    const shots = process.env.WORLD_TASKS_SHOTS_DIR
    if (shots) {
      await mkdir(shots, { recursive: true })
      await page.screenshot({ path: join(shots, 'tasks.png'), animations: 'disabled' })
    }
    assert.deepEqual(errors, [])
    console.log(`Tasks passed: ${JSON.stringify({ geometry }) }; real persistence, status changes, done filter, confirmed cleanup and unload protection.`)
  } finally {
    await page.close(); bridge.dispose(); await tasks.dispose(); await other.dispose()
    assert.equal(dirname(directory), tmpdir()); assert.ok(basename(directory).startsWith('world-tasks-ui-'))
    await rm(directory, { recursive: true, force: true })
  }
}
