import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function checkReplaceDraft(browser, bundleText) {
  for (const scenario of ['typing', 'clean', 'dirty']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    let opens = 0, release
    const original = 'const value = 1\n'
    const replaced = 'const next = 1\n'
    const draft = 'const value = 1\n// 重读期间新输入，必须保留\n'
    try {
      await page.addInitScript(() => localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode'])))
      await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
      await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
      await page.exposeBinding('__worldSourceOpen', (_source, payload) => {
        opens++
        const response = { ok: true, value: { path: payload.path, source: opens === 1 ? original : replaced,
          version: opens === 1 ? 'v1' : 'v2', eol: 'LF', bom: false } }
        if (scenario === 'typing' && opens === 2) return new Promise(resolve => { release = () => resolve(response) })
        return response
      })
      await page.route('http://127.0.0.1/world-replace-fixture', route => route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
      await page.goto('http://127.0.0.1/world-replace-fixture')
      await page.addScriptTag({ content: bundleText })
      await page.locator('.world-start-button').click()
      await page.locator('[data-world-app-card="vscode"] .world-app-open').click()
      await page.getByRole('button', { name: 'src', exact: true }).click()
      await page.getByRole('button', { name: 'main.js', exact: true }).click()
      const editor = page.locator('.world-vscode-textarea')
      await editor.waitFor()
      assert.equal(await editor.inputValue(), original)
      if (scenario === 'dirty') await editor.fill(draft)
      await page.getByRole('button', { name: '搜索', exact: true }).click()
      await page.locator('.world-vscode-search-input').fill('value')
      await page.locator('.world-vscode-search-file').first().waitFor()
      await page.getByRole('button', { name: '切换替换', exact: true }).click()
      await page.locator('.world-vscode-search-box.is-replace input').fill('next')
      await page.locator('.world-vscode-search-file-replace').first().click()
      if (scenario === 'typing') {
        // Wait for the actual reload request, not an arbitrary network delay.
        await page.waitForFunction(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-source/open').length === 2)
        assert.equal(typeof release, 'function')
        await editor.fill(draft)
        release()
      }
      if (scenario === 'dirty') {
        await page.locator('.world-vscode-error').filter({ hasText: '还有未保存的修改' }).waitFor()
        assert.equal(opens, 1, 'already-dirty files are not reloaded')
        assert.equal(await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-search/replace').length), 0)
      } else {
        await page.locator('.world-vscode-search-notice').filter({ hasText: '已替换' }).waitFor()
        assert.equal(opens, 2)
      }
      assert.equal(await editor.inputValue(), scenario === 'clean' ? replaced : draft,
        'replacement reload must never overwrite an unsaved draft')
      if (scenario === 'typing') {
        assert.equal(await page.locator('.world-vscode-tab.active').evaluate(node => node.classList.contains('is-dirty')), true, 'new input must remain an unsaved draft')
        assert.match(await page.locator('.world-vscode-search-notice').innerText(), /读取期间.*已保留草稿/u)
        await page.getByRole('button', { name: '资源管理器', exact: true }).click()
        await page.getByRole('button', { name: 'README.md', exact: true }).click()
        await page.getByRole('tab', { name: /main.js/u }).click()
        assert.equal(await editor.inputValue(), draft, 'switching tabs must retain the actual stored draft')
      }
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  }
  console.log('Replace draft passed: clean tabs reload, typing during delayed reload is retained with warning, pre-existing dirty tabs are skipped.')
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
  try { await checkReplaceDraft(browser, bundle.outputFiles[0].text) }
  finally { await browser.close() }
}
