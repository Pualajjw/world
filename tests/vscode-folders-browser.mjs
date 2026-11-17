import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { browserLaunchOptions } from '../../pbpkg/tests/browser-state.js'

const root = join(import.meta.dirname, '..'), require = createRequire(join(root, '../workflow-studio/package.json'))
const { build } = require('esbuild'), { chromium } = require('playwright-core')
const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true, format: 'iife',
  platform: 'browser', target: 'es2022', write: false, nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' } })
const browser = await chromium.launch(browserLaunchOptions())
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
  await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
  await page.exposeBinding('__worldWorkspaceList', (_source, payload) => ({ ok: true, value: {
    path: payload.path, parent: '', entries: [{ name: 'README.md', type: 'file' }], truncated: false,
  } }))
  await page.route('http://127.0.0.1/world-vscode-folders-fixture', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
  await page.goto('http://127.0.0.1/world-vscode-folders-fixture')
  const history = path => page.evaluate(path => localStorage.setItem('dsh.world.vscode.folders', JSON.stringify([path])), path)
  await page.evaluate(() => localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode'])))
  await history('C:/Projects/Demo')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const windows = page.locator('.world-vscode-window'), launch = () => page.locator('[data-world-icon-id="vscode"]').dblclick()
  const choose = async (win, path, action = '在新窗口打开') => {
    await win.locator('.world-vscode-title-btn[aria-label="打开文件夹"]').click()
    const picker = win.locator('.world-vscode-picker')
    await picker.locator('input').fill(path); await picker.locator('input').press('Enter')
    await picker.getByRole('button', { name: action, exact: true }).click()
    await picker.waitFor({ state: 'detached' })
  }
  await launch(); await windows.first().getByRole('button', { name: 'README.md', exact: true }).waitFor()
  await launch(); await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window').length === 2)
  assert.equal(await windows.nth(1).locator('.world-vscode-status-root').textContent(), '◆ 打开文件夹')
  await launch(); await launch()
  assert.equal(await windows.count(), 2, 'the blank editor also has a single instance')
  await choose(windows.nth(1), 'c:\\projects\\DEMO\\')
  assert.equal(await windows.count(), 2)
  assert.equal(await windows.first().evaluate(node => node.classList.contains('is-active')), true)
  assert.equal(await windows.nth(1).locator('.world-vscode-status-root').textContent(), '◆ 打开文件夹')
  await windows.nth(1).getByRole('button', { name: '关闭 Visual Studio Code', exact: true }).click()
  await history('C:/'); await launch()
  await windows.nth(1).getByRole('button', { name: 'README.md', exact: true }).waitFor()
  await launch(); await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window').length === 3)
  await choose(windows.nth(2), 'c:/', '打开')
  assert.equal(await windows.count(), 3)
  assert.equal(await windows.nth(1).evaluate(node => node.classList.contains('is-active')), true)
  assert.equal(await windows.nth(2).locator('.world-vscode-status-root').textContent(), '◆ 打开文件夹')
  while (await windows.count()) await windows.last().getByRole('button', { name: '关闭 Visual Studio Code', exact: true }).click()
  await history('/'); await launch()
  await windows.first().getByRole('button', { name: 'README.md', exact: true }).waitFor()
  await launch(); await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window').length === 2)
  await choose(windows.nth(1), '/')
  assert.equal(await windows.count(), 2)
  assert.equal(await windows.first().evaluate(node => node.classList.contains('is-active')), true)
  assert.equal(await windows.nth(1).locator('.world-vscode-status-root').textContent(), '◆ 打开文件夹')
  assert.deepEqual(errors, [])
  console.log('VSCode folder identity passed: Windows case/slash aliases, drive roots, POSIX root, blank instances and folder reuse.')
} finally { await browser.close() }
