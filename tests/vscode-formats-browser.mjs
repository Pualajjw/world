import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function checkVscodeFormats(browser, bundleText, shotsDir) {
  for (const phone of [false, true]) {
    const page = await browser.newPage({ viewport: phone ? { width: 360, height: 740 } : { width: 1280, height: 800 } })
    const errors = []
    const source = 'String ls_name = "中文"\nIF IsNull(ls_name) THEN\n  MessageBox("提示", ls_name, Information!) // 中文注释\nEND IF\n'
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.addInitScript(() => localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode'])))
      await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
      await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
      await page.exposeBinding('__worldWorkspaceList', (_source, payload) => ({ ok: true, value: { path: payload.path,
        parent: '', entries: ['w_gbk.srw', 'w_utf8.srw'].map(name => ({ name, type: 'file' })), truncated: false } }))
      await page.exposeBinding('__worldSourceOpen', (_source, payload) => ({ ok: true, value: { path: payload.path,
        source, version: 'v1', eol: 'CRLF', bom: false, encoding: payload.path.includes('gbk') ? 'GBK' : 'UTF-8',
        readOnly: payload.path.includes('gbk') } }))
      await page.route('http://127.0.0.1/world-vscode-formats', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
        '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
      await page.goto('http://127.0.0.1/world-vscode-formats')
      await page.addScriptTag({ content: bundleText })
      await page.getByRole('button', { name: phone ? '全部应用' : '开始', exact: true }).click()
      await page.locator('[data-world-app-card="vscode"] .world-app-open').click()
      const showFiles = async () => {
        await page.getByRole('button', { name: '视图菜单', exact: true }).click()
        await page.getByRole('menuitemradio', { name: /资源管理器/ }).click()
      }
      if (phone) await showFiles()
      await page.getByRole('button', { name: 'w_gbk.srw', exact: true }).click()
      const editor = page.locator('.world-vscode-textarea')
      await editor.waitFor()
      assert.equal(await editor.inputValue(), source)
      assert.equal(await editor.evaluate(node => node.readOnly), true)
      await page.locator('.world-vscode-status-msg').filter({ hasText: 'GBK · 只读' }).waitFor()
      await page.locator('.world-vscode-highlight .world-vscode-tok-fn').filter({ hasText: 'MessageBox' }).waitFor()
      assert.ok(await page.locator('.world-vscode-highlight .world-vscode-tok-str').filter({ hasText: '中文' }).count())
      await editor.focus()
      for (const key of ['Enter', 'Tab', 'Backspace', 'x', 'Control+s']) await editor.press(key)
      assert.equal(await editor.inputValue(), source, 'GBK keyboard input must not change the file or create a draft')
      assert.equal(await page.locator('.world-vscode-tab.is-dirty').count(), 0)
      assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isDisabled(), true)
      assert.equal(await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-source/save').length), 0)
      const geometry = await page.locator('.world-vscode-window').evaluate(node => ({ width: node.getBoundingClientRect().width,
        height: node.getBoundingClientRect().height, inputFont: getComputedStyle(node.querySelector('textarea')).fontSize }))
      if (shotsDir) {
        await mkdir(shotsDir, { recursive: true })
        await page.screenshot({ path: join(shotsDir, phone ? 'gbk-pb-phone.png' : 'gbk-pb-desktop.png'), animations: 'disabled' })
      }
      if (phone) await showFiles()
      await page.getByRole('button', { name: 'w_utf8.srw', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('.world-vscode-textarea')?.readOnly === false)
      assert.equal(await editor.inputValue(), source)
      await editor.press('Control+End'); await editor.press('Enter'); await editor.type('// edited')
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await page.waitForFunction(() => !document.querySelector('.world-vscode-tab.is-dirty'))
      assert.equal(await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-source/save').length), 1)
      assert.deepEqual(errors, [])
      console.log(`VSCode formats passed: ${phone ? 'phone' : 'desktop'}; GBK read-only, PB highlighting, UTF-8 editing; ${JSON.stringify(geometry)}`)
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
  try { await checkVscodeFormats(browser, bundle.outputFiles[0].text, process.env.WORLD_FORMATS_SHOTS_DIR) }
  finally { await browser.close() }
}
