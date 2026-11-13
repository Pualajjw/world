/** Real installed DSH + world in a private home, two browsers, no model calls or production state. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, symlink, readFile, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { startProcess, waitFor } from '../../pbpkg/tests/browser-process.js'
import { dismissOnboarding, browserLaunchOptions } from '../../pbpkg/tests/browser-state.js'

const root = join(import.meta.dirname, '..')
const run = await mkdtemp(join(tmpdir(), 'world-mobile-runtime-'))
const home = join(run, 'home'), profile = join(home, 'profiles/web')
await mkdir(join(profile, 'node_modules/@local'), { recursive: true })
let pluginRoot = root
if (process.env.WORLD_TEST_MOBILE_PACKAGE) {
  execFileSync('tar.exe', ['-xzf', process.env.WORLD_TEST_MOBILE_PACKAGE, '-C', run], { windowsHide: true })
  pluginRoot = join(run, 'package')
  await cp(pluginRoot, join(profile, 'node_modules/@local/dsh-world'), { recursive: true })
} else await symlink(pluginRoot, join(profile, 'node_modules/@local/dsh-world'), 'junction')
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'world-mobile-test', private: true,
  dependencies: { '@local/dsh-world': process.env.WORLD_TEST_MOBILE_PACKAGE ? 'file:' + process.env.WORLD_TEST_MOBILE_PACKAGE : 'link:' + pluginRoot.replaceAll('\\', '/') },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/dsh-world'] } } }))
const env = { ...process.env, DSH_HOME: home, WORLD_MOBILE_HOST: process.env.WORLD_TEST_MOBILE_HOST || '127.0.0.1', WORLD_MOBILE_PORT: '0' }
if (process.env.WORLD_TEST_MOBILE_AUTO === '1') delete env.WORLD_MOBILE_HOST
delete env.ELECTRON_RUN_AS_NODE; delete env.DSH_SOURCE
const server = startProcess(process.env.DSH_TEST_CLI || 'dsh', ['--profile', 'web', '--port', '0', '--no-open'], { cwd: run, env, logPath: join(run, 'host.log') })
const require = createRequire(join(root, '../workflow-studio/package.json'))
const { chromium } = require('playwright-core')
let browser
try {
  const address = await waitFor(server.ready, 60000, undefined, 'DSH web startup')
  browser = await chromium.launch(browserLaunchOptions())
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' })
  await dismissOnboarding(desktop)
  const errors = []
  desktop.on('pageerror', error => errors.push(error.message))
  await desktop.goto(address, { waitUntil: 'domcontentloaded' })
  await desktop.locator('.world-start-button').waitFor({ timeout: 30000 })
  await desktop.locator('.world-start-button').click()
  const opened = desktop.waitForResponse(response => response.url().endsWith('/api/world-mobile/open'))
  await desktop.locator('[data-world-mobile-open]').click()
  if (process.env.WORLD_TEST_MOBILE_AUTO === '1') {
    const select = desktop.getByRole('combobox', { name: '手机连接网络地址' })
    await select.waitFor()
    const host = process.env.WORLD_TEST_MOBILE_CHOICE || await select.locator('option').evaluateAll(rows => rows.find(row => row.value)?.value)
    await select.selectOption(host)
  }
  const packet = await (await opened).json()
  assert.equal(packet.result.ok, true, JSON.stringify(packet.result.error))
  const url = packet.result.value.url
  await desktop.locator('.world-mobile-qr svg').waitFor()
  assert.equal(Math.round((await desktop.locator('.world-mobile-qr').boundingBox()).width), 240)
  await desktop.screenshot({ path: join(run, 'desktop-qr.png') })
  await desktop.setViewportSize({ width: 280, height: 700 })
  await desktop.waitForFunction(() => document.querySelector('.world-mobile-qr').getBoundingClientRect().width < 240)
  const narrowQr = await desktop.locator('.world-mobile-qr').boundingBox()
  assert.equal(Math.round(narrowQr.width), Math.round(narrowQr.height))
  await desktop.setViewportSize({ width: 1280, height: 900 })
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' })
  let liveFrames = 0
  phone.on('websocket', socket => { if (new URL(socket.url()).pathname === '/api/remote.mux') socket.on('framereceived', () => { liveFrames++ }) })
  phone.on('pageerror', error => errors.push(error.message))
  await dismissOnboarding(phone)
  await phone.goto(url, { waitUntil: 'domcontentloaded' })
  await phone.locator('.world-phone-nav').waitFor({ timeout: 30000 })
  assert.equal(await phone.evaluate(() => globalThis.__WORLD_MOBILE_ACCESS__), true)
  assert.equal(new URL(phone.url()).hash, '')
  assert.equal(await phone.locator('[data-world-mobile-open]').count(), 0)
  await waitFor(new Promise(resolve => {
    const timer = setInterval(() => { if (liveFrames) { clearInterval(timer); resolve() } }, 50)
    setTimeout(() => { clearInterval(timer); resolve() }, 5000).unref()
  }), 6000, undefined, 'phone live connection')
  assert.ok(liveFrames > 0, 'the phone receives native realtime frames through the proxy')
  const call = (page, service, operation, payload) => page.evaluate(async ({ service, operation, payload }) => {
    const method = `${service}/${operation}`, rpcId = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('-')
    return (await (await fetch(`/api/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }) })).json()).result
  }, { service, operation, payload })
  const created = await call(phone, 'world-tasks', 'write', { title: '手机中文验收', content: '浏览器直连同一个后台' })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  const listed = await call(desktop, 'world-tasks', 'list', {})
  assert.equal(listed.ok, true)
  assert.match(JSON.stringify(listed.value), /手机中文验收/)
  await phone.locator('[data-world-icon-id="dsh"]').tap()
  await phone.locator('.world-phone-nav').getByRole('button', { name: '返回桌面', exact: true }).tap()
  await phone.screenshot({ path: join(run, 'phone-world.png') })
  await phone.reload({ waitUntil: 'domcontentloaded' })
  await phone.locator('.world-phone-nav').waitFor({ timeout: 30000 })
  await phone.locator('.world-phone-nav').getByRole('button', { name: '全部应用', exact: true }).tap()
  const install = phone.locator('[data-world-app-card="lanchat"] .world-app-install')
  if (await install.count()) await install.click()
  const chatEvents = phone.waitForRequest(request => new URL(request.url()).pathname === '/_world_mobile/lan-chat/api/events')
  await phone.locator('[data-world-app-card="lanchat"] .world-app-open').click()
  const chat = phone.frameLocator('.world-lanchat-frame')
  await chat.locator('body').waitFor()
  await phone.waitForFunction(() => document.querySelector('.world-lanchat-frame')?.src.includes('/_world_mobile/lan-chat/'))
  await chatEvents
  const state = await phone.evaluate(async () => (await fetch('/_world_mobile/lan-chat/api/state')).status)
  assert.equal(state, 200)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'passed', run, qrWidth: 240, sharedChineseTask: true, refresh: true, chat: true, liveFrames }))
} catch (error) {
  console.error('Private diagnostics:', run)
  // Print only sanitized diagnostics, never the authenticated root URL.
  const log = await readFile(join(run, 'host.log'), 'utf8').catch(() => '')
  console.error(log.slice(-10000).replace(/([?&]token=)[^\s"'<>]+/g, '$1[redacted]'))
  throw error
} finally { await browser?.close(); await server.stop() }
