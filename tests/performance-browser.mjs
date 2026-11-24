import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
// Compare identical gestures with production React. Timings are diagnostic;
// window-drag-browser.mjs guards geometry, drafts and bounded render counts.
const root = resolve(import.meta.dirname, '..')
const report = process.argv[2] || 'current'
if (!/^[a-zA-Z0-9_-]+$/u.test(report)) throw new Error('Use a simple report name, e.g. before or after')
const output = join(root, 'tmp', 'performance')
await mkdir(output, { recursive: true })
const require = createRequire(join(root, '../workflow-studio/package.json'))
const { build } = require('esbuild'), { chromium } = require('playwright-core')
const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/performance-entry.js'], bundle: true,
  format: 'iife', platform: 'browser', target: 'es2022', write: false, define: { 'process.env.NODE_ENV': '"production"' },
  nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' } })
const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
const results = []
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', e => errors.push(e.message))
  await page.route('http://127.0.0.1/world-profile', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
  await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
  await page.goto('http://127.0.0.1/world-profile')
  await page.evaluate(() => {
    localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode', 'terminal']))
    // No assistant commands in this fixture: keep the poll pending like the real mailbox.
    window.__worldDesktopCall = op => op === 'poll' ? new Promise(() => {}) : {}
    window.__commits = 0
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, inject: () => 1,
      onCommitFiberRoot: () => { window.__commits++ }, onCommitFiberUnmount() {} }
  })
  await page.addScriptTag({ content: bundle.outputFiles[0].text + '\n//# sourceURL=world-profile.js' })
  await page.locator('[data-world-icon-id="vscode"]').dblclick()
  await page.getByRole('button', { name: 'src', exact: true }).click()
  await page.evaluate(() => window.__worldTesting.setFile('/workspace/src/main.js',
    Array.from({length: 2000}, (_, i) => `const value${i} = ${i}; // performance fixture`).join('\n')))
  await page.getByRole('button', { name: 'main.js', exact: true }).click()
  const input = page.locator('.world-vscode-textarea')
  await input.waitFor()
  await page.waitForTimeout(400)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await cdp.send('Profiler.enable')
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
  async function measure(name, act) {
    await page.evaluate(() => { window.__commits = 0 })
    const before = await metrics()
    await cdp.send('Profiler.start')
    await act()
    const after = await metrics()
    const { profile } = await cdp.send('Profiler.stop')
    const nodes = new Map(profile.nodes.map(n => [n.id, n])), times = new Map()
    profile.samples.forEach((id, i) => { const node = nodes.get(id), name = node.callFrame.functionName || '(anonymous)'; times.set(name, (times.get(name) || 0) + profile.timeDeltas[i]) })
    const result = { name, commits: await page.evaluate(() => window.__commits),
      metrics: Object.fromEntries(['ScriptDuration','TaskDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount']
        .map(k => [k, +(after[k] - before[k]).toFixed(4)])),
      hot: [...times].sort((a,b) => b[1]-a[1]).slice(0,14).map(([name,us])=>({name,ms:+(us/1000).toFixed(1)})) }
    results.push(result); console.log(JSON.stringify(result))
    await writeFile(join(output, `${report}-${name}.cpuprofile`), JSON.stringify(profile))
  }
  await measure('idle', () => page.waitForTimeout(1200))
  const bar = await page.locator('.world-vscode-titlebar').boundingBox()
  await page.mouse.move(bar.x+150, bar.y+20)
  await page.mouse.down()
  await page.waitForTimeout(100)
  await measure('drag', async () => {
    for (let i=1;i<=60;i++) await page.mouse.move(bar.x+150+i*2, bar.y+20+i)
  })
  await page.mouse.up()
  await input.click()
  await page.keyboard.press('Control+End')
  await measure('typing', () => page.keyboard.type('abcdefghijklmnopqrstuvwx123456'))
  await measure('scroll', async () => {
    for (let i=0;i<40;i++) { await input.evaluate((n, y) => { n.scrollTop = y; n.dispatchEvent(new Event('scroll', { bubbles: true })) }, i*500); await page.waitForTimeout(16) }
  })
  assert.ok((await input.inputValue()).endsWith('abcdefghijklmnopqrstuvwx123456'), 'typed characters must be retained')
  await page.screenshot({ path: join(output, `${report}.png`) })
  // Instrument real rows without a timer or a render hook in production code. A
  // nested file with no explicit path gets one path lookup when TreeNode renders it.
  await page.evaluate(() => {
    window.__explorerRows = 0
    window.__worldWorkspaceList = ({ path }) => path === '/workspace/src' ? { ok: true, value: { path, entries: [
      { name: 'main.js', type: 'file' }, ...Array.from({ length: 300 }, (_, i) => ({
        name: `sibling-${i}.js`, type: 'file', get path() { window.__explorerRows++; return undefined },
      })),
    ] } } : null
  })
  await page.getByRole('button', { name: '刷新目录', exact: true }).click()
  const lastSibling = page.getByRole('button', { name: 'sibling-299.js', exact: true })
  await lastSibling.waitFor({ state: 'attached' })
  assert.ok(await page.evaluate(() => window.__explorerRows >= 300), 'the expanded rows really rendered')
  await input.focus(); await input.press('Control+End')
  const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  async function explorerReads(name, act) {
    await settle(); await page.evaluate(() => { window.__explorerRows = 0 })
    await measure(name, async () => { await act(); await settle() })
    const reads = await page.evaluate(() => window.__explorerRows)
    results.at(-1).explorerRowReads = reads
    console.log(`${name}: ${reads} explorer row reads`)
    return reads
  }
  const typed = await explorerReads('explorer-typing', () => input.pressSequentially('abcdefghijklmnopqrstuvwx'))
  const scrolled = await explorerReads('explorer-scroll', () => input.evaluate(async node => {
    for (let i = 0; i < 40; i++) {
      node.scrollTop = i * 500
      await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
    }
  }))
  assert.ok((await input.inputValue()).endsWith('abcdefghijklmnopqrstuvwx'))
  assert.ok(await input.evaluate(node => node.scrollTop >= 19000))
  await page.screenshot({ path: join(output, `${report}-explorer.png`) })
  assert.deepEqual([typed, scrolled], [0, 0], 'editing must not rebuild unchanged explorer rows')
  // Cached actions must still see the current expansion state and current file selection.
  const src = page.getByRole('button', { name: 'src', exact: true })
  await src.click(); await lastSibling.waitFor({ state: 'detached' })
  await src.click(); await lastSibling.click()
  assert.equal(await lastSibling.evaluate(node => node.classList.contains('selected')), true)
  await page.getByRole('button', { name: 'main.js', exact: true }).first().click()
  assert.ok((await input.inputValue()).endsWith('abcdefghijklmnopqrstuvwx'))
  await input.focus()
  // A real result group can contain 50 rows; the sidebar opens six groups by default.
  // Observe whether unchanged match ranges get traversed again while interacting with the editor.
  await page.evaluate(() => {
    window.__rangeReads = 0
    window.__worldContentSearch = async ({ query }) => {
      if (query === 'pending') await new Promise(resolve => { window.__releasePending = resolve })
      const files = Array.from({ length: 6 }, (_, group) => ({ path: group ? `file${group}.js` : 'src/main.js',
        matches: Array.from({ length: 50 }, (_, i) => ({ line: i + 1, column: 6, text: `const value${i} = ${i};`,
          get ranges() { window.__rangeReads++; return query === 'const' ? [[0, 5]] : [[6, 11]] } })) }))
      return { ok: true, value: { query, files, fileCount: 6, total: 300, scanned: 6 } }
    }
  })
  await page.keyboard.press('Control+Shift+f')
  const search = page.locator('.world-vscode-search-input')
  await search.fill('value')
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-search-hit').length === 300)
  const readsDuring = async (name, act) => {
    await page.evaluate(() => { window.__rangeReads = 0 })
    await measure(name, act)
    const reads = await page.evaluate(() => window.__rangeReads)
    results.at(-1).matchRangeReads = reads
    console.log(`${name}: ${reads} match range reads`)
    return reads
  }
  const scrollReads = await readsDuring('search-scroll', async () => {
    await input.evaluate(async node => {
      const frame = () => new Promise(done => requestAnimationFrame(done))
      for (let i = 0; i < 40; i++) { node.scrollTop = i * 500; await frame(); await frame() }
    })
  })
  assert.match(await page.locator('.world-vscode-highlight-rows').innerText(), /value975\b/)
  await input.press('Control+Home'); await input.press('Control+f')
  const find = page.locator('.world-vscode-findbar input').first()
  await find.fill('')
  const findReads = await readsDuring('search-find', async () => {
    await find.pressSequentially('value1999')
    await page.locator('.world-vscode-findbar [role="status"]').filter({ hasText: '1/1' }).waitFor()
    await page.waitForFunction(() => document.querySelector('.world-vscode-highlight-rows')?.textContent.includes('value1999'))
  })
  assert.equal(await input.evaluate(node => node.value.slice(node.selectionStart, node.selectionEnd)), 'value1999')
  await find.press('Escape')
  assert.deepEqual([scrollReads, findReads], [0, 0], 'unchanged workspace search hits should not be rebuilt')
  // Cached rows still invoke the current editor action and refresh on a new RPC response.
  const group = page.locator('.world-vscode-search-file').first()
  const heading = group.locator('.world-vscode-search-file-head')
  await heading.click(); assert.equal(await group.locator('.world-vscode-search-hit').count(), 0)
  await heading.click(); await group.locator('.world-vscode-search-hit').last().click()
  await page.waitForFunction(() => {
    const node = document.querySelector('.world-vscode-textarea')
    return node.value.slice(node.selectionStart).startsWith('value49')
  })
  await search.fill('pending')
  assert.equal(await page.locator('.world-vscode-search-file').count(), 0, 'editing clears all old groups before the next reply')
  assert.doesNotMatch(await page.locator('.world-vscode-search-summary').textContent(), /300 个结果/u)
  await page.waitForFunction(() => typeof window.__releasePending === 'function')
  await search.press('Escape')
  await page.evaluate(async () => { window.__releasePending(); await new Promise(requestAnimationFrame) })
  assert.equal(await search.inputValue(), '')
  assert.equal(await page.locator('.world-vscode-search-hit').count(), 0, 'a late reply cannot restore the cleared results')
  await search.fill('const')
  await page.waitForFunction(() => document.querySelector('.world-vscode-search-text mark')?.textContent === 'const')
  // Count window style reads, not FPS: hidden desktop decorations must cost nothing
  // on pointer movement, regardless of how many real editor windows are mounted.
  await page.evaluate(() => {
    const original = window.getComputedStyle
    window.getComputedStyle = function (element, ...args) {
      if (element.hasAttribute?.('data-world-vscode-key')) window.__windowReads++
      // 深度走位时也不许逐帧问「贴着哪扇窗」：那是一次 getComputedStyle × 每扇窗口/图标
      if (element.matches?.('.world-window-frame, .world-vscode-window, .world-plugin-window, .world-external-window, .world-desktop-icon, .world-icons')) {
        window.__frameReads = (window.__frameReads || 0) + 1
      }
      return original.call(window, element, ...args)
    }
  })
  async function pointerSweep(count, label) {
    assert.equal(await page.locator('[data-world-vscode-key]').count(), count)
    await page.mouse.move(680, 500)
    await page.waitForTimeout(200)
    await page.evaluate(() => { window.__windowReads = 0 })
    await measure(label, async () => {
      for (let i = 1; i <= 60; i++) await page.mouse.move(680 + i * 2, 500)
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
    })
    const reads = await page.evaluate(() => window.__windowReads)
    console.log(`${label}: ${reads} editor window style reads`)
    return reads
  }
  const single = await pointerSweep(1, 'flat-1-window')
  for (let i = 2; i <= 8; i++) {
    await page.evaluate(i => localStorage.setItem('dsh.world.vscode.folders', JSON.stringify([`/work-${i}`])), i)
    await page.locator('[data-world-icon-id="vscode"]').dispatchEvent('dblclick')
    await page.waitForFunction(n => document.querySelectorAll('[data-world-vscode-key]').length === n, i)
  }
  const many = await pointerSweep(8, 'flat-8-windows')
  await page.locator('.world-depth-toggle').click()
  await page.locator('.world-walker').waitFor({ state: 'visible' })
  await page.mouse.move(1370, 830)
  await page.waitForFunction(() => document.querySelector('.world-walker')?.dataset.walking === 'on')
  // 走位是一帧一次的循环：上一帧刚写过 transform，此时再读窗口样式就是强制同步样式计算。
  // 指针没动就不该再问一遍「贴着哪扇窗」——八扇窗时这是每帧八次 getComputedStyle。
  await page.evaluate(() => { window.__frameReads = 0 })
  await page.waitForTimeout(900)
  const walkingReads = await page.evaluate(() => window.__frameReads)
  console.log(`depth walking: ${walkingReads} desktop frame style reads`)
  assert.equal(walkingReads, 0, 'walking must not re-inspect window styles every frame')
  await page.locator('.world-depth-toggle').click()
  await page.locator('.world-walker').waitFor({ state: 'hidden' })
  const offAgain = await pointerSweep(8, 'flat-8-after-toggle')
  assert.deepEqual(errors, [])
  assert.deepEqual([single, many, offAgain], [0, 0, 0], 'flat desktop pointer moves must not inspect editor window styles')
  // Open the other independent desktop apps alongside the eight editors. A taskbar
  // activation must update the window chrome, not render unrelated plugin pages.
  await page.route('http://127.0.0.1:53317/**', route => route.fulfill({ body: 'Chat fixture' }))
  await page.locator('[data-world-app-card="lanchat"] .world-app-install').dispatchEvent('click')
  await page.locator('[data-world-icon-id="dsh"]').dispatchEvent('dblclick')
  await page.evaluate(() => {
    window.__worldProcessesCall = async () => ({ ok: true, value: { rootPid: 10, timestamp: Date.now(), rows: [],
      totals: { count: 0, cpu: 0, workingSet: 0 } } })
  })
  for (const key of ['terminal', 'browser', 'lanchat', 'world-diary', 'world-trash', 'world-tasks', 'world-settings', 'world-internet', 'world-processes']) {
    await page.locator(`[data-world-app-card="${key}"] .world-app-open`).dispatchEvent('click')
  }
  for (const key of ['workflow-studio', 'assessment']) {
    await page.locator(`[data-world-plugin-card="${key}"]`).dispatchEvent('click')
  }
  const windows = await page.locator('[data-world-taskbar]').count()
  assert.equal(windows, 20)
  const probe = page.locator('[data-probe-page="assessment"]')
  await probe.click()
  assert.equal(await probe.innerText(), '1')
  const renders = () => page.evaluate(() => ({ ...window.__pluginRenders }))
  const beforeSwitch = await renders()
  await measure('all-apps-switch', async () => {
    for (let i = 0; i < 12; i++) {
      const id = `plugin:${i % 2 ? 'assessment' : 'workflow-studio'}`
      await page.locator(`[data-world-taskbar="${id}"]`).dispatchEvent('click')
      await page.waitForFunction(id => document.body.dataset.worldActiveWindow === id, id)
    }
  })
  const afterSwitch = await renders()
  const pageRenders = Object.fromEntries(Object.keys(beforeSwitch).map(k => [k, afterSwitch[k] - beforeSwitch[k]]))
  Object.assign(results.at(-1), { windows, switches: 12, pageRenders })
  console.log('All-apps switch: ' + JSON.stringify({ windows, switches: 12, pageRenders }))
  await page.screenshot({ path: join(output, `${report}-all-apps.png`) })
  assert.deepEqual(pageRenders, { 'workflow-studio': 0, assessment: 0 })
  assert.equal(await probe.innerText(), '1', 'switching windows retains plugin state')
  await probe.click(); assert.equal(await probe.innerText(), '2', 'plugin-owned updates still render')
  assert.deepEqual(errors, [])
  // A full-screen editor hides the manager, not just its focus. A normal or
  // pinned manager that can still be seen must keep sampling on the same cadence.
  const manager = page.locator('[data-world-plugin="world-processes"]')
  const managerTask = page.locator('[data-world-taskbar="plugin:world-processes"]')
  const editorTask = page.locator('[data-world-taskbar^="vscode:"]').first()
  const editor = page.locator('[data-world-vscode-key]').first(), title = editor.locator('.world-vscode-titlebar')
  const sampleCount = () => page.evaluate(() => window.__worldTesting.calls.filter(c => c.method === 'world-processes/snapshot').length)
  const nextSample = n => page.waitForFunction(n => window.__worldTesting.calls.filter(c => c.method === 'world-processes/snapshot').length > n, n, { timeout: 4500 })
  await editorTask.dispatchEvent('click')
  await nextSample(await sampleCount()) // losing focus alone does not pause it
  await title.dispatchEvent('dblclick'); await editor.and(page.locator('.is-max')).waitFor()
  const foreground = await editor.boundingBox(), background = await manager.boundingBox()
  assert.ok(foreground.x <= background.x && foreground.y <= background.y && foreground.x + foreground.width >= background.x + background.width && foreground.y + foreground.height >= background.y + background.height)
  const callStart = await page.evaluate(() => window.__worldTesting.calls.length)
  await measure('all-apps-covered-idle', () => page.waitForTimeout(6200))
  const idleCalls = await page.evaluate(start => {
    const counts = {}
    for (const { method } of window.__worldTesting.calls.slice(start)) counts[method] = (counts[method] || 0) + 1
    return counts
  }, callStart)
  const snapshots = idleCalls['world-processes/snapshot'] || 0
  Object.assign(results.at(-1), { windows, idleMs: 6200, idleCalls, snapshots })
  console.log('Covered manager idle:', JSON.stringify({ windows, snapshots, idleCalls }))
  await page.screenshot({ path: join(output, `${report}-covered.png`) })
  assert.equal(snapshots, 0, 'a fully covered manager must not start native sampling')
  const coveredCount = await sampleCount()
  await title.dispatchEvent('dblclick'); await nextSample(coveredCount) // uncover without focusing the manager
  await managerTask.dispatchEvent('click'); await manager.locator('.world-pin-cap').dispatchEvent('click')
  await editorTask.dispatchEvent('click'); await title.dispatchEvent('dblclick')
  assert.ok(await manager.evaluate((n, key) => +n.style.zIndex > +document.querySelector(`[data-world-vscode-key="${key}"]`).style.zIndex, await editor.getAttribute('data-world-vscode-key')))
  await nextSample(await sampleCount())
  // On mobile only the active app is displayed. A desktop pin must neither keep
  // the hidden manager running nor suppress it once it is the visible phone app.
  await editor.locator('.world-pin-cap').dispatchEvent('click')
  await page.setViewportSize({ width: 390, height: 844 }); await manager.waitFor({ state: 'hidden' })
  const hiddenPhone = await sampleCount(); await page.waitForTimeout(2200)
  assert.equal(await sampleCount(), hiddenPhone)
  await page.getByRole('button', { name: '切换应用', exact: true }).click()
  await page.locator('[data-world-phone-window="plugin:world-processes"]').click(); await manager.waitFor()
  await manager.locator('.world-pin-cap').dispatchEvent('click') // below the pinned editor in desktop order
  await nextSample(await sampleCount())
  assert.deepEqual(errors, [])
  await writeFile(join(output, `${report}.json`), JSON.stringify(results,null,2))
} finally { await browser.close() }
