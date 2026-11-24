import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(resolve(root, '../workflow-studio/package.json'))
const { build } = require('esbuild'), { chromium } = require('playwright-core')
const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true, format: 'iife',
  platform: 'browser', target: 'es2022', write: false, define: { 'process.env.NODE_ENV': '"production"' },
  nodePaths: [resolve(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' } })
const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
const reports = [], errors = []
const total = 1200 // Keep syntax highlighting enabled; mix long and short logical lines.
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  page.on('pageerror', e => errors.push(e.message))
  await page.route('http://127.0.0.1/split-scroll', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><style>body{margin:0}#root,.app-frame{height:100vh}</style><div id="root"><div class="app-frame"><main></main><div data-shell-overlay id="overlay-root"></div></div></div>' }))
  await page.goto('http://127.0.0.1/split-scroll')
  const names = ['alpha.js', 'beta.js', 'gamma.js', 'note-a.txt', 'note-b.txt']
  await page.evaluate(names => {
    localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode']))
    window.__worldDesktopCall = op => op === 'poll' ? new Promise(() => {}) : {}
    window.__worldWorkspaceList = async ({ path }) => ({ ok: true, value: { path, entries: names.map(name => ({ name, type: 'file' })) } })
  }, names)
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.locator('[data-world-icon-id="vscode"]').dblclick()
  const editor = page.locator('[data-world-vscode-key]'), pane = editor.locator('.world-vscode-pane:not(.is-hidden)')
  for (const name of names) {
    await page.evaluate(({ name, total }) => window.__worldTesting.setFile(`/workspace/${name}`, Array.from({ length: total }, (_, i) =>
      `const row${i + 1} = ${i}; // ${name} ${'sample '.repeat((i % 4) * 6)}`).join('\n')), { name, total })
    await editor.getByRole('button', { name, exact: true }).dblclick()
    await editor.locator(`textarea[aria-label$="${name}"]`).waitFor()
  }
  // Reading position is independent of the caret: scrolling without moving it must also survive a switch.
  const notes = names.slice(3), offsets = [3200, 7600]
  const text = name => editor.getByRole('textbox', { name: `编辑 ${name}`, exact: true })
  for (const [i, name] of notes.entries()) {
    await editor.getByRole('tab', { name }).click()
    await text(name).evaluate((el, [i, top]) => { el.focus(); el.setSelectionRange(i, i + 4, 'backward'); el.scrollTop = top }, [i, offsets[i]])
  }
  for (const [i, name] of notes.entries()) {
    await editor.getByRole('tab', { name }).click()
    assert.deepEqual(await text(name).evaluate(n => [n.scrollTop, n.selectionStart, n.selectionEnd, n.selectionDirection]), [offsets[i], i, i + 4, 'backward'])
  }
  console.log('Text tabs retained scrollTop:', offsets)
  for (const name of notes) await editor.getByRole('button', { name: `关闭标签 ${name}`, exact: true }).click()
  await editor.getByRole('tab', { name: 'alpha.js' }).click()
  await editor.locator('.world-vscode-activity-btn.is-collapse').click()
  assert.equal(await editor.locator('.world-vscode-sidebar').isVisible(), false)
  const input = pane.locator('textarea[aria-label$="alpha.js"]'), wrapButton = editor.locator('.world-vscode-status-wrap')
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable')
  const ms = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ScriptDuration').value * 1000
  const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  const snapshot = () => input.evaluate(node => {
    const content = node.closest('.world-vscode-editor-content'), box = node.getBoundingClientRect()
    const rows = [...content.querySelectorAll('.world-vscode-gutter-row')], highlights = content.querySelectorAll('.world-vscode-hl-line')
    const row = rows.find(r => { const b = r.getBoundingClientRect(); return b.top >= box.top - .5 && b.top < box.bottom })
    const line = highlights[rows.indexOf(row)]
    return { rows: rows.length, highlights: highlights.length, height: node.clientHeight, line: Number(row?.textContent),
      text: line?.textContent, aligned: row && line && Math.abs(row.getBoundingClientRect().top - line.getBoundingClientRect().top) < 1,
      last: Number(rows.at(-1)?.textContent) }
  })
  for (let n = 1; n <= 3; n++) {
    if (n > 1) {
      const target = pane.filter({ has: page.locator('textarea[aria-label$="alpha.js"]') })
      const box = await target.boundingBox()
      await editor.getByRole('tab', { name: names[n - 1] }).dragTo(target, { targetPosition: {
        x: box.width * (n === 2 ? .92 : .5), y: box.height * (n === 2 ? .5 : .92),
      } })
      await page.waitForFunction(n => document.querySelectorAll('.world-vscode-pane:not(.is-hidden) textarea').length === n, n)
    }
    for (const wrap of [false, true]) {
      if ((await wrapButton.getAttribute('aria-pressed') === 'true') !== wrap) await wrapButton.click()
      await input.evaluate(node => { node.scrollTop = 0 }); await settle()
      const peers = pane.locator('textarea:not([aria-label$="alpha.js"])')
      const peerOffsets = () => peers.evaluateAll(nodes => nodes.map(node => node.scrollTop))
      const offsets = await peerOffsets()
      // A one-pixel movement must not reposition every individual row in a split.
      const rowWrites = n === 1 ? null : await input.evaluate(async node => {
        const settle = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
        node.scrollTop = 45; await settle()
        const records = [], observer = new MutationObserver(batch => records.push(...batch))
        observer.observe(node.parentElement, { subtree: true, attributes: true, attributeFilter: ['style'] })
        node.scrollTop++; await settle(); observer.disconnect()
        return records.filter(r => r.target.matches('.world-vscode-gutter-row,.world-vscode-hl-line')).length
      })
      const before = await ms()
      await input.evaluate(async node => {
        const frame = () => new Promise(done => requestAnimationFrame(done))
        for (let i = 1; i <= 40; i++) { node.scrollTop = 7 * i; await frame(); await frame() }
      })
      const scriptMs = Math.round((await ms() - before) * 10) / 10
      await input.evaluate(node => { node.scrollTop = node.scrollHeight * .53 }); await settle()
      const middle = await snapshot()
      assert.ok(middle.line > 1 && middle.aligned && middle.text.includes(`row${middle.line} =`), JSON.stringify(middle))
      await input.evaluate(node => { node.scrollTop = node.scrollHeight }); await settle()
      assert.equal((await snapshot()).last, total)
      // Also exercise a native wheel event and the unwrapped horizontal overlay.
      await input.hover()
      const atEnd = await input.evaluate(node => node.scrollTop)
      await page.mouse.wheel(0, -160)
      await page.waitForFunction(end => document.querySelector('textarea[aria-label$="alpha.js"]').scrollTop < end, atEnd)
      await settle()
      if (!wrap && n > 1) {
        const dx = await input.evaluate(node => { node.scrollLeft = 80; return node.scrollLeft })
        await settle()
        const left = await input.evaluate(node => {
          const overlay = node.parentElement.querySelector('.world-vscode-highlight')
          return overlay.getBoundingClientRect().left - overlay.querySelector('.world-vscode-hl-line').getBoundingClientRect().left
        })
        assert.ok(dx > 0 && Math.abs(dx - left) < 1, `horizontal highlight offset: expected ${dx}, got ${left}`)
      }
      assert.deepEqual(await peerOffsets(), offsets)
      reports.push({ panes: n, wrap, scriptMs, rowWrites, rows: middle.rows, highlights: middle.highlights, height: middle.height })
      console.log(reports.at(-1))
    }
  }
  const out = resolve(root, 'tmp/performance'); await mkdir(out, { recursive: true })
  await page.screenshot({ path: resolve(out, 'split-scroll.png') })
  await writeFile(resolve(out, 'split-scroll.json'), JSON.stringify(reports, null, 2))
  assert.deepEqual(errors, [])
  for (const r of reports) {
    if (r.panes > 1) assert.equal(r.rowWrites, 0, 'pixel scrolling moves the layers, not each line')
    assert.ok(r.rows <= Math.ceil(r.height / 20) + 18 && r.rows === r.highlights, `render only the viewport plus overscan: ${JSON.stringify(r)}`)
  }
} finally { await browser.close() }
