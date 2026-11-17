import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { browserLaunchOptions } from '../../pbpkg/tests/browser-state.js'

const root = join(import.meta.dirname, '..')
const require = createRequire(join(root, '../workflow-studio/package.json'))
const { build } = require('esbuild'), { chromium } = require('playwright-core')
const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true, format: 'iife',
  platform: 'browser', target: 'es2022', write: false, nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' } })
const browser = await chromium.launch(browserLaunchOptions())
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = [], calls = []
  let release, delay = true, failed = false
  const rows = [
    { pid: 10, startedAt: '100', name: 'DeepSeek Harness.exe', protocol: 'TCP', localAddress: '127.0.0.1', localPort: 53319, remoteAddress: '', remotePort: 0, state: 'Listen' },
    { pid: 11, startedAt: '110', name: 'world-host.exe', protocol: 'UDP', localAddress: '0.0.0.0', localPort: 53318, remoteAddress: '', remotePort: 0, state: 'BOUND' },
    { pid: 11, startedAt: '110', name: 'world-host.exe', protocol: 'TCP', localAddress: '::1', localPort: 60000, remoteAddress: '::1', remotePort: 443, state: 'Established' },
  ]
  page.on('pageerror', error => errors.push(error.message))
  await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
  await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
  await page.exposeBinding('__worldProcessesCall', async (_source, operation) => {
    if (operation !== 'ports') return { ok: true, value: { rows: [], timestamp: Date.now(), totals: { count: 0 } } }
    calls.push(operation)
    if (delay) await new Promise(resolve => { release = resolve })
    return failed ? { ok: false, error: { message: '端口权限不足' } } : { ok: true, value: { rows, timestamp: Date.now() } }
  })
  await page.route('http://127.0.0.1/world-ports-fixture', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
  await page.goto('http://127.0.0.1/world-ports-fixture')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.locator('.world-start-button').click()
  await page.locator('[data-world-app-card="world-processes"] .world-app-open').click()
  const win = page.locator('[data-world-plugin="world-processes"]')
  await win.getByRole('tab', { name: '端口占用', exact: true }).click()
  const panel = win.locator('[data-world-process-ports]')
  await panel.getByRole('button', { name: '读取中…', exact: true }).waitFor()
  while (!release) await page.waitForTimeout(10)
  delay = false; release()
  await panel.getByRole('status').filter({ hasText: '3 条端口记录' }).waitFor()
  assert.equal(await panel.locator('tbody tr').count(), 3)
  assert.match(await panel.innerText(), /\[::1\]:443/u)
  await panel.getByLabel('搜索 DSH 端口').fill('UDP')
  assert.equal(await panel.locator('tbody tr').count(), 1)
  await panel.getByLabel('搜索 DSH 端口').fill('53319')
  assert.equal(await panel.locator('tbody tr').count(), 1)
  assert.match(await panel.locator('tbody').innerText(), /DeepSeek Harness/u)
  await panel.getByLabel('搜索 DSH 端口').fill('not found')
  await panel.getByText('没有匹配的端口记录。', { exact: true }).waitFor()
  await panel.getByLabel('搜索 DSH 端口').fill('')
  await panel.getByRole('button', { name: '暂停刷新', exact: true }).click()
  const paused = calls.length
  await page.waitForTimeout(2200)
  assert.equal(calls.length, paused)
  failed = true
  await panel.getByRole('button', { name: '刷新', exact: true }).click()
  await panel.getByRole('alert').filter({ hasText: '端口权限不足' }).waitFor()
  assert.equal(await panel.locator('tbody tr').count(), 3, 'a failed read retains the last successful result')
  failed = false
  await panel.getByRole('button', { name: '刷新', exact: true }).click()
  await panel.getByRole('alert').waitFor({ state: 'hidden' })
  await panel.getByRole('button', { name: '继续刷新', exact: true }).click()
  const geometry = await panel.evaluate(node => ({ rowHeight: node.querySelector('tbody tr').getBoundingClientRect().height,
    buttonHeight: node.querySelector('button').getBoundingClientRect().height }))
  assert.deepEqual(geometry, { rowHeight: 36, buttonHeight: 36 })
  const shots = process.env.WORLD_PORT_SHOTS_DIR
  if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: join(shots, 'dsh-ports-desktop.png') }) }
  await win.getByRole('tab', { name: '进程', exact: true }).click()
  const beforeSwitch = calls.length
  await page.waitForTimeout(2200)
  assert.equal(calls.length, beforeSwitch, 'switching away pauses the ports query')
  await win.getByRole('tab', { name: '端口占用', exact: true }).click()
  await page.setViewportSize({ width: 360, height: 740 })
  await page.waitForFunction(() => document.querySelector('[data-world-plugin="world-processes"]')?.getBoundingClientRect().width <= 360)
  const phone = await panel.evaluate(node => ({ rowHeight: node.querySelector('tbody tr').getBoundingClientRect().height,
    overflow: node.scrollWidth > node.clientWidth }))
  assert.equal(phone.rowHeight, 44); assert.equal(phone.overflow, false)
  if (shots) await page.screenshot({ path: join(shots, 'dsh-ports-phone.png') })
  await win.getByRole('button', { name: '最小化', exact: true }).click()
  const beforeMinimize = calls.length
  await page.waitForTimeout(2200)
  assert.equal(calls.length, beforeMinimize)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'passed', geometry, phone, loading: true, filter: true, retry: true, pauseAndVisibility: true }))
} finally { await browser.close() }
