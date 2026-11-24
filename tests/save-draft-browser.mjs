import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Delay the actual save response so edits and tab changes happen while it is pending. */
export async function checkSaveDraft(browser, bundleText, shotsDir) {
  for (const scenario of ['rapid', 'typing', 'switched', 'clean', 'failure']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const saves = [], errors = []
    page.on('pageerror', error => errors.push(error.message))
    const submitted = 'const value = 2\n'
    const latest = submitted + '// 保存期间继续输入，必须保留\n'
    try {
      await page.addInitScript(() => localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode'])))
      await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
      await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
      await page.exposeBinding('__worldSourceSave', (_source, payload) =>
        new Promise(resolve => saves.push({ payload, resolve })))
      await page.route('http://127.0.0.1/world-save-fixture', route => route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
      await page.goto('http://127.0.0.1/world-save-fixture')
      await page.addScriptTag({ content: bundleText })
      await page.locator('.world-start-button').click()
      await page.locator('[data-world-app-card="vscode"] .world-app-open').click()
      await page.getByRole('button', { name: 'src', exact: true }).click()
      await page.getByRole('button', { name: 'main.js', exact: true }).click()
      const editor = page.locator('.world-vscode-textarea')
      await editor.waitFor()
      await editor.fill(submitted)
      const geometry = () => editor.evaluate(node => {
        const box = node.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height }
      })
      const before = await geometry()
      if (scenario === 'rapid') {
        // Native shortcut listeners can receive several events before React commits saving=true.
        await editor.evaluate(node => {
          node.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }))
          node.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true, repeat: true }))
          document.querySelector('.world-vscode-statusbar button[title="保存 (Ctrl+S)"]').click()
        })
      } else await page.getByRole('button', { name: '保存', exact: true }).click()
      await page.waitForFunction(() => window.__worldTesting.calls.some(call => call.method === 'world-vscode-source/save'))
      assert.equal(await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-source/save').length), 1,
        'rapid save commands must submit only one request with the observed file version')
      assert.equal(saves.length, 1)
      assert.equal(saves[0].payload.source, submitted)
      assert.equal(saves[0].payload.version, 'v1')
      const edited = !['rapid', 'clean'].includes(scenario)
      if (edited) await editor.fill(latest)
      if (scenario === 'switched') {
        await page.getByRole('button', { name: 'README.md', exact: true }).click()
        await editor.fill('# Another unsaved draft\n')
      }
      if (scenario === 'rapid') {
        await page.keyboard.press('Control+s')
        assert.equal(await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-source/save').length), 1,
          'the pending save must still block later duplicate shortcuts')
        if (shotsDir) {
          await mkdir(shotsDir, { recursive: true })
          await page.screenshot({ path: join(shotsDir, 'save-pending.png') })
        }
      }
      saves[0].resolve(scenario === 'failure'
        ? { ok: false, error: { message: 'save unavailable' } }
        : { ok: true, value: { path: saves[0].payload.path, source: submitted, version: 'v2', eol: 'LF', bom: false } })
      await page.waitForFunction(() => !document.querySelector('.world-vscode-status-msg')?.textContent.includes('正在保存'))
      // The rendered button gives a deterministic acknowledgement that saving has finished.
      await page.getByRole('button', { name: '保存', exact: true }).waitFor()
      if (scenario === 'failure') {
        for (const selector of ['.world-vscode-error', '.world-vscode-statusbar']) {
          await page.locator(selector).getByRole('button', { name: '查看详情' }).click()
          const details = page.getByRole('dialog', { name: '错误详情' })
          assert.equal(await details.getByRole('textbox', { name: '错误原文' }).inputValue(), 'save unavailable')
          await details.getByRole('button', { name: '关闭错误详情' }).click()
        }
      }
      if (scenario === 'switched') {
        assert.equal(await editor.inputValue(), '# Another unsaved draft\n', 'save response must not affect the selected file')
        assert.doesNotMatch(await page.locator('.world-vscode-statusbar').innerText(), /已保存/u,
          'another file with unsaved edits must not claim it was saved')
      }
      await page.getByRole('tab', { name: /main.js/u }).click()
      if (shotsDir && scenario === 'typing') {
        await mkdir(shotsDir, { recursive: true })
        await page.screenshot({ path: join(shotsDir, 'save-completed.png') })
      }
      assert.equal(await page.locator('.world-vscode-tab.active').evaluate(node => node.classList.contains('is-dirty')), edited,
        'input added while saving must remain an unsaved draft')
      if (edited) {
        assert.doesNotMatch(await page.locator('.world-vscode-statusbar').innerText(), /已保存/u)
        // Remount the uncontrolled textarea: checking only its visible value would miss lost React state.
        await page.getByRole('button', { name: 'README.md', exact: true }).click()
        await page.getByRole('tab', { name: /main.js/u }).click()
      }
      assert.equal(await editor.inputValue(), edited ? latest : submitted)
      assert.deepEqual(await geometry(), before, 'save completion must preserve editor geometry')
      if (edited) {
        await page.getByRole('button', { name: '保存', exact: true }).click()
        await page.waitForFunction(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-source/save').length === 2)
        assert.equal(saves[1].payload.source, latest, 'next save must contain the retained input')
        assert.equal(saves[1].payload.version, scenario === 'failure' ? 'v1' : 'v2',
          'successful save must advance the disk version; failed save must retain it')
        saves[1].resolve({ ok: true, value: { path: saves[1].payload.path, source: latest, version: 'v3', eol: 'LF', bom: false } })
      }
      await page.waitForFunction(() => !document.querySelector('.world-vscode-tab.active')?.classList.contains('is-dirty'))
      assert.equal(await editor.inputValue(), edited ? latest : submitted)
      assert.deepEqual(errors, [])
      console.log(`Save draft passed: ${scenario}; editor geometry ${JSON.stringify(before)}`)
    } finally { await page.close() }
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
  try { await checkSaveDraft(browser, bundle.outputFiles[0].text, process.env.WORLD_SAVE_SHOTS_DIR) }
  finally { await browser.close() }
}
