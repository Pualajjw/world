/** Verify world registration and the form through an isolated, authenticated DSH host. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { startProcess, waitFor } from '../../pbpkg/tests/browser-process.js'
import { dismissOnboarding, browserLaunchOptions } from '../../pbpkg/tests/browser-state.js'

const root = join(import.meta.dirname, '..'), run = await mkdtemp(join(tmpdir(), 'world-internet-runtime-'))
const home = join(run, 'home'), profile = join(home, 'profiles/web')
await mkdir(join(profile, 'node_modules/@local'), { recursive: true })
await symlink(root, join(profile, 'node_modules/@local/dsh-world'), process.platform === 'win32' ? 'junction' : 'dir')
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'world-internet-private-test', private: true,
  dependencies: { '@local/dsh-world': `link:${root.replaceAll('\\', '/')}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/dsh-world'] } } }))
await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
const env = { ...process.env, DSH_HOME: home, WORLD_MOBILE_HOST: '127.0.0.1', WORLD_MOBILE_PORT: '0' }
delete env.ELECTRON_RUN_AS_NODE; delete env.DSH_SOURCE
const server = startProcess(process.env.DSH_TEST_CLI || 'dsh', ['--profile', 'web', '--port', '0', '--no-open'], { cwd: run, env, logPath: join(run, 'host.log') })
const require = createRequire(join(root, '../workflow-studio/package.json'))
const { chromium } = require('playwright-core')
let browser
try {
  const address = await waitFor(server.ready, 60000, undefined, 'DSH internet test startup')
  browser = await chromium.launch(browserLaunchOptions())
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
  await dismissOnboarding(page)
  await page.goto(address, { waitUntil: 'domcontentloaded' })
  await page.locator('.world-start-button').click({ timeout: 30000 })
  await page.locator('[data-world-app-card="world-internet"] .world-app-open').click()
  const win = page.locator('[data-world-plugin="world-internet"]')
  await win.getByRole('status').filter({ hasText: '已停止' }).waitFor()
  assert.equal(await win.getByLabel('本机 IP', { exact: true }).inputValue(), '10.192.168.3')
  await win.getByLabel('网络密钥', { exact: true }).fill('@runtime-test!')
  await win.getByRole('button', { name: '保存配置', exact: true }).click()
  await win.getByRole('status').filter({ hasText: '配置已保存' }).waitFor()
  const stored = JSON.parse(await readFile(join(home, 'world/internet.json'), 'utf8'))
  assert.equal(stored.secret, '@runtime-test!')
  await win.getByLabel('程序目录', { exact: true }).fill(join(run, 'missing-core'))
  await win.getByRole('button', { name: '启动上网', exact: true }).click()
  await win.getByRole('alert').filter({ hasText: '找不到' }).waitFor()
  assert.equal(await win.getByRole('button', { name: '启动上网', exact: true }).isEnabled(), true)
  await win.getByLabel('程序目录', { exact: true }).fill(stored.directory)
  await win.getByRole('button', { name: '保存配置', exact: true }).click()
  await win.getByRole('status').filter({ hasText: '配置已保存' }).waitFor()
  const method = 'world-internet/status'
  const status = await page.evaluate(async method => {
    const response = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: {} }) })
    return (await response.json()).result
  }, method)
  assert.equal(status.ok, true); assert.equal(status.value.running, false)
  assert.equal(status.value.config, undefined, 'polling does not return the saved secret')
  const observations = await page.evaluate(async () => {
    const call = async method => (await (await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: {} }) })).json()).result
    return { connection: await call('world-internet/connection'), ports: await call('world-processes/ports') }
  })
  assert.equal(observations.connection.ok, true)
  assert.equal(observations.ports.ok, true)
  const hostPort = Number(new URL(address).port)
  assert.ok(observations.ports.value.rows.some(row => row.protocol === 'TCP' && row.localPort === hostPort), 'the real DSH web listener is in the scoped endpoint list')
  if (observations.connection.value.connected) {
    await win.getByRole('button', { name: '关闭', exact: true }).click()
    const tray = page.locator('[data-world-internet-tray]')
    await tray.waitFor(); await tray.click()
    await win.waitFor()
    assert.equal(await page.locator('[data-world-plugin="world-internet"]').count(), 1)
  }
  await page.locator('.world-start-button').click()
  await page.locator('[data-world-app-card="world-processes"] .world-app-open').click()
  const manager = page.locator('[data-world-plugin="world-processes"]')
  await manager.getByRole('tab', { name: '端口占用', exact: true }).click()
  await manager.getByRole('table', { name: 'DSH 端口占用列表' }).getByRole('cell', { name: `127.0.0.1:${hostPort}`, exact: true }).first().waitFor()
  if (process.env.WORLD_INTERNET_SHOTS_DIR) {
    await mkdir(process.env.WORLD_INTERNET_SHOTS_DIR, { recursive: true })
    await page.screenshot({ path: join(process.env.WORLD_INTERNET_SHOTS_DIR, 'internet-runtime.png') })
  }
  console.log(JSON.stringify({ result: 'passed', run, registeredRpc: true, realFormSave: true, missingCoreError: true,
    liveConnection: observations.connection.value.connected, realDshPort: hostPort, portCount: observations.ports.value.rows.length }))
} catch (error) {
  console.error('Private diagnostics:', run)
  console.error((await readFile(join(run, 'host.log'), 'utf8').catch(() => '')).slice(-5000).replace(/([?&]token=)[^\s"'<>]+/gu, '$1[redacted]'))
  throw error
} finally { await browser?.close(); await server.stop() }
