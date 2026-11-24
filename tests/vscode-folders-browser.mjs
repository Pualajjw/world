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
  const rootPath = 'C:/Projects/Demo', waiting = new Map(), counts = new Map()
  const file = name => ({ name, type: 'file' }), dir = name => ({ name, type: 'directory' })
  const listed = (path, entries) => ({ ok: true, value: { path, parent: '', entries, truncated: false } })
  const extra = 'D:/Shared'
  let version = 1
  await page.exposeBinding('__worldWorkspaceList', async (_source, { path }) => {
    counts.set(path, (counts.get(path) || 0) + 1)
    if (path === extra) return listed(path, [dir('docs')])
    if (path === extra + '/docs') return listed(path, [file('file-2.js')])
    if (path === rootPath) return listed(path, [dir('src'), dir('empty'), dir('retry'), file('README.md')])
    if (path.startsWith(rootPath + '/')) {
      const name = path.slice(rootPath.length + 1)
      await new Promise(resolve => waiting.set(name, resolve))
      waiting.delete(name)
      if (name === 'retry' && counts.get(path) === 1) return { ok: false, error: { message: 'test list failure' } }
      return listed(path, name === 'empty' ? [] : [file(`file-${version}.js`)])
    }
    return listed(path, [file('README.md')])
  })
  await page.route('http://127.0.0.1/world-vscode-folders-fixture', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
  await page.goto('http://127.0.0.1/world-vscode-folders-fixture')
  const history = path => page.evaluate(path => localStorage.setItem('dsh.world.vscode.folders', JSON.stringify([path])), path)
  await page.evaluate(() => localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode'])))
  await history('C:/Projects/Demo')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const windows = page.locator('.world-vscode-window'), launch = () => page.locator('[data-world-icon-id="vscode"]').dblclick()
  const choose = async (win, path, action = '在新窗口打开') => {
    if (action === '添加') await win.getByRole('button', { name: '添加文件夹到工作区' }).click()
    else await win.locator('.world-vscode-title-btn[aria-label="打开文件夹"]').click()
    const picker = win.locator('.world-vscode-picker')
    await picker.locator('input').fill(path); await picker.locator('input').press('Enter')
    await picker.getByRole('button', { name: action, exact: true }).click()
    await picker.waitFor({ state: 'detached' })
  }
  await launch(); await windows.first().getByRole('button', { name: 'README.md', exact: true }).waitFor()
  const explorer = windows.first().locator('.world-vscode-explorer-list')
  const button = name => explorer.getByRole('button', { name, exact: true })
  const note = text => explorer.getByRole('status').filter({ hasText: text })
  const count = name => counts.get(`${rootPath}/${name}`) || 0
  const untilRequested = async name => {
    await page.waitForFunction(path => window.__worldTesting.calls.some(call =>
      call.method === 'world-vscode-source/list' && call.payload.path === path), `${rootPath}/${name}`)
    assert.ok(waiting.has(name))
  }
  await button('src').hover(); await untilRequested('src') // started before the click
  await button('src').click(); await note('正在读取目录').waitFor()
  await button('src').click(); await button('src').click()
  await button('empty').click(); await untilRequested('empty')
  assert.equal(await note('空目录').count(), 0)
  assert.equal(await note('正在读取目录').count(), 2)
  assert.equal(count('src'), 1)
  waiting.get('empty')(); await note('空目录').waitFor()
  assert.equal(await note('正在读取目录').count(), 1)
  waiting.get('src')(); await button('file-1.js').waitFor()
  const warmMs = await button('src').evaluate(async node => {
    node.click(); await new Promise(requestAnimationFrame)
    const start = performance.now(); node.click();
    while (!node.parentNode.querySelector('[aria-label="file-1.js"]')) await new Promise(requestAnimationFrame)
    return performance.now() - start
  })
  assert.equal(count('src'), 1)
  await button('retry').click(); await untilRequested('retry'); waiting.get('retry')()
  await note('test list failure').waitFor(); await button('retry').click(); await button('retry').click()
  await note('正在读取目录').waitFor(); waiting.get('retry')()
  await note('test list failure').waitFor({ state: 'detached' }); await button('retry').click()
  version = 2; await windows.first().getByRole('button', { name: '刷新目录', exact: true }).click()
  assert.equal(await button('file-1.js').count(), 1, 'refresh keeps previous children visible')
  await note('正在读取目录').waitFor()
  assert.equal(await note('空目录').count(), 0, 'do not advertise a previously empty directory during refresh')
  waiting.get('src')(); waiting.get('empty')(); await button('file-2.js').waitFor()
  console.log(`Tree: concurrent cold reads stay distinct, retry works, cached expand ${warmMs.toFixed(1)} ms and no extra RPC.`)
  const win = windows.first(), roots = () => explorer.locator('.world-vscode-root-name').allTextContents()
  const editor = win.getByRole('textbox', { name: '编辑 file-2.js', exact: true })
  await button('file-2.js').dblclick(); await editor.fill('keep this draft')
  await choose(win, extra, '添加'); await button('docs').waitFor()
  assert.deepEqual(await roots(), ['Demo', 'Shared'])
  assert.equal(await editor.inputValue(), 'keep this draft')
  assert.equal(await button('src').getAttribute('aria-expanded'), 'true')
  await choose(win, 'd:\\SHARED\\', '添加')
  assert.deepEqual(await roots(), ['Demo', 'Shared'])
  await button('Demo').click(); await button('docs').click(); await button('file-2.js').dblclick()
  assert.equal(await editor.inputValue(), '', 'same basename in another root opens a separate file')
  await editor.fill('save in Shared'); await editor.press('Control+s')
  const extraFile = extra + '/docs/file-2.js'
  const requested = (method, path) => page.waitForFunction(({method, root, path}) => window.__worldTesting.calls.some(call =>
    call.method === `world-vscode-source/${method}` && call.payload.root === root && call.payload.path === path), { method, root: extra, path })
  await requested('list', extra + '/docs'); await requested('open', extraFile); await requested('save', extraFile)
  const stored = ['dsh.world', 'desktop-session', 'v1'].join('.')
  await page.waitForFunction(({stored, extraFile}) => JSON.parse(localStorage.getItem(stored))?.windows.some(w =>
    w.fileSession?.active === extraFile && w.fileSession.files.length === 2), {stored, extraFile})
  await page.reload(); await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await editor.waitFor(); await requested('open', extraFile); await button('docs').waitFor()
  assert.deepEqual(await roots(), ['Demo', 'Shared'])
  assert.deepEqual(await win.locator('.world-vscode-tab-name').allTextContents(), ['file-2.js', 'file-2.js'])
  console.log('Multi-root: preserved expanded tree and draft, deduplicated Windows aliases, listed/opened/saved in the owning root and restored both file tabs.')
  await launch(); await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window').length === 2)
  assert.equal(await windows.nth(1).locator('.world-vscode-status-root').textContent(), '◆ 打开文件夹')
  await launch(); await launch()
  assert.equal(await windows.count(), 2, 'the blank editor also has a single instance')
  await choose(windows.nth(1), 'c:\\projects\\DEMO\\')
  assert.equal(await windows.count(), 2)
  assert.equal(await windows.first().evaluate(node => node.classList.contains('is-active')), true)
  assert.equal(await windows.nth(1).locator('.world-vscode-status-root').textContent(), '◆ 打开文件夹')
  await launch() // Activate the existing blank window before using its sidebar.
  await choose(windows.nth(1), 'E:/First', '添加')
  await choose(windows.nth(1), 'E:/Second', '添加')
  assert.deepEqual(await windows.nth(1).locator('.world-vscode-root-name').allTextContents(), ['First', 'Second'])
  await choose(windows.nth(1), 'E:/Replacement', '打开')
  assert.deepEqual(await windows.nth(1).locator('.world-vscode-root-name').allTextContents(), ['Replacement'])
  assert.deepEqual(await roots(), ['Demo', 'Shared'], 'replacing another workspace leaves this window intact')
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
