import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { join, resolve } from 'node:path'
import { mkdir, mkdtemp, open, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createVscodeSourceEditor } from '../source-editor.js'

// Opt-in stress test; ordinary unit runs do not open a two-million-line browser tab.
const root = resolve(import.meta.dirname, '..'), total = 2_000_000
const harness = process.env.DSH_SOURCE || 'E:/deepseek-harness'
const modules = { '@deepseek-ai/dsh-fs': 'packages/fs/fs/lib/index.js', '@deepseek-ai/dsh-sandbox': 'packages/sandbox/sandbox/lib/index.js' }
const load = path => import(pathToFileURL(join(harness, path)).href)
registerHooks({ resolve(name, context, next) { return modules[name] ? { url: pathToFileURL(join(harness, modules[name])).href, shortCircuit: true } : next(name, context) } })
const { Context } = await load('vendor/cordis/lib/index.js'), { default: LocalFs } = await load('packages/fs/fs-local/lib/index.js')
const { FsError } = await load(modules['@deepseek-ai/dsh-fs'])
const require = createRequire(join(root, '../workflow-studio/package.json')), { chromium } = require('playwright-core')
const bundle = await require('esbuild').build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true, format: 'iife',
  platform: 'browser', target: 'es2022', write: false, define: { 'process.env.NODE_ENV': '"production"' },
  nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' } })
