import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Deliver real RPC responses out of order while switching the task window's filters. */
export async function checkTasksFilter(browser, bundleText, shotsDir) {
  const scenarios = ['same-revision', 'newer-revision', 'round-trip', 'rpc-error', 'transport-error', 'current-error']
  for (const scenario of scenarios) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors = [], pending = []
    let deferPending = true, failDoing = scenario === 'current-error'
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
      await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
      await page.exposeBinding('__worldTasksCall', (_source, operation, payload) => {
        assert.equal(operation, 'list')
        const statuses = payload.status ? [payload.status] : ['pending', 'doing']
        const items = statuses.map(status => ({ id: status, title: `${status}-task`, status,
          note: '', next: '', revision: 1, createdAt: 1, updatedAt: 1, createdBy: 'human', updatedBy: 'human' }))
        const response = { ok: true, value: { revision: 2, total: items.length,
          counts: { active: 2, pending: 1, doing: 1, blocked: 0, done: 0 }, items } }
        if (payload.status === 'pending' && deferPending) {
          return new Promise((resolve, reject) => pending.push({ response, resolve, reject }))
        }
        if (payload.status === 'doing' && failDoing) return { ok: false, error: { message: 'current filter unavailable' } }
        return response
      })
      await page.route('http://127.0.0.1/world-tasks-filter-fixture', route => route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
      await page.goto('http://127.0.0.1/world-tasks-filter-fixture')
      await page.evaluate(() => {
        const call = window.__worldTasksCall
        window.__worldTasksFilterSettled = 0
        window.__worldTasksCall = async (...args) => {
          try { return await call(...args) }
          finally { window.__worldTasksFilterSettled++ }
        }
      })
      await page.addScriptTag({ content: bundleText })
      await page.locator('.world-start-button').click()
      await page.locator('[data-world-app-card="world-tasks"] .world-app-open').click()
      const win = page.locator('[data-world-plugin="world-tasks"]')
      await win.locator('[data-world-task="doing"]').waitFor()
      const geometry = () => win.evaluate(node => ({ width: node.getBoundingClientRect().width,
        listWidth: node.querySelector('.world-journal-list').getBoundingClientRect().width,
        rowHeight: node.querySelector('.world-task-row').getBoundingClientRect().height,
        buttonHeight: node.querySelector('.world-journal-buttons button').getBoundingClientRect().height }))
      const before = await geometry()
      await win.getByRole('tab', { name: '待处理', exact: true }).click()
      await page.waitForFunction(() => window.__worldTesting.calls.some(call => call.method === 'world-tasks/list' && call.payload.status === 'pending'))
      assert.ok(pending.length > 0, 'hold the actual first-filter response')
      await win.getByRole('tab', { name: '进行中', exact: true }).click()
      if (scenario === 'current-error') {
        await win.getByRole('alert').filter({ hasText: 'current filter unavailable' }).waitFor()
      } else {
        await page.waitForFunction(() => {
          const rows = document.querySelectorAll('[data-world-plugin="world-tasks"] .world-task-row')
          return rows.length === 1 && rows[0].dataset.worldTask === 'doing'
        })
      }
      const roundTrip = scenario === 'round-trip'
      if (roundTrip) {
        deferPending = false
        await win.getByRole('tab', { name: '待处理', exact: true }).click()
        await win.locator('[data-world-task="pending"]').waitFor()
      }
      const beforeLateResponse = await win.locator('.world-task-row strong').allTextContents()
      const settled = await page.evaluate(() => window.__worldTasksFilterSettled)
      const lateCount = pending.length
      for (const entry of pending.splice(0)) {
        if (scenario === 'transport-error') entry.reject(new Error('old transport unavailable'))
        else if (scenario === 'rpc-error' || scenario === 'current-error') {
          entry.resolve({ ok: false, error: { message: 'old filter unavailable' } })
        } else {
          entry.response.value.revision = scenario === 'newer-revision' ? 3 : 2
          entry.response.value.items[0].title = 'obsolete pending response'
          entry.resolve(entry.response)
        }
      }
      // Drain the binding, RPC, and React update queues before checking that nothing changed.
      await page.waitForFunction(count => window.__worldTasksFilterSettled >= count, settled + lateCount)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.deepEqual(await win.locator('.world-task-row strong').allTextContents(), beforeLateResponse,
        `${scenario}: a previous filter visit must not overwrite the current list`)
      assert.equal(await win.getByRole('tab', { selected: true }).textContent(), roundTrip ? '待处理' : '进行中')
      assert.deepEqual(await win.getByRole('alert').allTextContents(),
        scenario === 'current-error' ? ['current filter unavailable'] : [],
        `${scenario}: an obsolete failure must not replace the current filter's error state`)
      if (scenario === 'current-error') {
        failDoing = false
        await page.evaluate(() => window.dispatchEvent(new Event('focus')))
        await win.locator('[data-world-task="doing"]').waitFor()
        await page.waitForFunction(() => !document.querySelector('[data-world-plugin="world-tasks"] [role="alert"]'))
        assert.equal(await win.locator('.world-task-row').count(), 1, 'the current filter can recover on refresh')
      }
      assert.deepEqual(await geometry(), before)
      if (shotsDir && scenario === 'same-revision') {
        await mkdir(shotsDir, { recursive: true })
        await page.screenshot({ path: join(shotsDir, 'tasks-filter-late-response.png'), animations: 'disabled' })
      }
      assert.deepEqual(errors, [])
      console.log(`Task filters passed: ${scenario}; geometry ${JSON.stringify(before)}`)
    } finally {
      for (const entry of pending) entry.resolve(entry.response)
      await page.close()
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  let build
  try { ({ build } = await import('esbuild')) }
  catch { ({ build } = await import('../../pbpkg/node_modules/esbuild/lib/main.js')) }
  const require = createRequire(new URL('../../workflow-studio/package.json', import.meta.url))
  const { chromium } = require('playwright-core')
  const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true,
    format: 'iife', platform: 'browser', target: 'es2022', write: false,
    nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' } })
  const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  try { await checkTasksFilter(browser, bundle.outputFiles[0].text, process.env.WORLD_TASKS_SHOTS_DIR) }
  finally { await browser.close() }
}
