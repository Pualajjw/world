import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createDesktopBridge } from '../desktop-bridge.js'

const root = dirname(import.meta.dirname)
const executablePath = process.env.WORLD_ELECTRON_BINARY
if (!executablePath) throw new Error('Set WORLD_ELECTRON_BINARY to an Electron executable for the native browser check.')
const policySource = process.env.WORLD_BROWSER_POLICY || 'E:/deepseek-harness/apps/desktop/src/browser-guests.ts'
await Promise.all([access(executablePath), access(policySource)])
const require = createRequire(join(root, '../workflow-studio/package.json'))
const { _electron } = require('playwright-core')
let build
try { ({ build } = await import('esbuild')) }
catch { ({ build } = await import(pathToFileURL(join(root, '../pbpkg/node_modules/esbuild/lib/main.js')))) }
const directory = await mkdtemp(join(tmpdir(), 'world-native-browser-'))
const shots = process.env.WORLD_NATIVE_SHOTS_DIR || join(tmpdir(), 'world-native-browser-shots')
let app
const desktopBridge = createDesktopBridge()
try {
  await mkdir(shots, { recursive: true })
  await build({ entryPoints: [policySource], bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], outfile: join(directory, 'guests.cjs') })
  const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true,
    format: 'iife', platform: 'browser', target: 'es2022', write: false,
    nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' }, legalComments: 'none' })
  await writeFile(join(directory, 'bundle.js'), bundle.outputFiles[0].text)
  await writeFile(join(directory, 'preload.cjs'), `const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('dshDesktop', { protocolVersion: 1, browser: {
  acquire: workspace => ipcRenderer.invoke('world-test-acquire', workspace),
  release: lease => ipcRenderer.invoke('world-test-release', lease), onOpenRequested: () => () => {},
} })`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  app = await _electron.launch({ executablePath, env,
    args: [join(root, 'tests/native-browser-main.cjs'), directory], timeout: 20000 })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForSelector('[data-world-browser-icon]')
  await page.locator('[data-world-browser-icon]').dblclick()
  const fixtureUrl = await app.evaluate(() => global.worldNativeProbe.fixtureUrl)
  const address = page.locator('[data-world-browser-address]')
  await address.fill(`${fixtureUrl}/redirect`)
  await address.press('Enter')
  await page.waitForFunction(url => document.querySelector('webview')?.getURL?.() === `${url}/page`, fixtureUrl)
  await page.waitForFunction(() => !document.querySelector('webview').isLoading())

  const readGuest = () => app.evaluate(async ({ webContents }) => {
    const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview')
    assertGuest(guest)
    return guest.executeJavaScript(`({ width:innerWidth, height:innerHeight,
      scrollWidth:document.documentElement.scrollWidth, scrollHeight:document.documentElement.scrollHeight,
      title:document.title, url:location.href })`)
    function assertGuest(value) { if (!value) throw new Error('No native guest attached') }
  })
  const outer = () => page.locator('webview').evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { width: Math.round(rect.width), height: Math.round(rect.height), display: getComputedStyle(element).display }
  })
  const waitSize = async () => {
    for (let tries = 0; tries < 100; tries++) {
      const frame = await outer(), guest = await readGuest()
      if (frame.width === guest.width && frame.height === guest.height) return { frame, guest }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const frame = await outer(), guest = await readGuest()
    assert.deepEqual({ width: guest.width, height: guest.height }, { width: frame.width, height: frame.height },
      'native viewport must fill the frame')
  }
  const initial = await waitSize()
  assert.equal(initial.frame.display, 'flex')
  assert.deepEqual({ width: initial.guest.width, height: initial.guest.height }, { width: 1022, height: 530 })
  assert.equal(initial.guest.title, 'Native viewport test')
  assert.equal(initial.guest.url, `${fixtureUrl}/page`, 'redirecting to the iframe-protected page succeeds')
  await page.screenshot({ path: join(shots, 'native-page-full-height.png') })

  const scrolled = await app.evaluate(async ({ webContents }) => {
    const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview')
    return guest.executeJavaScript(`(async () => {
      scrollTo(document.documentElement.scrollWidth, document.documentElement.scrollHeight);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const bottom=document.getElementById('bottom').getBoundingClientRect();
      return {x:scrollX,y:scrollY,bottom:bottom.bottom,height:innerHeight};
    })()`)
  })
  assert.ok(scrolled.x > 0 && scrolled.y > 0)
  assert.ok(scrolled.bottom <= scrolled.height + 1 && scrolled.bottom > 0, 'the actual page footer is reachable')
  await page.waitForTimeout(300) // Native guest compositing can lag its DOM scroll position in a hidden test window.
  await page.screenshot({ path: join(shots, 'native-page-footer.png') })
  const footerCapture = await app.evaluate(async ({ webContents }) => {
    const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview')
    return (await guest.capturePage()).toDataURL()
  })
  await writeFile(join(shots, 'native-guest-footer.png'), Buffer.from(footerCapture.split(',')[1], 'base64'))
  await app.evaluate(async ({ webContents }) => {
    const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview')
    await guest.executeJavaScript('scrollTo(0, 0)')
  })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: '最大化', exact: true }).click()
  const maximized = await waitSize()
  assert.ok(maximized.guest.width > initial.guest.width && maximized.guest.height > initial.guest.height)
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(shots, 'native-page-maximized.png') })
  await page.getByRole('button', { name: '还原', exact: true }).click()
  const restored = await waitSize()
  assert.deepEqual(restored.frame, initial.frame)
  await page.locator('[data-world-browser-add]').click()
  await page.locator('[data-world-browser-tab="tab1"]').click()
  assert.equal((await readGuest()).url, `${fixtureUrl}/page`)
  assert.deepEqual(await app.evaluate(() => global.worldNativeProbe.counts()), { acquired: 1, released: 0 })
  await page.locator('.world-browser-close').click()
  await page.waitForFunction(() => !document.querySelector('webview'))
  assert.deepEqual(await app.evaluate(() => global.worldNativeProbe.counts()), { acquired: 1, released: 1 })
  assert.deepEqual(errors, [])

  const controlProbe = await build({ absWorkingDir: root, stdin: {
    contents: `import { createDesktopControl, observeDesktopInput } from './desktop-control.js';
const control = createDesktopControl(); observeDesktopInput(control);
let operationSignal, finish;
window.__nativeControlProbe = {
  start() { control.grant('fixed');
    control.run({ action:'open_file', actor:{sessionId:'fixed'}, controlId:control.getSnapshot().controlId }, undefined,
      signal => { operationSignal=signal; return new Promise(resolve => {finish=resolve}) }).catch(() => {});
  },
  snapshot: () => ({...control.getSnapshot(), operationAborted:operationSignal?.aborted}),
  finish: () => finish({}),
};`, resolveDir: root, sourcefile: 'native-control-probe.js',
  }, bundle: true, format: 'iife', platform: 'browser', write: false })
  await page.addScriptTag({ content: controlProbe.outputFiles[0].text })
  const shell = await app.browserWindow(page)
  await shell.evaluate(window => { window.show(); window.focus() })
  await page.evaluate(() => window.__nativeControlProbe.start())
  const beforeMinimize = await page.evaluate(() => window.__nativeControlProbe.snapshot())
  await shell.evaluate(window => new Promise(resolve => {
    window.once('minimize', () => resolve(true)); window.minimize()
  }))
  assert.equal(await shell.evaluate(window => window.isMinimized()), true)
  // Exercise the renderer notification as well; hidden automation windows can retain DOM focus.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  const afterMinimize = await page.evaluate(() => window.__nativeControlProbe.snapshot())
  assert.equal(afterMinimize.owner, 'assistant')
  assert.equal(afterMinimize.controlId, beforeMinimize.controlId)
  assert.equal(afterMinimize.operationAborted, false)
  await shell.evaluate(window => new Promise(resolve => {
    window.once('restore', () => resolve(true)); window.restore()
  }))
  const afterRestore = await page.evaluate(() => window.__nativeControlProbe.snapshot())
  assert.equal(afterRestore.controlId, beforeMinimize.controlId)
  await page.getByRole('button', { name: '开始', exact: true }).click()
  assert.equal((await page.evaluate(() => window.__nativeControlProbe.snapshot())).owner, 'human')
  await page.evaluate(() => window.__nativeControlProbe.finish())
  // A real native webview must not steal clicks/keyboard from the overlaid conversation surface.
  await page.exposeBinding('__worldDesktopCall', (_source, operation, payload) => desktopBridge.call(operation, payload))
  await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
  await page.reload()
  await page.locator('[data-world-browser-icon]').dblclick()
  await address.fill(`${fixtureUrl}/page`)
  await address.press('Enter')
  await page.waitForFunction(() => document.querySelector('webview')?.isLoading?.() === false)
  await page.locator('[data-world-control-button]').click()
  const panelInput = page.locator('.world-assistant-conversation textarea')
  await panelInput.waitFor()
  const assistantMouse = page.locator('[data-world-assistant-pointer] > svg')
  await assistantMouse.waitFor()
  const nativePointer = await page.locator('[data-world-assistant-pointer]').evaluate(node => ({ x: Number(node.dataset.x), y: Number(node.dataset.y),
    width: node.querySelector('svg').getBoundingClientRect().width, height: node.querySelector('svg').getBoundingClientRect().height,
    pointerEvents: getComputedStyle(node).pointerEvents }))
  assert.deepEqual(nativePointer, { x: 640, y: 396, width: 28, height: 28, pointerEvents: 'none' })
  await panelInput.click()
  await panelInput.fill('在原生网页上方继续同一会话')
  await panelInput.press('Enter')
  assert.deepEqual(await page.evaluate(() => window.__worldTesting.conversation.sent),
    [{ sessionId: 'session-1', text: '在原生网页上方继续同一会话' }])
  assert.equal(await page.locator('[data-world-control-button]').getAttribute('aria-pressed'), 'true')
  await page.screenshot({ path: join(shots, 'native-conversation-panel.png') })
  const nativeGrant = (await desktopBridge.request({ action: 'state' })).state.control.controlId
  await panelInput.fill('原生环境收起后保留的草稿')
  const cardToggle = page.locator('[data-world-assistant-toggle]')
  await cardToggle.click()
  assert.equal(await assistantMouse.isVisible(), true, 'assistant pointer remains above the native guest with the card collapsed')
  assert.equal(await panelInput.isVisible(), false)
  const collapsedCard = await page.locator('.world-control-card').evaluate(node => {
    const rect = node.getBoundingClientRect(); return { width: rect.width, height: rect.height }
  })
  assert.equal(collapsedCard.width, 372)
  assert.ok(collapsedCard.height < 100, 'collapsed card stays a thin bar above the native guest')
  assert.equal((await desktopBridge.request({ action: 'state' })).state.control.controlId, nativeGrant)
  await page.screenshot({ path: join(shots, 'native-assistant-collapsed.png') })
  await cardToggle.click()
  assert.equal(await panelInput.inputValue(), '原生环境收起后保留的草稿')
  await page.locator('[data-world-takeover]').click()
  assert.equal(await assistantMouse.isVisible(), false)
  await page.locator('.world-browser-close').click()
  await page.waitForFunction(() => !document.querySelector('webview'))
  assert.deepEqual(await app.evaluate(() => global.worldNativeProbe.counts()), { acquired: 2, released: 2 })
  assert.deepEqual(errors, [])
  await shell.evaluate(window => window.hide())
  const report = { electron: await app.evaluate(() => process.versions.electron), initial, maximized, restored, scrolled,
    protectedPageLoaded: true, redirectLoaded: true, leases: { acquired: 2, released: 2 },
    minimizeHandoffPreserved: true, restoreHandoffPreserved: true, realInputTakesOver: true,
    conversationPanelOverNativeGuest: true, assistantCollapse: collapsedCard, assistantPointer: nativePointer }
  await writeFile(join(shots, 'native-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  desktopBridge.dispose()
  await app?.close()
  assert.equal(dirname(directory), tmpdir())
  assert.ok(basename(directory).startsWith('world-native-browser-'))
  await rm(directory, { recursive: true, force: true })
}
