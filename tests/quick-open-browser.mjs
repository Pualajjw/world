import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function checkQuickOpen(browser, bundleText, shotsDir) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = [], requests = []
  let release, mode = 'normal'
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.exposeBinding('__worldFileSearch', (_source, payload) => {
      requests.push(payload)
      const query = payload.query.toLowerCase()
      if (mode === 'error') return { ok: false, error: { message: '文件搜索暂不可用' } }
      const files = ['main.js', 'main-test.js', 'README.md', '中文窗口.srw'].filter(path => path.toLowerCase().includes(query)).map(path => ({ path }))
      const result = { ok: true, value: { query: payload.query, files, fileCount: files.length, truncated: false } }
      return mode === 'delayed' ? new Promise(resolve => { release = () => resolve(result) }) : result
    })
    await page.route('http://127.0.0.1/world-quick-fixture', route => route.fulfill({ contentType: 'text/html', body:
      '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
    await page.goto('http://127.0.0.1/world-quick-fixture')
    await page.evaluate(() => localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode'])))
    await page.addScriptTag({ content: bundleText })
    const launch = async () => {
      await page.getByRole('button', { name: '开始', exact: true }).click()
      await page.locator('[data-world-app-card="vscode"] .world-app-open').click()
    }
    await launch()
    const windows = page.locator('.world-vscode-window')
    const first = windows.nth(0)
    await first.getByRole('button', { name: 'src', exact: true }).click()
    await first.getByRole('button', { name: 'main.js', exact: true }).waitFor()
    await first.getByRole('button', { name: 'main.js', exact: true }).click()
    await first.locator('textarea').fill('// first draft')
    await page.locator('[data-world-icon-id="vscode"]').dblclick()
    await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window').length === 2)
    const second = windows.nth(1)
    assert.equal(await second.locator('.world-vscode-status-root').textContent(), '◆ 打开文件夹')
    assert.equal(await second.locator('.world-vscode-file').count(), 0, 'a blank editor must not fall back to the session cwd')
    assert.equal(await second.locator('.world-vscode-error').count(), 0)
    assert.equal(await second.locator('.world-vscode-status-branch').count(), 0)
    assert.equal(await page.evaluate(() => window.__worldTesting.calls.some(call => call.method === 'world-vscode-git/status' && call.payload.root === '')), false)
    assert.equal(await first.locator('textarea').inputValue(), '// first draft')
    const blankKey = await second.getAttribute('data-world-vscode-key')
    await page.locator('[data-world-icon-id="vscode"]').dblclick()
    await launch()
    assert.equal(await windows.count(), 2, 'desktop and menu launches reuse the one blank window')
    assert.equal(await second.getAttribute('data-world-vscode-key'), blankKey)
    await second.getByRole('button', { name: '最小化 Visual Studio Code', exact: true }).click()
    await page.locator('[data-world-icon-id="vscode"]').dblclick()
    await page.waitForFunction(() => !document.querySelectorAll('.world-vscode-window')[1].classList.contains('is-min'))
    assert.equal(await windows.count(), 2, 'a minimized blank editor is restored, not duplicated')
    await page.evaluate(() => {
      const icon = document.querySelector('[data-world-icon-id="vscode"]')
      icon.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      icon.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    assert.equal(await windows.count(), 2, 'same-turn launches cannot create another blank editor')
    // Selecting the already-open folder focuses the owner and leaves the blank editor unchanged.
    await second.locator('.world-vscode-title-btn[aria-label="打开文件夹"]').click()
    await second.locator('.world-vscode-picker').getByRole('button', { name: '打开', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window')[0].classList.contains('is-active'))
    assert.equal(await windows.count(), 2)
    assert.equal(await second.locator('.world-vscode-status-root').textContent(), '◆ 打开文件夹')
    assert.equal(await first.locator('textarea').inputValue(), '// first draft')
    await page.locator('[data-world-taskbar^="vscode:"]').nth(1).click()
    // A different root still gets an independent editor and draft.
    await second.locator('.world-vscode-title-btn[aria-label="打开文件夹"]').click()
    await second.locator('.world-vscode-picker-row').filter({ hasText: 'src' }).click()
    await second.locator('.world-vscode-picker').getByRole('button', { name: '打开', exact: true }).click()
    await second.getByRole('button', { name: 'main.js', exact: true }).waitFor()
    await second.getByRole('button', { name: 'main.js', exact: true }).click()
    await second.locator('textarea').fill('// second draft')
    assert.equal(await first.locator('textarea').inputValue(), '// first draft')
    assert.equal(await second.locator('textarea').inputValue(), '// second draft')
    // Reopening an occupied recent folder creates a blank instance and keeps recent history intact.
    const recentBefore = await page.evaluate(() => localStorage.getItem('dsh.world.vscode.folders'))
    await page.evaluate(() => {
      const icon = document.querySelector('[data-world-icon-id="vscode"]')
      icon.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      icon.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window').length === 3)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
    assert.equal(await windows.count(), 3, 'simultaneous creation requests reserve one blank instance')
    const blank = windows.nth(2)
    assert.equal(await blank.locator('.world-vscode-status-root').textContent(), '◆ 打开文件夹')
    assert.equal(await page.evaluate(() => localStorage.getItem('dsh.world.vscode.folders')), recentBefore)
    if (shotsDir) { await mkdir(shotsDir, { recursive: true }); await page.screenshot({ path: join(shotsDir, 'vscode-empty-window.png') }) }
    await blank.getByRole('button', { name: '关闭 Visual Studio Code', exact: true }).click()
    await page.locator('[data-world-taskbar^="vscode:"]').nth(0).click()
    await first.getByRole('button', { name: '最小化 Visual Studio Code', exact: true }).click()
    await second.locator('.world-vscode-title-btn[aria-label="打开文件夹"]').click()
    const existingPicker = second.locator('.world-vscode-picker')
    await existingPicker.locator('.world-vscode-picker-input').fill('/workspace')
    await existingPicker.locator('.world-vscode-picker-input').press('Enter')
    await existingPicker.getByRole('button', { name: '在新窗口打开', exact: true }).click()
    await page.waitForFunction(() => !document.querySelectorAll('.world-vscode-window')[0].classList.contains('is-min'))
    assert.equal(await windows.count(), 2, 'minimized folder windows count as already open')
    assert.equal(await first.locator('textarea').inputValue(), '// first draft')
    await page.locator('[data-world-taskbar^="vscode:"]').nth(1).click()
    assert.equal(await page.locator('[data-world-taskbar^="vscode:"]').count(), 2)
    // Explicitly opening the same folder also reuses its owner.
    await second.locator('.world-vscode-title-btn[aria-label="打开文件夹"]').click()
    await second.locator('.world-vscode-picker').getByRole('button', { name: '在新窗口打开', exact: true }).click()
    await page.waitForTimeout(100)
    assert.equal(await windows.count(), 2)
    assert.equal(await first.locator('textarea').inputValue(), '// first draft')
    assert.equal(await second.locator('textarea').inputValue(), '// second draft')
    await second.locator('textarea').click()
    await page.keyboard.press('Control+p')
    const popup = second.locator('.world-vscode-quickopen')
    const input = popup.getByRole('textbox', { name: '搜索文件名' })
    await input.waitFor()
    assert.equal(await first.locator('.world-vscode-quickopen').count(), 0, 'Ctrl+P belongs only to the focused editor')
    assert.equal(await input.evaluate(node => node === document.activeElement), true)
    assert.equal(requests.length, 0, 'empty queries do not traverse the workspace')
    await input.fill('main')
    await popup.getByRole('option').first().waitFor()
    assert.equal(await popup.getByRole('option').count(), 2)
    assert.equal(requests.at(-1).root, '/workspace/src')
    const geometry = await popup.evaluate(node => ({ width: node.querySelector('.world-vscode-picker-card').getBoundingClientRect().width,
      padding: getComputedStyle(node).padding, radius: getComputedStyle(node.querySelector('.world-vscode-picker-card')).borderRadius,
      inputHeight: node.querySelector('input').getBoundingClientRect().height, rowHeight: node.querySelector('[role="option"]').getBoundingClientRect().height }))
    assert.deepEqual(geometry, { width: 560, padding: '24px', radius: '8px', inputHeight: 24, rowHeight: 26 })
    if (shotsDir) { await mkdir(shotsDir, { recursive: true }); await page.screenshot({ path: join(shotsDir, 'quick-open-desktop.png') }) }
    await input.press('ArrowDown')
    assert.equal(await popup.getByRole('option').nth(1).getAttribute('aria-selected'), 'true')
    await input.press('ArrowUp'); await input.press('Enter')
    await popup.waitFor({ state: 'detached' })
    assert.equal(await second.locator('textarea').inputValue(), '// second draft', 'opening an existing file preserves its draft')

    await second.locator('textarea').click(); await page.keyboard.press('Control+p')
    mode = 'delayed'; await input.fill('main')
    while (!release) await page.waitForTimeout(10)
    await input.fill('README'); mode = 'normal'
    await popup.getByRole('option', { name: 'README.md', exact: true }).waitFor()
    release(); await page.waitForTimeout(50)
    assert.equal(await popup.getByRole('option').count(), 1, 'a delayed response cannot replace the current results')
    await input.press('Enter')
    await second.getByRole('tab', { name: /README.md/u }).waitFor()
    assert.equal(await first.getByRole('tab', { name: /README.md/u }).count(), 0)
    await second.locator('textarea').click(); await page.keyboard.press('Control+p')
    mode = 'error'; await input.fill('中文')
    await popup.getByRole('alert').waitFor()
    mode = 'normal'; await popup.getByRole('button', { name: '重试', exact: true }).click()
    await popup.getByRole('option', { name: /中文窗口/u }).waitFor()
    await page.setViewportSize({ width: 360, height: 740 })
    assert.equal(await input.evaluate(node => node.getBoundingClientRect().height), 40)
    assert.equal(await popup.getByRole('option').evaluate(node => node.getBoundingClientRect().height), 40)
    assert.equal(await popup.evaluate(node => node.scrollWidth > node.clientWidth), false)
    if (shotsDir) await page.screenshot({ path: join(shotsDir, 'quick-open-phone.png') })
    await input.fill('not-found')
    await popup.getByText('没有匹配的文件。', { exact: true }).waitFor()
    await input.press('Escape')
    await popup.waitFor({ state: 'detached' })
    assert.deepEqual(errors, [])
    console.log(`Quick open passed: ${JSON.stringify(geometry)}; single blank instance, same-turn launches, minimized reuse, unique folder windows, unchanged history/drafts, Ctrl+P ownership, search and phone.`)
  } finally { await page.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(new URL('../../workflow-studio/package.json', import.meta.url))
  const { build } = require('esbuild'), { chromium } = require('playwright-core')
  const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true,
    format: 'iife', platform: 'browser', target: 'es2022', write: false,
    nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' } })
  const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  try { await checkQuickOpen(browser, bundle.outputFiles[0].text, process.env.WORLD_QUICK_OPEN_SHOTS_DIR) }
  finally { await browser.close() }
}
