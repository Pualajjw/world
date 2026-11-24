import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
// Exercise the outer native window, not the maximize button inside the World desktop.
const root = resolve(import.meta.dirname, '..')
const require = createRequire(join(root, '../workflow-studio/package.json'))
const { build } = require('esbuild'), { chromium } = require('playwright-core')
const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true,
  format: 'iife', platform: 'browser', target: 'es2022', write: false, define: { 'process.env.NODE_ENV': '"production"' },
  nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' } })
const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
  args: ['--window-size=1180,820', '--screen-info={1920x1080}'] })
const errors = []
try {
  const page = await browser.newPage({ viewport: null })
  page.on('pageerror', e => errors.push(e.message))
  await page.route('http://127.0.0.1/world-outer-maximize', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
  await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
  await page.goto('http://127.0.0.1/world-outer-maximize')
  await page.evaluate(() => {
    localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode']))
    // No assistant commands in this fixture: keep the poll pending like the real mailbox.
    window.__worldDesktopCall = op => op === 'poll' ? new Promise(() => {}) : {}
    window.__rowVisits = 0
    window.__worldWorkspaceList = () => ({ ok: true, value: { entries: Array.from({ length: 1200 }, (_, i) => ({
      name: `file-${i}.txt`, get type() { window.__rowVisits++; return 'file' },
    })) } })
  })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const cdp = await page.context().newCDPSession(page), { windowId } = await cdp.send('Browser.getWindowForTarget')
  await checkBareDesktop(page, cdp, windowId)
  await page.locator('[data-world-icon-id="vscode"]').dblclick()
  const editor = page.locator('[data-world-vscode-key]')
  await editor.getByRole('button', { name: 'file-1199.txt', exact: true }).waitFor({ state: 'attached' })
  const original = await editor.boundingBox(), viewport = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))

  const bodyRect = () => page.evaluate(() => ['x', 'y', 'w', 'h'].map(key => document.body.style.getPropertyValue(`--world-win-${key}`)))
  const hiddenRect = await bodyRect(), passes = []
  for (let i = 0; i < 5; i++) for (const windowState of ['maximized', 'normal']) {
    await page.evaluate(() => { window.__rowVisits = 0 })
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState } })
    const max = windowState === 'maximized'
    await page.waitForFunction(({ max, w }) => max ? innerWidth > w : innerWidth === w, { max, w: viewport.w })
    const r = await editor.evaluate(async node => {
      await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
      const shell = node.getBoundingClientRect(), content = node.querySelector('.world-vscode-editor').getBoundingClientRect()
      return { w: innerWidth, h: innerHeight, width: shell.width, height: shell.height,
        rightGap: shell.right - content.right, visits: window.__rowVisits }
    })
    if (i && max) passes.push(r.visits / 1200)
    assert.ok(Math.abs(r.width - original.width * r.w / viewport.w) < 1)
    assert.ok(Math.abs(r.height - original.height * r.h / viewport.h) < 1)
    assert.ok(Math.abs(r.rightGap) <= 2, 'editor content follows the shell')
    assert.deepEqual(await bodyRect(), hiddenRect, 'hidden DSH geometry must not invalidate the visible desktop')
    if (!max) assert.deepEqual(await editor.boundingBox(), original)
  }
  console.log('Outer maximize passes over file rows:', passes)
  // Gate on redundant work, not machine speed; tolerate an occasional unrelated host update.
  assert.ok(passes.filter(n => n <= 1).length > passes.length / 2, 'unchanged rectangles should not repeatedly render the file tree')
  // At the restored viewport the default 60vw DSH window needs its 720px clamp.
  // The body styles were frozen, not the underlying restore rectangle.
  await page.locator('[data-world-icon-id="dsh"]').dblclick()
  await page.waitForFunction(() => document.body.dataset.worldWindow === 'normal')
  const reopened = await page.locator('#root').boundingBox()
  assert.ok(Math.abs(reopened.width - Math.max(720, viewport.w * .6)) < 1, 'opening applies the current clamped width')
  assert.deepEqual(errors, [])
} finally { await browser.close() }

// Empty World desktop, native outer maximize, real host column behind the wallpaper.
async function checkBareDesktop(page, cdp, windowId) {
  const editor = page.locator('[data-world-vscode-key]'), host = page.locator('#host-ui')
  await page.locator('.world-wall').waitFor()
  await page.waitForFunction(() => document.querySelector('#host-ui').inert)
  assert.equal(await editor.count(), 0)
  const expected = await host.evaluate(el => {
    const transcript = document.createElement('div')
    transcript.style.cssText = 'overflow:auto;height:200px'; transcript.id = 'test-transcript'
    const frag = document.createDocumentFragment()
    for (let i = 0; i < 950; i++) { const row = document.createElement('p'); row.textContent = `test row ${i}: ` + 'a longer line of conversation '.repeat(16); frag.append(row) }
    transcript.append(frag); el.append(transcript)
    return { w: innerWidth, h: innerHeight }
  })
  const setWindow = async max => {
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: max ? 'maximized' : 'normal' } })
    await page.waitForFunction(({ w, max }) => max ? innerWidth > w : innerWidth === w, { w: expected.w, max })
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  }
  for (const max of [true, false]) {
    await setWindow(max)
    const r = await page.evaluate(() => ({ wall: document.querySelector('.world-wall').getBoundingClientRect().right,
      bottom: document.querySelector('.world-taskbar').getBoundingClientRect().bottom, w: innerWidth, h: innerHeight,
      host: getComputedStyle(document.querySelector('#host-ui')).contentVisibility,
      overlay: getComputedStyle(document.querySelector('[data-shell-overlay]')).contentVisibility }))
    assert.deepEqual([r.wall, r.bottom, r.host, r.overlay], [r.w, r.h, 'hidden', 'visible'])
    assert.equal(await editor.count(), 0)
  }
  await page.locator('[data-world-icon-id="dsh"]').dblclick()
  await page.waitForFunction(() => document.body.dataset.worldWindow === 'normal')
  assert.equal(await host.evaluate(el => getComputedStyle(el).contentVisibility), 'visible')
  assert.equal(await host.locator('#test-transcript p').count(), 950)
  const scroll = await host.locator('#test-transcript').evaluate(el => { el.scrollTop = 1000; return el.scrollTop })
  assert.equal(scroll, 1000)
  await page.locator('.world-window-frame').getByRole('button', { name: '关闭', exact: true }).click()
  await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')
  await page.locator('[data-world-icon-id="dsh"]').dblclick()
  await page.waitForFunction(() => document.body.dataset.worldWindow === 'normal')
  const transcript = host.locator('#test-transcript')
  assert.equal(await transcript.evaluate(el => el.scrollTop), scroll, 'hiding a chat must not discard its scroll offset')
  await page.locator('.world-window-frame').getByRole('button', { name: '关闭', exact: true }).click()
  await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')
  await host.locator('#test-transcript').evaluate(el => el.remove())
  console.log('Bare desktop: outer maximize/restore, hidden conversation and reopened host passed.')
}
