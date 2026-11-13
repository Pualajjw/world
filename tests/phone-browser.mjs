import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installBrowserProbe } from './browser-frame.browser.mjs'

const HTML = '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>'
  + ':root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#f7f9fd;--dsw-alias-bg-layer-2:#f1f3f5;--dsw-alias-label-primary:#17233c;--dsw-alias-label-secondary:#646e82;--dsw-alias-border-l2:#e1e6ee}'
  + ':root[data-ds-dark-theme]{--dsw-alias-bg-base:#151517;--dsw-alias-bg-layer-1:#1e2024;--dsw-alias-bg-layer-2:#272a30;--dsw-alias-label-primary:#f9fafb;--dsw-alias-label-secondary:#bec4cd;--dsw-alias-border-l2:#414650}'
  + 'body{margin:0}#root{width:100vw;height:100vh}.app-frame{position:relative;height:100%;padding-top:40px;box-sizing:border-box}'
  + '#host-ui{position:absolute;inset:40px 0 0;background:#262626}[data-shell-overlay]{pointer-events:none}[data-shell-overlay]>*{pointer-events:auto}'
  + '</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"><button id="phone-host-button">Host content</button></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>'

export async function checkPhoneDesktop(browser, bundleText, shotsDirectory) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const measurements = []
  const shot = async name => {
    if (!shotsDirectory) return
    await mkdir(shotsDirectory, { recursive: true })
    await page.screenshot({ path: join(shotsDirectory, `${name}.png`) })
  }
  const home = () => page.getByRole('button', { name: '返回桌面', exact: true }).tap()
  const switchTo = async id => {
    await page.getByRole('button', { name: '切换应用', exact: true }).tap()
    await page.locator(`[data-world-phone-window="${id}"]`).tap()
  }
  const fullApp = async selector => {
    const box = await page.locator(selector).boundingBox()
    assert.ok(box, `${selector} must be visible`)
    assert.equal(Math.round(box.x), 0)
    assert.equal(Math.round(box.y), 72)
    assert.equal(Math.round(box.width), 360)
    assert.equal(Math.round(box.height), 520)
    return box
  }
  try {
    await page.route('http://127.0.0.1/world-phone-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML }))
    await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.goto('http://127.0.0.1/world-phone-fixture')
    await page.evaluate(() => {
      localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode', 'browser', 'terminal', 'lanchat']))
      localStorage.setItem('dsh.world.external-apps', JSON.stringify([{ format: 'dsh-world-app/1', id: 'phone-test', name: '测试应用', url: 'http://127.0.0.1/world-phone-app' }]))
      localStorage.setItem('dsh.world.window.position', JSON.stringify({ x: 10, y: 12, w: 70, h: 65 }))
      localStorage.setItem('dsh.world.browser.window', JSON.stringify({ x: 8, y: 10, w: 80, h: 70 }))
      localStorage.setItem('dsh.world.plugin.workflow-studio', JSON.stringify({ x: 6, y: 11, w: 78, h: 72 }))
    })
    await page.route('http://127.0.0.1/world-phone-app', route => route.fulfill({ contentType: 'text/html', body: '<button>External phone app</button>' }))
    await page.evaluate(installBrowserProbe)
    await page.addScriptTag({ content: bundleText })
    await page.waitForFunction(() => document.body.dataset.worldLayout === 'desktop')
    await page.locator('[data-world-icon-id="dsh"]').dblclick()
    await page.waitForTimeout(200)
    const original = await page.locator('.world-window-frame').boundingBox()
    await page.locator('[data-world-browser-icon]').dblclick()
    await page.waitForTimeout(200)
    const originalBrowser = await page.locator('.world-browser-window').boundingBox()
    const stored = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.endsWith('.window') || key.endsWith('.position'))))

    for (const width of [1100, 740, 601, 360]) await page.setViewportSize({ width, height: 640 })
    await page.waitForFunction(() => document.body.dataset.worldLayout === 'phone')
    assert.equal(await page.locator('.world-desktop-titlebar').evaluate(node => getComputedStyle(node).webkitAppRegion), 'drag')
    assert.equal(await page.locator('.world-desktop-titlebar').evaluate(node => node.getBoundingClientRect().height), 40)
    measurements.push({ app: 'browser', ...await fullApp('.world-browser-window') })
    assert.equal(await page.locator('.world-window-frame').isVisible(), false)
    assert.equal(await page.locator('#host-ui').evaluate(node => node.inert), true)
    await home()
    assert.equal(await page.locator('.world-browser-window').isVisible(), false)
    assert.equal(await page.locator('.world-browser-window').evaluate(node => node.inert), true)
    assert.equal(await page.locator('[data-world-icon-id="dsh"]').isVisible(), true)
    assert.match(await page.locator('.world-phone-status [data-world-time]').textContent(), /^\d{2}:\d{2}$/u)
    const icons = await page.locator('.world-desktop-icon').evaluateAll(nodes => nodes.map(node => {
      const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }
    }))
    assert.equal(icons[0].y, icons[3].y, 'four icons share the first row')
    assert.ok(icons[4].y > icons[0].y + 90, 'the fifth icon starts the second row')
    assert.deepEqual(icons.slice(0, 4).map(item => Math.round(item.width)), [78, 78, 78, 78])
    measurements.push({ icons: icons.slice(0, 5) })
    await shot('phone-360-home')
    await page.evaluate(() => document.documentElement.setAttribute('data-ds-dark-theme', ''))
    await page.waitForFunction(() => document.body.dataset.worldTheme === 'dark')
    await shot('phone-360-home-dark')
    await page.evaluate(() => document.documentElement.removeAttribute('data-ds-dark-theme'))
    await page.waitForFunction(() => document.body.dataset.worldTheme === 'light')
    await page.locator('[data-world-icon-id="dsh"]').tap()
    measurements.push({ app: 'dsh', ...await fullApp('.world-window-frame') })
    await fullApp('#root')
    assert.equal(await page.locator('#host-ui').evaluate(node => node.inert), false)
    await page.locator('#phone-host-button').tap()
    await home()
    await switchTo('dsh')
    await fullApp('#root')
    await shot('phone-360-dsh')

    await home()
    await page.locator('[data-world-icon-id="vscode"]').tap()
    await fullApp('[data-world-vscode-key]')
    await page.locator('.world-vscode-sidebar').waitFor()
    const sidebar = await page.locator('.world-vscode-sidebar').boundingBox()
    assert.ok(sidebar.x + sidebar.width <= 360, 'editor sidebar stays inside the phone')
    await home()
    await switchTo('browser')
    await page.locator('[data-world-browser-address]').fill('https://example.com')
    await page.locator('[data-world-browser-address]').press('Enter')
    const guest = page.locator('[data-world-fake-webview]')
    await guest.waitFor()
    await home()
    assert.equal(await guest.evaluate(node => getComputedStyle(node.parentElement).visibility), 'hidden', 'native guest must suspend on home')
    await switchTo('browser')
    assert.equal(await guest.count(), 1, 'switching apps preserves the browser guest')
    assert.equal(await page.locator('[data-world-browser-address]').inputValue(), 'https://example.com/')
    await shot('phone-360-browser')

    await home()
    await page.getByRole('button', { name: '全部应用', exact: true }).tap()
    await page.locator('.world-plugin-card[data-world-plugin-card="workflow-studio"]').tap()
    await fullApp('[data-world-plugin="workflow-studio"]')
    await page.evaluate(() => {
      const portal = document.createElement('div')
      portal.id = 'phone-plugin-modal'
      portal.innerHTML = '<div role="dialog" style="width:800px;height:700px">Phone plugin dialog</div>'
      document.body.append(portal)
    })
    await page.waitForFunction(() => document.getElementById('phone-plugin-modal')?.dataset.worldDialog === 'workflow-studio')
    const modal = await page.locator('#phone-plugin-modal [role="dialog"]').boundingBox()
    assert.ok(modal.width <= 312 && modal.height <= 472, 'plugin dialogs fit inside the phone app')
    await home()
    assert.equal(await page.locator('#phone-plugin-modal').isVisible(), false)
    await page.evaluate(() => document.getElementById('phone-plugin-modal').remove())
    await page.locator('[data-world-icon-id="terminal"]').tap()
    await fullApp('.world-terminal-window')
    await home()
    await page.locator('[data-world-icon-id="phone-test"]').tap()
    await fullApp('[data-world-app-id="phone-test"]')
    await page.frameLocator('[data-world-app-id="phone-test"] iframe').getByRole('button', { name: 'External phone app' }).tap()
    await home()
    await page.getByRole('button', { name: '切换应用', exact: true }).tap()
    assert.ok(await page.locator('[data-world-phone-window]').count() >= 5)
    await shot('phone-360-apps')
    await page.keyboard.press('Escape')
    await page.locator('.world-phone-switcher').waitFor({ state: 'detached' })
    assert.deepEqual(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.endsWith('.window') || key.endsWith('.position')))), stored)

    for (const width of [390, 520, 600]) {
      await page.setViewportSize({ width, height: 640 })
      const nav = await page.locator('.world-phone-nav').boundingBox()
      assert.ok(nav.x >= 0 && nav.x + nav.width <= width)
      assert.equal(await page.locator('.world-icons').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length), 4)
    }
    // Dragging the outer window passes through small desktop widths before reaching its original size.
    for (const width of [601, 740, 1024]) {
      await page.setViewportSize({ width, height: 640 })
      await page.waitForFunction(() => document.body.dataset.worldLayout === 'desktop')
    }
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.waitForFunction(() => document.body.dataset.worldLayout === 'desktop')
    await page.locator('[data-world-taskbar="dsh"]').click()
    await page.waitForTimeout(200)
    assert.deepEqual(await page.locator('.world-window-frame').boundingBox(), original, 'desktop DSH geometry is restored')
    assert.deepEqual(await page.locator('.world-browser-window').boundingBox(), originalBrowser, 'desktop browser geometry is restored')
    assert.equal(await page.locator('.world-browser-window').evaluate(node => node.inert), false)

    // Boot narrow with desktop rectangles already saved; no phone rectangle is written back.
    await page.setViewportSize({ width: 360, height: 640 })
    await page.reload()
    await page.evaluate(installBrowserProbe)
    await page.addScriptTag({ content: bundleText })
    await page.waitForFunction(() => document.body.dataset.worldLayout === 'phone')
    await page.locator('[data-world-icon-id="dsh"]').tap()
    await fullApp('#root')
    await page.setViewportSize({ width: 601, height: 640 })
    await page.waitForFunction(() => document.body.dataset.worldLayout === 'desktop')
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.waitForFunction(() => document.body.dataset.worldLayout === 'desktop')
    await page.waitForTimeout(200)
    assert.deepEqual(await page.locator('.world-window-frame').boundingBox(), original, 'narrow boot preserves saved desktop geometry')
    await page.evaluate(() => window.__worldTesting.dispose())
    assert.equal(await page.locator('[data-world-phone-hidden]').count(), 0)
    assert.equal(await page.locator('#host-ui').evaluate(node => node.inert), false)

    await page.setViewportSize({ width: 360, height: 640 })
    await page.reload()
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '0px')
      localStorage.setItem('dsh.world.fileLinks', JSON.stringify(Array.from({ length: 40 }, (_, index) => ({
        id: `file:phone-${index}`, name: `文件 ${index}`, path: `/workspace/file-${index}.txt`, type: 'file',
      }))))
    })
    await page.addScriptTag({ content: bundleText })
    await page.waitForFunction(() => document.body.dataset.worldLayout === 'phone')
    const scroll = await page.locator('.world-icons').evaluate(node => {
      node.scrollTop = node.scrollHeight
      return { top: node.scrollTop, height: node.clientHeight, content: node.scrollHeight, width: node.clientWidth, scrollWidth: node.scrollWidth }
    })
    assert.ok(scroll.top > 0 && scroll.content > scroll.height, 'long icon grids scroll vertically')
    assert.equal(scroll.width, scroll.scrollWidth, 'the phone desktop never scrolls sideways')
    await page.locator('.world-icons').evaluate(node => { node.scrollTop = 0 })
    await page.locator('[data-world-icon-id="dsh"]').tap()
    const webApp = await page.locator('#root').boundingBox()
    assert.equal(await page.locator('.world-desktop-titlebar').evaluate(node => node.getBoundingClientRect().height), 0)
    assert.deepEqual(webApp, { x: 0, y: 32, width: 360, height: 560 }, 'web host needs no native caption space')
    await page.evaluate(() => window.__worldTesting.dispose())
    assert.deepEqual(errors, [])
    console.log(`Phone desktop passed: ${JSON.stringify(measurements)}; touch launch, home, switching, background inert, guest suspension, saved geometry and cleanup.`)
  } finally { await page.close() }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/phone-browser.mjs')) {
  const { createRequire } = await import('node:module')
  const { build } = await import('../../pbpkg/node_modules/esbuild/lib/main.js')
  const { chromium } = createRequire(new URL('../../workflow-studio/package.json', import.meta.url))('playwright-core')
  const root = new URL('../', import.meta.url)
  const bundle = await build({ absWorkingDir: fileURLToPath(root), entryPoints: ['tests/browser-entry.js'],
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false,
    nodePaths: [fileURLToPath(new URL('../../workflow-studio/node_modules', import.meta.url))], loader: { '.css': 'text' } })
  const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  try { await checkPhoneDesktop(browser, bundle.outputFiles[0].text, fileURLToPath(new URL('../tmp/phone-shots', import.meta.url))) }
  finally { await browser.close() }
}