const out = join(root, 'tmp/performance'); await mkdir(out, { recursive: true })
const dir = await mkdtemp(join(out, 'million-')), path = join(dir, 'numbers.txt'), file = await open(path, 'wx')
// Measure real wheel events up to the first aligned gutter DOM update, not monitor latency.
async function wheelLatency(page, locator, experimental) {
  await locator.evaluate(async node => {
    node.scrollTop = 0; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
  await locator.hover()
  await locator.evaluate((node, { experimental, total }) => {
    const layer = experimental ? node.nextElementSibling : node
    const h = parseFloat(getComputedStyle(node).lineHeight), times = []
    let start = null, acknowledged = node.scrollTop, lastLine = 0, frame = 0
    const firstAligned = () => {
      const top = node.getBoundingClientRect().top
      const row = [...node.querySelectorAll('.cm-line')].find(r => r.getBoundingClientRect().top >= top)
      if (!row || row.getBoundingClientRect().top >= node.getBoundingClientRect().bottom) return 0
      return [...node.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].some(g =>
        g.textContent === row.textContent && Math.abs(g.getBoundingClientRect().top - row.getBoundingClientRect().top) < 1) ? +row.textContent : 0
    }
    if (!experimental) lastLine = firstAligned()
    const wheel = () => { start = performance.now(); frame = requestAnimationFrame(tick) }
    const tick = () => { frame = 0; check(); if (start !== null) frame = requestAnimationFrame(tick) }
    const check = () => {
      if (start === null || node.scrollTop === acknowledged) return
      if (experimental) {
        const row = layer.firstElementChild, line = Number(row.dataset.line)
        const actual = (line - 1) * h - (row.getBoundingClientRect().top - node.getBoundingClientRect().top)
        const expected = node.scrollTop / (node.scrollHeight - node.clientHeight) * (total * h - node.clientHeight)
        if (Math.abs(actual - expected) > 1) return
      } else {
        const line = firstAligned()
        if (!line || lastLine === line) return
        lastLine = line
      }
      times.push(performance.now() - start); acknowledged = node.scrollTop; start = null
      cancelAnimationFrame(frame)
    }
    const observer = new MutationObserver(check)
    observer.observe(layer, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] })
    node.addEventListener('wheel', wheel, { passive: true }); node.addEventListener('scroll', check)
    window.__wheelSamples = times
    window.__stopWheel = () => { observer.disconnect(); node.removeEventListener('wheel', wheel); node.removeEventListener('scroll', check) }
  }, { experimental, total })
  for (let i = 1; i <= 20; i++) {
    await page.mouse.wheel(0, 120)
    await page.waitForFunction(n => window.__wheelSamples.length === n, i, { timeout: 10000 })
  }
  const samples = await page.evaluate(() => { window.__stopWheel(); return window.__wheelSamples })
  samples.sort((a, b) => a - b)
  console.log(experimental ? 'Probe wheel to aligned DOM (ms)' : 'Editor wheel to aligned DOM (ms)',
    { count: samples.length, p50: +samples[9].toFixed(1), p95: +samples[18].toFixed(1), max: +samples[19].toFixed(1) })
}
const context = new Context(); let browser, service
try {
  try {
    for (let i = 1; i <= total; i += 32768) {
      const rows = Array.from({length: Math.min(32768, total - i + 1)}, (_, j) => String(i + j))
      await file.writeFile((i > 1 ? '\n' : '') + rows.join('\n'))
    }
  } finally { await file.close() }
  await writeFile(join(dir, 'small.txt'), 'ordinary editable file')
  // 1–8 MiB：走虚拟化视图，但仍然可编辑（textarea 在这个尺寸每键要 9ms 重排）
  await writeFile(join(dir, 'medium.txt'), Array.from({ length: 30000 }, (_, i) => `const value${i} = ${i}; // medium fixture`).join('\n'))
  await context.plugin(LocalFs, { cwd: dir })
  const session = { header: { cwd: dir } }
  service = createVscodeSourceEditor({ fs: context.fs, sessions: { get: id => id === 'session-1' ? session : undefined }, get: () => undefined,
    // 保存要过沙箱策略：这个夹具直接给完全访问，和真实宿主的 danger-full-access 同义
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) } }, { FsError })
  browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } }); const errors = []
  page.on('pageerror', e => errors.push(e.message)); page.on('crash', () => console.error('Editor renderer crashed'))
  await page.route('http://127.0.0.1/million', route => route.fulfill({contentType: 'text/html',body: '<!doctype html><style>body{margin:0}#root,.app-frame{height:100vh}</style><div id="root"><div class="app-frame"><main></main><div id="overlay-root" data-shell-overlay></div></div></div>'}))
  await page.exposeBinding('__worldWorkspaceList', (_, params) => service.call('list', params).then(value => ({ok:true,value})))
  const openDocument = async (_, params) => {
    const t = performance.now(), value = await service.call('open', params)
    assert.equal(value.source.length, (await stat(value.path)).size)
    if (value.path.endsWith('numbers.txt')) assert.ok(value.source.startsWith('1\n2\n') && value.source.endsWith('\n2000000'))
    console.log('File bytes:', value.source.length, 'real backend open ms:', Math.round(performance.now()-t))
    return {ok:true,value}
  }
  const memory = process.argv.includes('--memory')
  if (memory) {
    // Do not inject 15 MB of evaluated JS per RPC: compiled Playwright binding replies
    // can stay in V8's script cache and contaminate a renderer retention test.
    await page.route('http://127.0.0.1/memory-file', async route => route.fulfill({json: await openDocument(null, route.request().postDataJSON())}))
  } else await page.exposeBinding('__worldSourceOpen', openDocument)
  // 存盘走真实服务：可编辑的大文件必须真的落到磁盘上，不能只更新内存里的 mock
  await page.exposeBinding('__worldSourceSave', async (_source, params) => ({ ok: true, value: await service.call('save', params) }))
  await page.goto('http://127.0.0.1/million')
  await page.evaluate(dir => {
    localStorage.setItem('dsh.world.apps','["vscode"]'); localStorage.setItem('dsh.world.vscode.folders',JSON.stringify([dir]))
    window.__worldDesktopCall = op => op === 'poll' ? new Promise(() => {}) : {}
  },dir)
  if (memory) await page.evaluate(() => { window.__worldSourceOpen = params => fetch('/memory-file', {method:'POST', body:JSON.stringify(params)}).then(r => r.json()) })
  await page.addScriptTag({content:bundle.outputFiles[0].text})
  await page.locator('[data-world-icon-id="vscode"]').dblclick()
  const entry = page.getByRole('button',{name:'numbers.txt',exact:true}); await entry.waitFor()
  if (memory) {
    const { checkEditorMemory } = await import('./editor-memory-browser.mjs')
    await checkEditorMemory(page, (await stat(path)).size); assert.deepEqual(errors, [])
  }
  const begin = performance.now(); console.log('Opening 2M lines ...')
  await entry.dispatchEvent('click')
  const large = page.locator('.world-vscode-large'), text = large.locator('.cm-scroller'), input = large.locator('.cm-content')
  await text.waitFor({ timeout: 90000 })
  const initial = await text.evaluate(async el => { await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return { height:el.scrollHeight,clientHeight:el.clientHeight,clientWidth:el.clientWidth,lineHeight:parseFloat(getComputedStyle(el).lineHeight) } })
  console.log('First display ms:',Math.round(performance.now()-begin), initial)
  assert.equal(await input.getAttribute('aria-readonly'), 'true')
  // 只读视图没装 CodeMirror 主题，默认按亮色主题把光标涂黑；深色窗口里必须跟文字同色
  const caret = await input.evaluate(node => ({ caret: getComputedStyle(node).caretColor, color: getComputedStyle(node).color }))
  assert.equal(caret.caret, caret.color, `caret must follow the text color, got ${JSON.stringify(caret)}`)
  const align = async () => page.waitForFunction(() => {
    const scroll = document.querySelector('.world-vscode-large .cm-scroller'), box = scroll.getBoundingClientRect()
    const row = [...scroll.querySelectorAll('.cm-line')].find(r => r.getBoundingClientRect().top >= box.top && r.getBoundingClientRect().top < box.bottom)
    return row && [...scroll.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].some(g => g.textContent === row.textContent && Math.abs(g.getBoundingClientRect().top - row.getBoundingClientRect().top) < 1)
  })
  for (const ratio of [.5,1]) {
    const t = performance.now(); await text.evaluate((el, ratio) => { el.scrollTop = el.scrollHeight * ratio }, ratio)
    await page.waitForFunction(r => [...document.querySelectorAll('.world-vscode-large .cm-line')].some(el => r === 1 ? el.textContent === '2000000' : +el.textContent > 900000 && +el.textContent < 1100000), ratio)
    await align(); console.log('Scroll jump:',ratio,Math.round(performance.now()-t),'ms')
  }
  await input.focus(); await page.keyboard.press('Control+Home'); await page.keyboard.press('Control+f')
  const find = page.locator('.world-vscode-findbar input').first(); await find.fill('1999999')
  await page.locator('.world-vscode-find-count').filter({ hasText:'1/1' }).waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll('.world-vscode-large .cm-line')].some(x=>x.textContent === '1999999'))
  await find.press('Escape')
  const copied = () => input.evaluate(node => {
    const data = new DataTransfer(); node.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data}))
    const text = data.getData('text/plain'); return {size:text.length, first:text.slice(0,6), last:text.slice(-7)}
  })
  assert.equal((await copied()).last, '1999999')
  await input.press('Control+Home'); await input.press('Shift+PageDown'); await input.press('Shift+PageDown')
  const partial = await copied()
  assert.equal(partial.first, '1\n2\n3\n'); assert.ok(partial.size > 120 && partial.size < 10000, 'multi-page partial selection, not Select All')
  await page.keyboard.press('Control+Home'); await page.keyboard.press('Control+Shift+End')
  assert.deepEqual(await copied(), { size:(await stat(path)).size, first:'1\n2\n3\n', last:'2000000' })
  // 真实剪贴板：DOM 里只有几十行，Ctrl+A/Ctrl+C 必须给出整篇
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await input.focus()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Control+c')
  await page.waitForTimeout(200)
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  assert.equal(clip.length, (await stat(path)).size, 'select-all copy must put the whole file on the clipboard')
  assert.ok(clip.startsWith('1\n2\n3\n') && clip.endsWith('\n2000000'))
  await page.keyboard.type('NO EDIT'); await page.keyboard.press('Control+a')
  assert.equal((await copied()).size, (await stat(path)).size)
  await page.keyboard.press('Control+Home'); await align()
  assert.ok(await input.locator('.cm-line').count() < 500)
  await wheelLatency(page, text, false)
  // Retain the same large view when moving between a single group and a split.
  // Use the workspace service for both tabs; only the already-read-only document is virtual.
  const editor = page.locator('[data-world-vscode-key]')
  await editor.getByRole('tab', { name: /numbers.txt/ }).dblclick()
  await editor.getByRole('button', { name:'small.txt', exact:true }).dblclick()
  await editor.locator('textarea.world-vscode-textarea').fill('retained draft')
  const pane = editor.locator('.world-vscode-pane:not(.is-hidden)').first(), box = await pane.boundingBox()
  await editor.getByRole('tab', { name:/numbers.txt/ }).dragTo(pane, { targetPosition:{ x:box.width * .92, y:box.height * .5 } })
  await text.waitFor()
  assert.equal(await editor.locator('textarea.world-vscode-textarea').inputValue(), 'retained draft')
  await input.evaluate(el => { el.dataset.splitIdentity = 'original' })
  await editor.locator('textarea.world-vscode-textarea').focus()
  assert.equal(await input.getAttribute('data-split-identity'), 'original', 'an unfocused but visible split must keep its live view')
  await input.focus(); await input.press('Control+End'); await align()
  await page.waitForFunction(() => [...document.querySelectorAll('.world-vscode-large .cm-line')].some(x => x.textContent === '2000000'))
  await editor.locator('.world-vscode-status-wrap').click()
  await input.press('Control+Home'); await align()
  await input.press('Control+f'); await find.fill('2000000'); await find.press('Escape')
  assert.equal((await copied()).last, '2000000')
  // 1–8 MiB 的文件走虚拟化视图，但必须还能编辑、能存盘、切标签不丢改动
  const editorTab = name => editor.getByRole('tab', { name: new RegExp(name.replace('.', '\\.')) })
  await page.getByRole('button', { name: 'medium.txt', exact: true }).dblclick()
  const medium = page.locator('.world-vscode-large:visible').last()
  const mediumInput = medium.locator('.cm-content')
  await mediumInput.waitFor({ timeout: 30000 })
  assert.notEqual(await mediumInput.getAttribute('aria-readonly'), 'true', 'a 1.2 MB source file must stay editable')
  await mediumInput.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('/* tail-a */')
  await editorTab('medium.txt').locator('.world-vscode-tab-dirty').waitFor()
  await page.keyboard.press('Control+s')
  // 其它标签也可能是脏的（分屏那段给 small.txt 留了草稿），只等这一颗
  await editorTab('medium.txt').locator('.world-vscode-tab-dirty').waitFor({ state: 'detached', timeout: 15000 })
  const savedText = await readFile(join(dir, 'medium.txt'), 'utf8')
  assert.ok(savedText.endsWith('/* tail-a */'), 'Ctrl+S must write the CodeMirror document')
  // 再改一次但不保存：切到别的标签再回来，改动必须还在（视图销毁时写回快照）
  await page.keyboard.type('tail-b')
  await editorTab('small.txt').click()
  await page.waitForTimeout(300)
  await editorTab('medium.txt').click()
  await medium.locator('.cm-content').waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll('.world-vscode-large:not([hidden]) .cm-line')].some(node => node.textContent.includes('tail-b')), null, { timeout: 15000 })
  assert.ok(await editorTab('medium.txt').locator('.world-vscode-tab-dirty').count(), 'unsaved edit must keep the dirty marker')
  assert.deepEqual(errors,[])
  if (process.argv.includes('--probe')) {
    await page.close()
    const probe = await browser.newPage({ viewport: { width: 1440, height: 960 } })
    await probe.exposeBinding('__open', openDocument)
    const begin = performance.now()
    const summary = await probe.evaluate(async ({ dir, initial }) => {
      // Isolated read-only rendering experiment, not a replacement for editor selection/find.
      // Use the same document service/transport, font height, and viewport dimensions.
      const { value: { source } } = await window.__open({ sessionId: 'session-1', root: dir, path: 'numbers.txt' })
      const t = performance.now()
      let count = 1
      for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) count++
      const starts = new Uint32Array(count)
      for (let i = 0, j = 1; i < source.length; i++) if (source.charCodeAt(i) === 10) starts[j++] = i + 1
      const indexMs = performance.now() - t
      const view = document.createElement('div'), scrollbar = document.createElement('div')
      const track = document.createElement('div'), lines = document.createElement('div')
      const h = initial.lineHeight
      view.style.cssText = `position:relative;overflow:hidden;width:${initial.clientWidth}px;height:${initial.clientHeight}px;font:13px/${h}px monospace`
      scrollbar.dataset.measureScroll = 'true'
      scrollbar.style.cssText = 'height:100%;overflow-y:auto'; track.style.height = `${Math.min(initial.height, count * h)}px`
      lines.style.cssText = 'position:absolute;inset:0 auto auto 0;pointer-events:none;white-space:pre'
      document.body.append(view); view.append(scrollbar, lines); scrollbar.append(track)
      function render() {
        const physicalRange = scrollbar.scrollHeight - scrollbar.clientHeight
        const logicalY = Math.round(scrollbar.scrollTop / physicalRange * (count * h - scrollbar.clientHeight))
        const first = Math.floor(logicalY / h), end = Math.min(count, Math.ceil((logicalY + scrollbar.clientHeight) / h))
        const fragment = document.createDocumentFragment()
        for (let i = first; i < end; i++) {
          const row = document.createElement('div'); row.dataset.line = String(i + 1)
          row.textContent = source.slice(starts[i], i + 1 < count ? starts[i + 1] - 1 : source.length)
          fragment.append(row)
        }
        lines.replaceChildren(fragment); lines.style.transform = `translateY(${first * h - logicalY}px)`
      }
      scrollbar.addEventListener('scroll', render); render()
      const settle = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
      window.__jump = async ratio => {
        const t = performance.now(); scrollbar.scrollTop = ratio * scrollbar.scrollHeight; await settle()
        return { ratio, ms: Math.round(performance.now() - t), first: +lines.firstElementChild.dataset.line,
          last: +lines.lastElementChild.dataset.line, tailText: lines.lastElementChild.textContent, rows: lines.childElementCount }
      }
      await settle()
      return { count, indexMs: Math.round(indexMs), indexBytes: starts.byteLength }
    }, { dir, initial })
    console.log('Indexed probe first display ms:', Math.round(performance.now() - begin), summary)
    assert.equal(summary.count, total)
    const jumps = []
    for (const ratio of [.5, 1, 0]) jumps.push(await probe.evaluate(r => window.__jump(r), ratio))
    console.log('Indexed probe jumps:', jumps)
    assert.equal(jumps[1].tailText, String(total)); assert.equal(jumps[1].last, total); assert.equal(jumps[2].first, 1)
    await wheelLatency(probe, probe.locator('[data-measure-scroll]'), true)
    for (const jump of jumps) assert.ok(jump.rows <= Math.ceil(initial.clientHeight / initial.lineHeight) + 1)
  }
} finally {
  await browser?.close(); await service?.dispose(); await context.fiber.dispose()
  await rm(path, { force: true }); await rm(join(dir, 'small.txt'), { force: true }); await rm(join(dir, 'medium.txt'), { force: true }); await rmdir(dir)
}
