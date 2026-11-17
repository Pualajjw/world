import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Replay composing key events through the terminal's document listener; no real shell is used. */
export async function checkTerminalIme(browser, bundleText, shotsDir) {
  for (const phone of [false, true]) for (const marker of ['isComposing', 'keyCode229']) {
    const page = await browser.newPage({ viewport: phone ? { width: 360, height: 740 } : { width: 1280, height: 800 } })
    const calls = [], errors = []
    const history = ['echo 第一条历史', 'echo 中文历史']
    const command = 'echo 中文已确认'
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.addInitScript(history => localStorage.setItem('dsh.world.terminal.history', JSON.stringify(history)), history)
      await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
      await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
      await page.exposeBinding('__worldTerminalCall', (_source, operation, payload) => {
        calls.push({ operation, payload })
        if (operation === 'info') return { ok: true, value: { cwd: '/workspace', home: '/workspace', platform: 'windows', shell: 'cmd' } }
        if (operation === 'run') return { ok: true, value: { jobId: `mock-${calls.length}`, cwd: '/workspace', startedAt: Date.now(), shell: 'cmd' } }
        if (operation === 'poll') return { ok: true, value: { chunk: '中文已确认\r\n', offset: 1, running: false, exitCode: 0, durationMs: 0 } }
        return { ok: false, error: { message: `Unexpected terminal operation: ${operation}` } }
      })
      await page.route('http://127.0.0.1/world-terminal-ime', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
        '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
      await page.goto('http://127.0.0.1/world-terminal-ime')
      await page.addScriptTag({ content: bundleText })
      await page.getByRole('button', { name: phone ? '全部应用' : '开始', exact: true }).click()
      await page.locator('[data-world-app-card="terminal"] .world-app-open').click()
      const input = page.locator('.world-term-input')
      await input.waitFor()
      await page.waitForFunction(() => document.querySelector('[data-world-term-screen]')?.innerText.includes('world 终端'))
      const geometry = () => page.locator('.world-terminal-window').evaluate(node => {
        const rect = node.getBoundingClientRect()
        return { width: rect.width, height: rect.height,
          inputHeight: node.querySelector('.world-term-input-row').getBoundingClientRect().height,
          fontSize: getComputedStyle(node.querySelector('.world-term-input')).fontSize }
      })
      const before = await geometry()
      const composingKeys = async searching => {
        const draft = searching ? '中文' : command
        await input.fill(draft)
        await input.dispatchEvent('compositionstart', { data: '' })
        const priorCalls = calls.length
        const priorHistory = await page.evaluate(() => localStorage.getItem('dsh.world.terminal.history'))
        const priorSearch = await page.locator('.world-term-search').allTextContents()
        for (const key of ['Enter', 'ArrowUp', 'ArrowDown', 'Tab', 'Escape']) {
          const prevented = await input.evaluate((node, { key, marker }) => {
            const event = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true,
              isComposing: marker === 'isComposing', keyCode: marker === 'keyCode229' ? 229 : 0 })
            node.dispatchEvent(event)
            return event.defaultPrevented
          }, { key, marker })
          assert.equal(prevented, false, `${marker}/${key}: candidate selection belongs to the IME`)
          assert.equal(await input.inputValue(), draft, `${marker}/${key}: composition must retain the input`)
          assert.deepEqual(await page.locator('.world-term-search').allTextContents(), priorSearch,
            `${marker}/${key}: composition must not accept or cancel reverse search`)
        }
        assert.equal(calls.length, priorCalls, 'candidate selection must not submit commands or request completion')
        assert.equal(await page.evaluate(() => localStorage.getItem('dsh.world.terminal.history')), priorHistory,
          'candidate selection must not enter command history')
        await input.dispatchEvent('compositionend', { data: searching ? '中文' : '中文已确认' })
      }

      await composingKeys(false)
      await input.press('Enter')
      await page.waitForFunction(() => window.__worldTesting.calls.some(call => call.method === 'world-terminal/poll'))
      assert.deepEqual(calls.filter(call => call.operation === 'run').map(call => call.payload.line), [command],
        'a normal Enter after composition must submit the complete command exactly once')
      assert.equal(await input.inputValue(), '')
      await input.press('ArrowUp')
      assert.equal(await input.inputValue(), command, 'normal history navigation resumes after composition')
      await input.press('Control+r')
      await page.locator('.world-term-search').waitFor()
      await composingKeys(true)
      await input.press('Enter')
      assert.equal(await page.locator('.world-term-search').count(), 0, 'normal Enter accepts the search result')
      assert.equal(await input.inputValue(), command)
      assert.equal(calls.filter(call => call.operation === 'run').length, 1, 'accepting a search result does not execute it')
      await input.press('Control+r')
      await page.locator('.world-term-search').waitFor()
      await input.press('Escape')
      assert.equal(await page.locator('.world-term-search').count(), 0, 'normal Escape cancels reverse search')
      assert.equal(await input.inputValue(), command)
      assert.deepEqual(await geometry(), before)
      if (shotsDir && marker === 'isComposing') {
        await mkdir(shotsDir, { recursive: true })
        await page.screenshot({ path: join(shotsDir, phone ? 'terminal-ime-phone.png' : 'terminal-ime-desktop.png'), animations: 'disabled' })
      }
      assert.deepEqual(errors, [])
      console.log(`Terminal IME passed: ${phone ? 'phone' : 'desktop'}/${marker}; composing command and search keys, normal Enter/history/search restored; geometry ${JSON.stringify(before)}`)
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
  try { await checkTerminalIme(browser, bundle.outputFiles[0].text, process.env.WORLD_TERMINAL_IME_SHOTS_DIR) }
  finally { await browser.close() }
}
