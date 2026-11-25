/** Real DSH install, then repair a disabled pbnpm dependency without enabling it. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile, readFile, rename, realpath, cp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { startProcess, waitFor } from '../../pbpkg/tests/browser-process.js'
import { dismissOnboarding, browserLaunchOptions } from '../../pbpkg/tests/browser-state.js'

const plugins = resolve(import.meta.dirname, '../..'), run = await mkdtemp(join(await realpath(tmpdir()), 'world-pbnpm-test-'))
const home = join(run, 'home'), profile = join(home, 'profiles/web'), local = join(profile, 'node_modules/@local')
const gitee = process.argv.includes('--gitee'), pluginsUsed = gitee ? ['world'] : ['world', 'pbpkg']
await mkdir(local, { recursive: true })
for (const name of pluginsUsed) await symlink(join(plugins, name), join(local, `dsh-${name}`), process.platform === 'win32' ? 'junction' : 'dir')
const deps = Object.fromEntries(pluginsUsed.map(name => [`@local/dsh-${name}`, `link:${join(plugins, name).replaceAll('\\', '/')}`]))
await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, name: 'pbnpm-install-fixture', dependencies: deps,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...Object.keys(deps)] } } }))
await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
const source = join(run, 'development'), row = JSON.parse(await readFile(join(plugins, 'index.json'), 'utf8')).packages.pbnpm
await mkdir(join(source, 'pbnpm/dist'), { recursive: true }); await cp(join(plugins, row.path), join(source, row.path))
await writeFile(join(source, 'index.json'), JSON.stringify({ schema: 1, packages: { pbnpm: row } }))
await mkdir(join(home, 'pbpkg'), { recursive: true })
await writeFile(join(home, 'pbpkg/sources.json'), JSON.stringify({ version: 1, activeSourceId: 'dev', sources: [
  { id: 'dev', name: '测试开发源', type: 'local', location: source, indexPath: 'index.json' },
] }))
const env = { ...process.env, DSH_HOME: home, WORLD_MOBILE_HOST: '127.0.0.1', WORLD_MOBILE_PORT: '0' }
delete env.ELECTRON_RUN_AS_NODE; delete env.DSH_SOURCE
const server = startProcess(env.DSH_TEST_CLI || 'dsh', ['--profile', 'web', '--port', '0', '--no-open'], { cwd: run, env, logPath: join(run, 'host.log') })
const { chromium } = createRequire(join(plugins, 'workflow-studio/package.json'))('playwright-core')
let browser
try {
  const url = await waitFor(server.ready, 60000, undefined, 'DSH startup')
  browser = await chromium.launch(browserLaunchOptions()); const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await dismissOnboarding(page); await page.goto(url, { waitUntil: 'domcontentloaded' })
  const card = page.locator('[data-world-plugin-card="pbnpm"]'), start = page.locator('.world-start-button'), dialog = page.getByRole('alertdialog')
  const open = async () => { if ((await start.getAttribute('aria-expanded')) !== 'true') await start.click() }
  const source = gitee ? 'Gitee 直连' : '开发 pbpkg · 测试开发源'
  const target = join(local, 'dsh-pbnpm'), readme = join(target, 'README.md')
  const manifestPath = join(profile, 'package.json'), name = '@local/dsh-pbnpm'
  const manifest = async () => JSON.parse(await readFile(manifestPath, 'utf8'))
  let before, previousSpec
  for (const action of ['安装', '重装']) {
    await open(); await card.getByText(new RegExp(source)).waitFor({ timeout: 30000 })
    if (action === '重装') await card.getByText(/已禁用/).waitFor()
    await card.getByText(action, { exact: true }).waitFor(); await card.click()
    await dialog.getByText(new RegExp(source + '安装 pbnpm v')).waitFor()
    if (action === '重装') await dialog.getByText(/重装后仍保持禁用/).waitFor()
    await dialog.getByRole('button', { name: `确认${action}` }).click()
    const error = page.locator('.world-toast [role=alert]')
    await page.locator('.world-toast[role=status]').filter({ hasText: new RegExp(`pbnpm v.* 已${action}`) }).or(error).waitFor({ timeout: 60000 })
    if (await error.isVisible()) throw new Error(await error.innerText())
    const state = await manifest(), spec = state.dependencies[name]; assert.ok(spec); assert.notEqual(spec, previousSpec)
    const text = await readFile(readme, 'utf8'); assert.ok(text.length > 100)
    if (action === '安装') {
      before = text; previousSpec = spec; await writeFile(readme + '.tmp', 'repair me'); await rename(readme + '.tmp', readme)
      // Disable in this disposable profile without uninstalling the dependency.
      assert.ok(state.dsh.profile.bundles.includes(name)); state.dsh.profile.bundles = state.dsh.profile.bundles.filter(b => b !== name)
      await writeFile(manifestPath, JSON.stringify(state))
      if ((await start.getAttribute('aria-expanded')) === 'true') await start.click()
    } else { assert.equal(text, before); assert.ok(!state.dsh.profile.bundles.includes(name)) }
  }
  await open(); await card.getByText('重装', { exact: true }).waitFor(); await card.scrollIntoViewIfNeeded()
  if (env.WORLD_PBNPM_SHOT) await page.screenshot({ path: env.WORLD_PBNPM_SHOT })
  console.log(JSON.stringify({ run, source, card: await card.innerText(), rect: await card.boundingBox(), installed: true, repaired: true, stillDisabled: true }))
} finally { await browser?.close(); await server.stop() }
