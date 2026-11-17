import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function checkBatchStart(browser, bundleText) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const runs = [], cancels = [], errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.addInitScript(() => localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode'])))
    await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.exposeBinding('__worldTerminalCall', (_source, operation, payload) => {
      if (operation === 'run') return new Promise(resolve => runs.push({ payload, resolve }))
      if (operation === 'cancel') return new Promise(resolve => cancels.push({ payload, resolve }))
      if (operation === 'poll') return { ok: true, value: { chunk: '', offset: 0, running: true, durationMs: 1 } }
      throw new Error('Unexpected terminal operation: ' + operation)
    })
    await page.route('http://127.0.0.1/world-batch-fixture', route => route.fulfill({ contentType: 'text/html', body:
      '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
    await page.goto('http://127.0.0.1/world-batch-fixture')
    await page.addScriptTag({ content: bundleText })
    await page.locator('.world-start-button').click()
    await page.locator('[data-world-app-card="vscode"] .world-app-open').click()
    const file = page.getByRole('button', { name: 'build.bat', exact: true })
    await file.click()
    await page.locator('.world-vscode-textarea').waitFor()
    const run = page.getByRole('button', { name: '运行批处理', exact: true })
    await run.evaluate(button => { button.click(); button.click() })
    await page.waitForFunction(() => window.__worldTesting.calls.some(call => call.method === 'world-terminal/run'))
    assert.equal(await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-terminal/run').length), 1, 'two clicks before run responds must launch exactly one job')
    assert.equal(runs.length, 1)
    assert.equal(await run.isDisabled(), true)
    await file.click({ button: 'right' })
    const menuRun = page.getByRole('menuitem', { name: '运行批处理', exact: true })
    assert.equal(await menuRun.isDisabled(), true, 'context menu shares the starting guard')
    await page.keyboard.press('Escape')
    runs[0].resolve({ ok: true, value: { jobId: 'job-1' } })
    await page.locator('.world-vscode-output').waitFor()
    assert.equal(await run.isDisabled(), true, 'existing running-state toolbar behavior is unchanged')
    // Context menu retains its original restart behavior, including cancellation before run.
    await file.click({ button: 'right' }); await menuRun.click()
    await page.waitForFunction(() => window.__worldTesting.calls.some(call => call.method === 'world-terminal/cancel'))
    assert.equal(cancels[0].payload.jobId, 'job-1')
    await file.click({ button: 'right' })
    assert.equal(await menuRun.isDisabled(), true, 'restart guard is acquired before awaiting cancellation')
    await page.keyboard.press('Escape')
    cancels[0].resolve({ ok: true, value: { cancelled: true } })
    await page.waitForFunction(() => window.__worldTesting.calls.filter(call => call.method === 'world-terminal/run').length === 2)
    runs[1].resolve({ ok: false, error: { message: 'start failed' } })
    await page.locator('.world-vscode-output-state').filter({ hasText: 'start failed' }).waitFor()
    assert.equal(await run.isEnabled(), true, 'a rejected start must release the guard')
    await run.click()
    await page.waitForFunction(() => window.__worldTesting.calls.filter(call => call.method === 'world-terminal/run').length === 3)
    runs[2].resolve({ ok: true, value: { jobId: 'job-3' } })
    await page.waitForFunction(() => document.querySelector('.world-vscode-output-state')?.textContent.includes('运行中'))
    assert.equal(runs.length, 3)
    assert.equal(cancels.length, 1)
    assert.deepEqual(errors, [])
    console.log('Batch start passed: same-tick double-click guarded, both entry points disabled while starting, cancel-before-restart retained, failed start permits retry. No real scripts executed.')
  } finally { await page.close() }
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
  try { await checkBatchStart(browser, bundle.outputFiles[0].text) }
  finally { await browser.close() }
}
