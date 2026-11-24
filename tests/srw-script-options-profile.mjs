import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

// Run directly with Node. Diagnostic A/B only: both arms use the same live parsed
// model, canvas, editor and native <select>. Default: legacy vs batched with ALL
// options; --single-option reproduces the original legacy vs one-option diagnostic.
const singleOption = process.argv.includes('--single-option')
const root = resolve(import.meta.dirname, '..'), out = join(root, 'tmp', 'performance')
const require = createRequire(join(root, '../workflow-studio/package.json'))
const { build } = require('esbuild'), { chromium } = require('playwright-core')
const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true, write: false,
  format: 'iife', platform: 'browser', target: 'es2022', define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text' }, nodePaths: [join(root, '../workflow-studio/node_modules')],
  plugins: [{ name: 'object-options-control-arm', setup(b) {
    b.onLoad({ filter: /srw-designer\.js$/ }, async ({ path }) => {
      const src = await readFile(path, 'utf8'), anchor = "h(ScriptObjectSelect, { objects: model.objects, value: obj.id, onChange: e => choose(model.objects.get(e.target.value)) })"
      assert.equal(src.split(anchor).length, 2, 'object selector implementation changed; recheck the experimental control')
      const legacy = list => `h('select', { 'aria-label': '脚本对象', value: obj.id, onChange: e => choose(model.objects.get(e.target.value)) }, ${list}.map(o => h('option', { key: o.id, value: o.id }, o.name)))`
      return { contents: src.replace(anchor, `(window.__alternate ? ${singleOption ? legacy('[obj]') : anchor} : ${legacy('[...model.objects.values()]')})`), loader: 'js' }
    })
  } }],
})
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
try {
  await mkdir(out, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 }), errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('http://127.0.0.1/options-profile', r => r.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></html>' }))
  await page.goto('http://127.0.0.1/options-profile')
  await page.evaluate(() => {
    localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode']))
    window.__worldBrainCall = () => ({ sessionId: 'session-1', setupRequired: false })
    window.__worldDesktopCall = op => op === 'poll' ? new Promise(() => {}) : {}
    // A root name wider than any child keeps the closed select the same size in both arms.
    const windowName = 'w_options_profile', name = windowName + '.srw'
    const source = `global type ${windowName} from window\ninteger width = 2000\ninteger height = 90000\nend type\nevent open;return 1\nend event\n` +
      Array.from({ length: 750 }, (_, i) => `type cb_${i} from commandbutton within ${windowName}\ninteger y = ${i * 116}\ninteger height = 92\ninteger width = 457\nend type`).join('\n')
    window.__worldWorkspaceList = async ({ path }) => ({ ok: true, value: { path, parent: '', entries: [{ name, type: 'file' }] } })
    window.__worldSourceOpen = async ({ path }) => ({ ok: true, value: { path, source, encoding: 'UTF-8', eol: 'LF', version: '1', readOnly: false } })
  })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.locator('[data-world-icon-id="vscode"]').dblclick()
  await page.getByRole('button', { name: 'w_options_profile.srw', exact: true }).dblclick()
  const group = page.locator('.world-srw-panes'), tab = name => group.locator('.world-vscode-tab').filter({ has: page.getByText(name, { exact: true }) })
  const cdp = await page.context().newCDPSession(page)
  const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
  let expectedWidth
  async function trial(alternate, heap, screenshot = false, selectChanges = false) {
    await group.locator('[data-srw-object="cb_0"]').waitFor(); await settle()
    const open = tab('open')
    await open.evaluate((button, alternate) => {
      window.__alternate = alternate
      window.__ready = new Promise((resolve, reject) => {
        button.addEventListener('click', () => {
          const start = performance.now(), group = button.closest('.world-srw-panes')
          const timeout = setTimeout(() => { observer.disconnect(); reject(Error('script editor not mounted')) }, 5000)
          const observer = new MutationObserver(() => {
            const view = group.querySelector('[data-srw-view="script"]'), input = view?.querySelector('.cm-content')
            if (!input) return
            observer.disconnect(); clearTimeout(timeout)
            // Flush layout, stop before browser paint. No Playwright round-trip or option enumeration in the interval.
            const width = view.querySelector('select').getBoundingClientRect().width
            resolve({ ms: performance.now() - start, width })
          })
          observer.observe(group, { childList: true, subtree: true })
        }, { capture: true, once: true })
      })
    }, alternate)
    await open.click()
    const sample = await page.evaluate(() => window.__ready)
    expectedWidth ??= sample.width; assert.ok(sample.width > 0); assert.equal(sample.width, expectedWidth)
    const select = group.getByRole('combobox', { name: '脚本对象' })
    assert.equal(await select.evaluate(n => n.options.length), singleOption && alternate ? 1 : 751)
    assert.equal(await select.inputValue(), 'w_options_profile')
    assert.equal(await group.getByRole('textbox', { name: '编辑 w_options_profile.open' }).innerText(), 'return 1')
    if (heap) {
      await settle(); await cdp.send('HeapProfiler.collectGarbage')
      sample.heap = (await cdp.send('Runtime.getHeapUsage')).usedSize
      sample.nodes = (await cdp.send('Memory.getDOMCounters')).nodes
    }
    if (screenshot) await group.locator('[data-srw-view=script] > nav').screenshot({ path: join(out, `srw-options-${alternate ? (singleOption ? 'one' : 'batched') : 'legacy'}.png`) })
    if (selectChanges) {
      // Compare already-mounted lists separately. Switch between two controls without scripts,
      // so editor construction/destruction is not included in the measured interval.
      sample.changesMs = await select.evaluate(async s => {
        const properties = s.closest('.world-srw-panes').querySelector('[data-srw-view=properties]')
        const choose = async id => {
          s.value = id; s.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve()
          if (properties.querySelector('dd')?.textContent !== id) throw Error(`selection not committed: ${id}`)
        }
        await choose('cb_1')
        const start = performance.now()
        for (let i = 0; i < 20; i++) await choose(i % 2 ? 'cb_1' : 'cb_749')
        properties.getBoundingClientRect()
        const ms = performance.now() - start
        await choose('w_options_profile')
        return ms
      })
    }
    await tab('Layout').click()
    return sample
  }
  const timings = [], memory = []
  // Alternate which arm goes first. Warm both; collect memory separately so forced GCs don't skew timings.
  for (let i = 0; i < 4 + 24 + 6; i++) {
    const heap = i >= 28, pair = {}
    for (const alternate of i % 2 ? [true, false] : [false, true]) pair[alternate ? 'alternate' : 'legacy'] = await trial(alternate, heap, i === 33)
    if (i >= 4) (heap ? memory : timings).push(pair)
  }
  const delta = (pairs, key) => median(pairs.map(p => p.legacy[key] - p.alternate[key]))
  const summary = { timingPairs: timings.length, alternate: singleOption ? 'single option' : 'batched full list', legacyMs: median(timings.map(p => p.legacy.ms)), alternateMs: median(timings.map(p => p.alternate.ms)),
    pairedDeltaMs: delta(timings, 'ms'), memoryPairs: memory.length, pairedDeltaHeapBytes: delta(memory, 'heap'), pairedDeltaDOMNodes: delta(memory, 'nodes') }
  const changes = []
  if (!singleOption) {
    for (let i = 0; i < 10; i++) {
      const pair = {}
      for (const alternate of i % 2 ? [true, false] : [false, true]) pair[alternate ? 'alternate' : 'legacy'] = await trial(alternate, false, false, true)
      if (i >= 2) changes.push(pair)
    }
    summary.twentyChanges = { pairs: changes.length, legacyMs: median(changes.map(p => p.legacy.changesMs)),
      batchedMs: median(changes.map(p => p.alternate.changesMs)), pairedDeltaMs: delta(changes, 'changesMs') }
  }
  assert.deepEqual(errors, [])
  await writeFile(join(out, singleOption ? 'srw-script-options.json' : 'srw-script-options-batched.json'), JSON.stringify({ browser: browser.version(), summary, timings, memory, changes }, null, 2))
  console.log(summary)
} finally { await browser.close() }
