/** Installed DSH + existing pbpkg endpoints + a real self-package replacement in a private profile. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile, readFile, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { startProcess, waitFor } from '../../pbpkg/tests/browser-process.js'
import { dismissOnboarding, browserLaunchOptions } from '../../pbpkg/tests/browser-state.js'

const root = join(import.meta.dirname, '..'), run = await mkdtemp(join(tmpdir(), 'world-update-runtime-'))
const home = join(run, 'home'), profile = join(home, 'profiles/web'), source = join(run, 'source')
await mkdir(join(profile, 'node_modules/@local'), { recursive: true })
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const bootstrap = join(run, 'bootstrap')
await mkdir(bootstrap)
for (const file of manifest.files) await cp(join(root, file), join(bootstrap, file), { recursive: true })
await writeFile(join(bootstrap, 'package.json'), JSON.stringify(manifest))
await cp(bootstrap, join(profile, 'node_modules/@local/dsh-world'), { recursive: true })
await symlink(join(root, '../pbpkg'), join(profile, 'node_modules/@local/dsh-pbpkg'), process.platform === 'win32' ? 'junction' : 'dir')
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'world-update-private-test', private: true,
  dependencies: { '@local/dsh-world': `file:${bootstrap.replaceAll('\\', '/')}`, '@local/dsh-pbpkg': `link:${join(root, '../pbpkg').replaceAll('\\', '/')}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/dsh-pbpkg', '@local/dsh-world'] } } }))
await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
await mkdir(join(source, 'package'), { recursive: true })
await cp(bootstrap, join(source, 'package'), { recursive: true })
await writeFile(join(source, 'package/package.json'), JSON.stringify({ ...manifest, version: '9.0.0' }))
execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-czf', 'world-9.0.0-universal.tgz', 'package'], { cwd: source, windowsHide: true })
const bytes = await readFile(join(source, 'world-9.0.0-universal.tgz'))
const sourceIndex = { schema: 1, packages: { world: { type: 'tgz', path: 'world-9.0.0-universal.tgz', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } } }
await writeFile(join(source, 'index.json'), JSON.stringify({ ...sourceIndex, packages: { world: { ...sourceIndex.packages.world, path: 'missing/world-9.0.0-universal.tgz' } } }))
await mkdir(join(home, 'pbpkg'), { recursive: true })
await writeFile(join(home, 'pbpkg/sources.json'), JSON.stringify({ version: 1, activeSourceId: 'update-test', sources: [
  { id: 'update-test', name: '隔离升级源', type: 'local', location: source, indexPath: 'index.json' },
] }))
const env = { ...process.env, DSH_HOME: home, WORLD_MOBILE_HOST: '127.0.0.1', WORLD_MOBILE_PORT: '0' }
delete env.ELECTRON_RUN_AS_NODE; delete env.DSH_SOURCE
const server = startProcess(process.env.DSH_TEST_CLI || 'dsh', ['--profile', 'web', '--port', '0', '--no-open'], { cwd: run, env, logPath: join(run, 'host.log') })
const require = createRequire(join(root, '../workflow-studio/package.json'))
const { chromium } = require('playwright-core')
let browser
try {
  const address = await waitFor(server.ready, 60000, undefined, 'DSH update test startup')
  browser = await chromium.launch(browserLaunchOptions())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' })
  await dismissOnboarding(page)
  await page.goto(address, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-world-update-open]').waitFor({ timeout: 30000 })
  const call = (operation, payload = {}) => page.evaluate(async ({ operation, payload }) => {
    const method = `world-update/${operation}`, rpcId = crypto.randomUUID()
    const response = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }) })
    const packet = await response.json()
    if (!packet.result.ok) throw new Error(JSON.stringify(packet.result.error))
    return packet.result.value
  }, { operation, payload })
  const info = await call('info')
  assert.equal(info.source, 'pbpkg'); assert.ok(info.dshVersion, 'DSH version must come from the real runtime anchor')
  await assert.rejects(call('check'), /WORLD_UPDATE_SOURCE_INCOMPLETE/u)
  assert.equal(JSON.parse(await readFile(join(profile, 'node_modules/@local/dsh-world/package.json'), 'utf8')).version, manifest.version)
  await writeFile(join(source, 'index.json'), JSON.stringify(sourceIndex))
  const checked = await call('check')
  assert.equal(checked.available, true); assert.equal(checked.latestVersion, '9.0.0'); assert.match(checked.sourceName, /隔离升级源/u)
  const started = await call('install', { token: checked.token, confirmed: true })
  assert.equal(started.state, 'installing')
  const deadline = Date.now() + 120000
  let state
  while (Date.now() < deadline) {
    state = await call('status')
    if (state.state === 'idle' && state.installedVersion === '9.0.0') state = { state: 'success', restartRequired: true }
    if (state.state !== 'installing') break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert.equal(state.state, 'success', JSON.stringify(state))
  const installed = JSON.parse(await readFile(join(profile, 'node_modules/@local/dsh-world/package.json'), 'utf8'))
  assert.equal(installed.version, '9.0.0')
  const saved = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.match(saved.dependencies['@local/dsh-world'], /^file:/u)
  // A new package published after the previous successful install must still be discoverable.
  await writeFile(join(source, 'package/package.json'), JSON.stringify({ ...manifest, version: '9.0.1' }))
  execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-czf', 'world-9.0.1-universal.tgz', 'package'], { cwd: source, windowsHide: true })
  const nextBytes = await readFile(join(source, 'world-9.0.1-universal.tgz'))
  await writeFile(join(source, 'index.json'), JSON.stringify({ schema: 1, packages: { world: {
    type: 'tgz', path: 'world-9.0.1-universal.tgz', size: nextBytes.length, sha256: createHash('sha256').update(nextBytes).digest('hex'),
  } } }))
  await page.locator('[data-world-update-open]').click()
  const dialog = page.locator('[data-world-update]').getByRole('dialog')
  await dialog.getByText('最新版本：v9.0.1', { exact: true }).waitFor({ timeout: 30000 })
  assert.equal(await dialog.getByRole('button', { name: '升级 world', exact: true }).isEnabled(), true)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.locator('[data-world-update-open]').click()
  await dialog.getByText('最新版本：v9.0.1', { exact: true }).waitFor()
  console.log(JSON.stringify({ result: 'passed', run, dshVersion: info.dshVersion, source: checked.sourceName,
    installedVersion: installed.version, detectedNextVersion: '9.0.1', restartRequired: state.restartRequired, nativeInstaller: true, missingSourceRecovered: true }))
} catch (error) {
  console.error('Private diagnostics:', run)
  const log = await readFile(join(run, 'host.log'), 'utf8').catch(() => '')
  console.error(log.slice(-9000).replace(/([?&]token=)[^\s"'<>]+/gu, '$1[redacted]'))
  throw error
} finally { await browser?.close(); await server.stop() }
