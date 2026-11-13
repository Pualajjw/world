/** Verify the world caption control against the installed Host's real sidebar store and responsive layout. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, symlink, cp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { startProcess, waitFor } from '../../pbpkg/tests/browser-process.js'
import { dismissOnboarding } from '../../pbpkg/tests/browser-state.js'

const root = join(import.meta.dirname, '..'), run = await mkdtemp(join(tmpdir(), 'world-sidebar-runtime-'))
const home = join(run, 'home'), profile = join(home, 'profiles/web'), target = join(profile, 'node_modules/@local/dsh-world')
await mkdir(join(profile, 'node_modules/@local'), { recursive: true })
const packed = process.env.WORLD_TEST_SIDEBAR_PACKAGE
if (packed) { execFileSync('tar.exe', ['-xzf', packed, '-C', run], { windowsHide: true }); await cp(join(run, 'package'), target, { recursive: true }) }
else await symlink(root, target, 'junction')
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'world-sidebar-test', private: true,
  dependencies: { '@local/dsh-world': packed ? 'file:' + packed : 'link:' + root.replaceAll('\\', '/') },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/dsh-world'] } } }))
const env = { ...process.env, DSH_HOME: home }
delete env.ELECTRON_RUN_AS_NODE; delete env.DSH_SOURCE
const server = startProcess(process.env.DSH_TEST_CLI || 'dsh', ['--profile', 'web', '--port', '0', '--no-open'], { cwd: run, env, logPath: join(run, 'host.log') })
const require = createRequire(join(root, '../workflow-studio/package.json'))
const { chromium } = require('playwright-core')
let browser, page
try {
  const url = await waitFor(server.ready, 60000, undefined, 'DSH web startup')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', hasTouch: true })
  const errors = [], measurements = []
  page.on('pageerror', error => errors.push(error.message))
  await dismissOnboarding(page)
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-world-icon-id="dsh"]').waitFor()
  // Activate Windows chrome after Web bootstrap: a real Electron preload is not present in this browser.
  await page.evaluate(() => {
    document.documentElement.dataset.platform = 'win32'
    document.documentElement.setAttribute('data-windows-titlebar', '')
    document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '40px')
  })
  await page.locator('[data-world-icon-id="dsh"]').dblclick()
  const toggle = page.locator('[data-world-sidebar-toggle]')
  const collapsed = async value => page.waitForFunction(value => {
    const frame = document.querySelector('#root [data-shell-overlay]')?.parentElement
    return frame && frame.hasAttribute('data-sidebar-collapsed') === value
  }, value)
  const sidebarPainted = async () => page.waitForFunction(() => {
    const frame = document.querySelector('#root [data-shell-overlay]')?.parentElement
    let column = frame?.querySelector('[data-sidebar-toggle]')
    while (column && column.parentElement !== frame) column = column.parentElement
    if (!frame || !column) return false
    const box = column.getBoundingClientRect(), outer = frame.getBoundingClientRect()
    return box.width > 1 && Math.abs(box.x - outer.x) < 1 && getComputedStyle(column).visibility === 'visible'
  })
  const geometry = async stage => {
    await page.waitForFunction(() => Math.abs(document.querySelector('[data-world-sidebar-toggle]').getBoundingClientRect().width - 28) < .05)
    const value = await toggle.evaluate(button => {
      const rect = button.getBoundingClientRect(), title = button.closest('.world-titlebar').getBoundingClientRect()
      const brand = button.closest('.world-titlebar').querySelector('.world-title > svg').getBoundingClientRect()
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return { x: Math.round(rect.x), y: Math.round(rect.y), left: Math.round(rect.x - title.x), top: Math.round(rect.y - title.y),
        width: Math.round(rect.width), height: Math.round(rect.height), titleInset: Math.round(brand.x - title.x),
        clickable: button.contains(hit), expanded: button.getAttribute('aria-expanded') }
    })
    assert.deepEqual({ left: value.left, top: value.top, width: value.width, height: value.height }, { left: 12, top: 6, width: 28, height: 28 })
    assert.equal(value.clickable, true)
    assert.equal(value.titleInset, 54, 'the existing title inset of 14px shifts right by 40px')
    measurements.push({ stage, ...value }); return value
  }
  await toggle.click()
  await collapsed(false)
  await sidebarPainted()
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
  const initial = await geometry('normal-open')
  assert.equal(await page.locator('#root [data-sidebar-toggle]').isVisible(), false)
  await page.screenshot({ path: join(run, 'desktop-sidebar-open.png') })
  await toggle.click(); await collapsed(true)
  await geometry('normal-closed')
  const title = await page.locator('.world-titlebar').boundingBox()
  await page.mouse.move(title.x + 220, title.y + 20); await page.mouse.down()
  await page.mouse.move(title.x + 285, title.y + 59, { steps: 8 }); await page.mouse.up()
  await page.waitForFunction(oldX => document.querySelector('[data-world-sidebar-toggle]').getBoundingClientRect().x > oldX + 60, initial.x)
  await geometry('dragged')
  await page.locator('.world-window-frame [aria-label="最大化"]').click()
  await page.waitForFunction(() => document.body.dataset.worldWindow === 'max')
  await collapsed(false) // Widening restores the native desktop preference.
  await toggle.click(); await collapsed(true)
  await geometry('maximized')
  await page.locator('.world-window-frame [aria-label="最小化"]').click()
  await page.waitForFunction(() => document.body.dataset.worldWindow === 'min')
  await toggle.waitFor({ state: 'hidden' })
  assert.equal(await toggle.isVisible(), false)
  await page.locator('[data-world-icon-id="dsh"]').dblclick()
  await toggle.waitFor({ state: 'visible' })
  await geometry('restored')
  // Phone Web uses the native sidebar drawer, not the Windows caption model.
  await page.evaluate(() => {
    document.documentElement.removeAttribute('data-windows-titlebar')
    document.documentElement.removeAttribute('data-platform')
    document.documentElement.style.removeProperty('--dsh-windows-titlebar-height')
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForFunction(() => document.body.dataset.worldLayout === 'phone')
  await collapsed(true)
  await toggle.tap(); await collapsed(false)
  await page.waitForFunction(() => document.querySelector('#root [data-shell-overlay]').parentElement.hasAttribute('data-sidebar-drawer'))
  await sidebarPainted()
  await geometry('phone-open')
  await page.screenshot({ path: join(run, 'phone-sidebar-open.png') })
  await toggle.tap(); await collapsed(true)
  await geometry('phone-closed')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'passed', run, measurements }))
} catch (error) {
  await page?.screenshot({ path: join(run, 'failure.png') }).catch(() => {})
  console.error('Private diagnostics:', run)
  console.error((await readFile(join(run, 'host.log'), 'utf8')).slice(-5000).replace(/([?&]token=)[^\s"'<>]+/g, '$1[redacted]'))
  throw error
} finally { await browser?.close(); await server.stop() }
