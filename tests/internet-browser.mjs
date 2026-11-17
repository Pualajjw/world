import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createWorldInternet, internetDefaults, internetExecutable } from '../internet.js'
import { browserLaunchOptions } from '../../pbpkg/tests/browser-state.js'
import { createElevatedInternetProcess } from '../internet-elevated.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../../workflow-studio/package.json', import.meta.url))
const { build } = require('esbuild'), { chromium } = require('playwright-core')
const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true,
  format: 'iife', platform: 'browser', target: 'es2022', write: false,
  nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' } })
const directory = await mkdtemp(join(tmpdir(), 'world-internet-ui-'))
const bin = join(directory, 'Easy Tier 程序')
await mkdir(bin); await writeFile(internetExecutable(bin), ''); await chmod(internetExecutable(bin), 0o755)
const children = [], starts = [], calls = [], errors = []
let releaseSave, holdSave = false, connectionReady = true
const spawnFixture = (exe, args, options, elevated = false) => {
  starts.push({ exe, args })
  const fixtureArgs = ['-e', `
    console.log('正在连接节点…')
    console.error('network_secret = ' + JSON.stringify(process.argv[1]))
    setTimeout(() => console.log('peer connection added · 中文日志'), 100)
    setInterval(() => {}, 1000)
  `, args[3]]
  const child = elevated ? createElevatedInternetProcess(process.execPath, fixtureArgs, options, { requestUac: false })
    : spawn(process.execPath, fixtureArgs, options)
  children.push(child)
  return child
}
const service = createWorldInternet({ dir: directory, checkPrivileges: async () => process.platform !== 'win32',
  spawnImpl: spawnFixture, elevatedSpawnImpl: (exe, args, options) => spawnFixture(exe, args, options, true),
  connectionProbe: { read: async () => ({ connected: connectionReady, ipv4: '10.192.168.3', peerCount: 2 }), invalidate() {}, dispose() {} } })
