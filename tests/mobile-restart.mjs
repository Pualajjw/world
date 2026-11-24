/** Real DSH restart acceptance: the QR stays byte-identical and the phone never re-scans.
 * Needs DSH_TEST_CLI (or `dsh` on PATH) and a free WORLD_TEST_RESTART_PORT (default 53319). */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { startProcess, waitFor } from '../../pbpkg/tests/browser-process.js'
import { dismissOnboarding, browserLaunchOptions } from '../../pbpkg/tests/browser-state.js'

const root = join(import.meta.dirname, '..')
const PORT = Number(process.env.WORLD_TEST_RESTART_PORT ?? 53319)
const cli = process.env.DSH_TEST_CLI || 'dsh'
const run = await mkdtemp(join(tmpdir(), 'world-mobile-restart-'))
const home = join(run, 'home'), profile = join(home, 'profiles/web')
await mkdir(join(profile, 'node_modules/@local'), { recursive: true })
await symlink(root, join(profile, 'node_modules/@local/dsh-world'), 'junction')
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'world-restart-test', private: true,
  dependencies: { '@local/dsh-world': 'link:' + root.replaceAll('\\', '/') },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/dsh-world'] } } }))
const env = { ...process.env, DSH_HOME: home, WORLD_MOBILE_HOST: '127.0.0.1', WORLD_MOBILE_PORT: String(PORT) }
delete env.ELECTRON_RUN_AS_NODE; delete env.DSH_SOURCE
const require = createRequire(join(root, '../workflow-studio/package.json'))
const { chromium } = require('playwright-core')
let browser, ownedServer, index = 0

async function boot() {
  index++
  const server = ownedServer = startProcess(cli, ['--profile', 'web', '--port', '0', '--no-open'],
    { cwd: run, env, logPath: join(run, `host-${index}.log`) })
  const address = await waitFor(server.ready, 60000, undefined, `DSH web startup #${index}`)
  return { server, address }
}
async function openQr(address, enable = false) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' })
  await dismissOnboarding(page)
  await page.goto(address, { waitUntil: 'domcontentloaded' })
  await page.locator('.world-start-button').waitFor({ timeout: 30000 })
  await page.locator('.world-start-button').click()
  const pending = page.waitForResponse(response => response.url().endsWith('/api/world-mobile/open'))
  await page.locator('[data-world-mobile-open]').click()
  const packet = await (await pending).json()
  assert.equal(packet.result.ok, true, JSON.stringify(packet.result.error))
  await page.locator('.world-mobile-qr svg').waitFor({ timeout: 30000 })
  if (enable) {
    const saved=page.waitForResponse(r=>r.url().endsWith('/api/world-startup/set'))
    await page.getByRole('checkbox',{name:'随 World 启动手机连接'}).check()
    assert.equal((await (await saved).json()).result.value.state,'enabled')
  }
  await page.close()
  return packet.result.value.url
}
const pair = async url => {
  const origin = new URL(url).origin
  const token = new URLSearchParams(new URL(url).hash.slice(1)).get('world-pair')
  const response = await fetch(origin + '/_world_mobile/pair', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }),
  })
  assert.equal(response.status, 200, `pairing failed: ${response.status}`)
  return response.headers.get('set-cookie').split(';')[0]
}
const pageStatus = async (origin, cookie) => {
  const response = await fetch(origin + '/', { headers: { cookie } })
  const text = await response.text()
  return { status: response.status, isWorld: text.includes('__WORLD_MOBILE_ACCESS__'),
    isPairPage: text.includes('请在电脑上打开「手机连接」'), bytes: text.length }
}
try {
  browser = await chromium.launch(browserLaunchOptions())
  const first = await boot()
  const url1 = await openQr(first.address,true)
  const cookie = await pair(url1)
  const before = await pageStatus(new URL(url1).origin, cookie)
  assert.equal(before.isWorld, true, 'the phone is inside world before the restart')
  const key = JSON.parse(await readFile(join(home, 'world', 'mobile.json'), 'utf8'))
  await first.server.stop()

  const second = await boot()
  // Verify the listener and the original phone login before opening any desktop page.
  let after
  for (let i=0;i<100;i++) {
    try { after=await pageStatus(new URL(url1).origin,cookie); if (after.isWorld) break } catch { /* still starting */ }
    await new Promise(resolve=>setTimeout(resolve,100))
  }
  assert.equal(after?.isWorld,true,'the saved phone works without a desktop reopening the QR')
  const url2 = await openQr(second.address)
  assert.equal(url2, url1, 'the QR is byte-identical after a real DSH restart')
  assert.equal(after.status, 200)
  assert.equal(after.isWorld, true, 'the old phone cookie still loads world after the restart')
  assert.equal(after.isPairPage, false, 'the phone was not sent back to the pairing page')
  const key2 = JSON.parse(await readFile(join(home, 'world', 'mobile.json'), 'utf8'))
  assert.equal(key2.token, key.token, 'the stored key survived the restart')
  await second.server.stop()
  console.log(JSON.stringify({ result: 'passed', run, qrStable: true, phoneKeptWithoutRescan: true,
    before, after, webPortChanged: new URL(first.address).port !== new URL(second.address).port }))
} catch (error) {
  console.error('Diagnostics:', run)
  const log = await readFile(join(run, `host-${index}.log`), 'utf8').catch(() => '')
  console.error(log.slice(-6000).replace(/([?&]token=)[^\s"'<>]+/g, '$1[redacted]'))
  throw error
} finally { await browser?.close(); await ownedServer?.stop() }
