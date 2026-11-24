import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

// Diagnostic, run directly with Node. Do not put machine-dependent time/heap thresholds in CI.
const root = resolve(import.meta.dirname, '..'), out = join(root, 'tmp', 'performance')
const require = createRequire(join(root, '../workflow-studio/package.json'))
const { build } = require('esbuild'), { chromium } = require('playwright-core')
const bundle = await build({ absWorkingDir: root, bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'text' }, nodePaths: [join(root, '../workflow-studio/node_modules')],
  stdin: { resolveDir: root, contents: `import './tests/browser-entry.js'; import { Text } from '@codemirror/state'; import { EditorView } from '@codemirror/view';
    const flat = Text.prototype.toString;
    Text.prototype.toString = function() { if (this.length === window.profileLength) window.profileStats.flattens++; return flat.call(this) };
    window.profileSelection = () => { const { from, to } = EditorView.findFromDOM(document.querySelector('.world-vscode-large .cm-content')).state.selection.main; return [from, to] };` },
  plugins: [{ name: 'count-search-work', setup(b) {
    b.onResolve({ filter: /^\.\/text-find\.js$/ }, ({ importer }) => importer.endsWith('vscode-app.js') ? { path: 'probe', namespace: 'find-profile' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'find-profile' }, () => ({ resolveDir: root, contents: `
      export * from './text-find.js'; import { findTextOffsets as find } from './text-find.js';
      export function findTextOffsets(...args) { const result = find(...args); if (args[1]) { window.profileStats.searches++; window.profileStats.matches += result.length } return result }` }))
  } }],
})
const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }), errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('http://127.0.0.1/find-profile', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><style>body{margin:0}#root{width:100vw;height:100vh}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></html>' }))
  await page.goto('http://127.0.0.1/find-profile')
  const fixture = await page.evaluate(() => {
    localStorage.setItem('dsh.world.apps', '["vscode"]')
    window.__worldBrainCall = () => ({ sessionId: 'session-1', setupRequired: false })
    window.__worldDesktopCall = op => op === 'poll' ? new Promise(() => {}) : {}
    const name = 'w_find.srw', header = 'global type w_find from window\nend type\nevent open;\nstring ls_line\n'
    const rows = Array.from({ length: 50000 }, (_, i) => `ls_line = "${i % 500 ? 'probeA' : 'probeZ'}:${String(i).padStart(5, '0')}" // ordinary row\n`)
    const source = header + rows.join('') + 'end event'
    window.profileLength = source.length; window.profileStats = { flattens: 0, searches: 0, matches: 0 }
    window.__worldWorkspaceList = async ({ path }) => ({ ok: true, value: { path, parent: '', entries: [{ name, type: 'file' }] } })
    window.__worldSourceOpen = async ({ path }) => ({ ok: true, value: { path, source, encoding: 'UTF-8', eol: 'LF', version: '1', readOnly: false } })
    return { rows: rows.length, bytes: source.length, first: source.indexOf('probeZ'), stride: rows[0].length }
  })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.locator('[data-world-icon-id="vscode"]').dblclick()
  await page.getByRole('button', { name: 'w_find.srw', exact: true }).dblclick()
  await page.locator('[data-parent-tab]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '切换回源代码', exact: true }).click()
  const source = page.locator('.world-vscode-large .cm-content'), bar = page.getByRole('search', { name: '当前文件查找替换' })
  const find = bar.getByRole('textbox', { name: '当前文件查找', exact: true }), status = bar.getByRole('status')
  await source.waitFor()
  const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable')
  const taskTime = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'TaskDuration').value
  const measure = async action => {
    await settle(); await page.evaluate(() => { window.profileStats = { flattens: 0, searches: 0, matches: 0 } })
    const start = await taskTime(); await action(); await settle()
    const taskMs = (await taskTime() - start) * 1000
    return { taskMs, ...await page.evaluate(() => window.profileStats) }
  }
  const open = async () => { await source.press('Control+Home'); await source.press('Control+f'); await find.focus() }
  const close = async () => { await find.press('Escape'); await bar.waitFor({ state: 'detached' }) }
  const verify = async (count, offset) => {
    assert.equal(await status.textContent(), count)
    assert.deepEqual(await page.evaluate(() => window.profileSelection()), [offset, offset + 'probeZ'.length])
  }
  const times = [], memory = []
  for (let i = 0; i < 14; i++) {
    if (i === 0) assert.equal((await measure(open)).flattens, 0, 'first Ctrl+F can use the loaded source')
    else await open()
    await find.fill(''); await find.focus()
    const type = await measure(() => page.keyboard.type('probeZ'))
    await verify('1/100', fixture.first)
    const next = await measure(async () => { for (let n = 0; n < 20; n++) await page.keyboard.press('Enter') })
    const after = fixture.first + 20 * 500 * fixture.stride
    await verify('21/100', after)
    await close()
    const reopen = await measure(() => page.keyboard.press('Control+f'))
    assert.equal(reopen.flattens, 0, 'selection and viewport updates must not invalidate the document snapshot')
    await verify('21/100', after); await close()
    if (i >= 2) times.push({ type, next, reopen })
  }
  // Compare each query to its own no-match baseline. Two distinct misses commit new search results
  // on both React fibers before GC; otherwise a preceding dense query can contaminate the rare arm.
  const heap = async () => { await settle(); await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize }
  for (let i = 0; i < 6; i++) {
    await open(); const sample = {}
    for (const dense of i % 2 ? [false, true] : [true, false]) {
      await find.fill('absent_first'); await find.fill('absent_second')
      assert.equal(await status.textContent(), '无匹配')
      const baseline = await heap()
      await find.fill(dense ? 'probe' : 'probeZ'); await settle()
      assert.ok((await status.textContent()).endsWith(dense ? '/20000+' : '/100'))
      sample[dense ? 'dense' : 'rare'] = { baseline, used: await heap() }
    }
    await close(); sample.closed = await heap(); memory.push(sample)
  }
  const summary = Object.fromEntries(['type', 'next', 'reopen'].map(key => [key, Object.fromEntries(Object.keys(times[0][key]).map(k => [k, median(times.map(row => row[key][k]))]))]))
  summary.denseMinusRareHeapBytes = median(memory.map(({ dense, rare }) => (dense.used - dense.baseline) - (rare.used - rare.baseline)))
  summary.closedHeapRange = [Math.min(...memory.map(x => x.closed)), Math.max(...memory.map(x => x.closed))]
  await open(); await find.fill('probe'); await settle()
  assert.equal(await status.textContent(), '1/20000+')
  await mkdir(out, { recursive: true }); await bar.screenshot({ path: join(out, 'srw-find-dense.png') })
  // Same length as the original so the flatten counter and UTF-16 offsets still apply.
  await find.fill('probeZ'); await verify('1/100', fixture.first); await close()
  await page.keyboard.insertText('probeX')
  assert.equal((await measure(open)).flattens, 1, 'first find after an edit reads the new document once')
  assert.equal(await status.textContent(), '1/99')
  await find.fill('probeX'); await verify('1/1', fixture.first); await close()
  assert.equal((await measure(() => source.press('Control+f'))).flattens, 0, 'reuse the edited snapshot')
  await verify('1/1', fixture.first); await close()
  await source.press('Control+z'); assert.equal((await measure(open)).flattens, 1, 'undo invalidates the edited snapshot')
  await find.fill('probeX'); assert.equal(await status.textContent(), '无匹配')
  await find.fill('probeZ'); await verify('1/100', fixture.first)
  assert.deepEqual(errors, [])
  await writeFile(join(out, 'srw-find.json'), JSON.stringify({ browser: browser.version(), fixture, summary, times, memory }, null, 2))
  console.log(JSON.stringify({ fixture, summary, timingRounds: times.length, memoryPairs: memory.length }, null, 2))
} finally { await browser.close() }