const browser = await chromium.launch({ ...browserLaunchOptions(), ...(process.env.WORLD_BROWSER ? { executablePath: process.env.WORLD_BROWSER, channel: undefined } : {}) })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', error => errors.push(error.message))
  await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
  await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
  await page.exposeBinding('__worldInternetCall', async (_source, operation, payload) => {
    calls.push(operation)
    if (holdSave && operation === 'save') await new Promise(resolve => { releaseSave = resolve })
    try { return { ok: true, value: await service.call(operation, payload) } }
    catch (error) { return { ok: false, error: { message: error.message, code: error.code } } }
  })
  await page.route('http://127.0.0.1/world-internet-fixture', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
  await page.goto('http://127.0.0.1/world-internet-fixture')
  await page.addStyleTag({ content: ':root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#f7f9fd;--dsw-alias-label-primary:#17233c;--dsw-alias-label-secondary:#646e82;--dsw-alias-border-l2:#e1e6ee}' })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const open = async () => {
    await page.locator('.world-start-button').click()
    await page.locator('[data-world-app-card="world-internet"] .world-app-open').click()
  }
  const tray = page.locator('[data-world-internet-tray]')
  await tray.waitFor(); await tray.click()
  assert.equal(starts.length, 0, 'a pre-existing connection shows its icon without starting a new core')
  const win = page.locator('[data-world-plugin="world-internet"]')
  const app = win.locator('[data-world-internet]')
  await win.getByRole('button', { name: '启动上网', exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('[data-world-internet] input')?.disabled)
  assert.equal(await win.getByLabel('本机 IP', { exact: true }).inputValue(), '10.192.168.3')
  assert.equal(await win.getByLabel('程序目录', { exact: true }).inputValue(), internetDefaults().directory)
  assert.equal(await win.getByLabel('网络密钥', { exact: true }).getAttribute('type'), 'password')
  await win.getByLabel('程序目录', { exact: true }).fill(bin)
  await win.getByLabel('网络密钥', { exact: true }).fill('@ui! $ & " test')
  await win.getByLabel('节点地址', { exact: true }).fill('udp\\://118.178.196.123:11010')
  await win.getByRole('button', { name: '显示密钥', exact: true }).click()
  assert.equal(await win.getByLabel('网络密钥', { exact: true }).getAttribute('type'), 'text')
  await win.getByRole('button', { name: '隐藏密钥', exact: true }).click()
  holdSave = true
  await win.getByRole('button', { name: '保存配置', exact: true }).click()
  await win.getByRole('button', { name: '保存中…', exact: true }).waitFor()
  assert.equal(await win.getByRole('button', { name: '启动上网', exact: true }).isDisabled(), true)
  while (!releaseSave) await page.waitForTimeout(10)
  releaseSave(); holdSave = false
  await win.getByRole('status').filter({ hasText: '配置已保存' }).waitFor()
  assert.equal(await win.getByLabel('节点地址', { exact: true }).inputValue(), 'udp://118.178.196.123:11010')
  connectionReady = false
  await tray.waitFor({ state: 'hidden' })
  await win.getByRole('button', { name: '启动上网', exact: true }).click()
  if (process.platform === 'win32') {
    await win.getByRole('status').filter({ hasText: '请在 Windows 系统窗口中批准管理员授权' }).waitFor()
    assert.equal(await win.getByRole('button', { name: '等待授权…', exact: true }).isDisabled(), true)
  }
  await win.getByLabel('EasyTier 日志', { exact: true }).filter({ hasText: 'peer connection added' }).waitFor()
  assert.equal(await tray.count(), 0, 'a running core alone is not connected evidence')
  connectionReady = true
  await tray.waitFor()
  const trayGeometry = await tray.evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
    iconWidth: node.querySelector('svg').getBoundingClientRect().width }))
  assert.deepEqual(trayGeometry, { width: 40, height: 40, iconWidth: 20 })
  assert.equal(starts.length, 1)
  assert.equal(starts[0].args[3], '@ui! $ & " test')
  assert.ok(!(await win.getByLabel('EasyTier 日志', { exact: true }).innerText()).includes('@ui!'))
  assert.equal(await win.getByLabel('程序目录', { exact: true }).isDisabled(), true)
  const geometry = await app.evaluate(node => ({
    windowWidth: node.closest('[data-world-plugin]').getBoundingClientRect().width,
    inputHeight: node.querySelector('input').getBoundingClientRect().height,
    padding: getComputedStyle(node).padding, gap: getComputedStyle(node).gap,
    logHeight: node.querySelector('pre').getBoundingClientRect().height,
    overflow: node.scrollWidth > node.clientWidth,
  }))
  assert.equal(geometry.inputHeight, 36); assert.equal(geometry.padding, '16px'); assert.equal(geometry.gap, '12px')
  assert.equal(geometry.overflow, false); assert.ok(geometry.logHeight >= 100)
  const shots = process.env.WORLD_INTERNET_SHOTS_DIR
  if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: join(shots, 'internet-desktop.png') }) }
  await win.getByRole('button', { name: '关闭', exact: true }).click()
  assert.equal((await service.call('status')).running, true, 'closing the window keeps the connection alive')
  await tray.click()
  await win.getByRole('status').filter({ hasText: '运行中' }).waitFor()
  assert.equal(starts.length, 1)
  await win.getByRole('button', { name: '最小化', exact: true }).click()
  await page.waitForTimeout(200)
  const count = calls.filter(operation => operation === 'status').length
  await page.waitForTimeout(1200)
  assert.equal(calls.filter(operation => operation === 'status').length, count, 'minimize pauses log polling')
  await tray.click()
  connectionReady = false
  await win.getByRole('button', { name: '停止', exact: true }).click()
  await win.getByRole('status').filter({ hasText: '已停止' }).waitFor()
  await tray.waitFor({ state: 'hidden' })
  await win.getByRole('button', { name: '清空日志', exact: true }).click()
  await win.getByLabel('EasyTier 日志', { exact: true }).filter({ hasText: '启动后在这里查看' }).waitFor()
  await win.getByLabel('本机 IP', { exact: true }).fill('10.999.1.3')
  await win.getByRole('button', { name: '启动上网', exact: true }).click()
  await win.getByRole('alert').filter({ hasText: '有效的 IPv4' }).waitFor()
  await page.waitForTimeout(1200)
  assert.equal(await win.getByRole('alert').filter({ hasText: '有效的 IPv4' }).count(), 1, 'status refresh retains form errors')
  await win.getByLabel('本机 IP', { exact: true }).fill('10.192.168.3')
  await win.getByRole('button', { name: '启动上网', exact: true }).click()
  await win.getByLabel('EasyTier 日志', { exact: true }).filter({ hasText: 'peer connection added' }).waitFor()
  await page.setViewportSize({ width: 360, height: 740 })
  await page.waitForFunction(() => document.querySelector('[data-world-plugin="world-internet"]')?.getBoundingClientRect().width <= 360)
  const phone = await app.evaluate(node => ({ width: node.closest('[data-world-plugin]').getBoundingClientRect().width,
    inputHeight: node.querySelector('input').getBoundingClientRect().height, overflow: node.scrollWidth > node.clientWidth }))
  assert.equal(phone.width, 360); assert.equal(phone.inputHeight, 44); assert.equal(phone.overflow, false)
  if (shots) await page.screenshot({ path: join(shots, 'internet-phone.png') })
  children.at(-1).kill()
  await win.getByRole('alert').filter({ hasText: 'EasyTier 已退出' }).waitFor()
  assert.equal(await win.getByRole('button', { name: '启动上网', exact: true }).isEnabled(), true)
  assert.deepEqual(errors, [])
  console.log(`EasyTier UI passed: ${JSON.stringify({ geometry, trayGeometry, phone, administratorBroker: process.platform === 'win32' })}; pre-existing connection icon, click/open/restore, disconnection, real child lifecycle, logs and errors.`)
} finally {
  await browser.close(); await service.dispose(); await rm(directory, { recursive: true, force: true })
}
