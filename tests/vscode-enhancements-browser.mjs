import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createTerminalFixture } from './terminal-fixture.js'

const root = join(import.meta.dirname, '..'), require = createRequire(join(root, '../workflow-studio/package.json'))
const { build } = require('esbuild'), { chromium } = require('playwright-core')
const options = { absWorkingDir: root, bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false,
  nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' } }
const bundle = await build({ ...options, entryPoints: ['tests/browser-entry.js'] })
const registryPath = join(process.env.DSH_SOURCE || 'E:/deepseek-harness', 'packages/client/shortcuts/src/client/registry.ts').replaceAll('\\', '/')
const shortcutBundle = await build({ ...options, stdin: { resolveDir: root, contents: `
  import { ShortcutRegistry } from ${JSON.stringify(registryPath)}
  const registry = new ShortcutRegistry('desktop', 'windows')
  window.__hostFileCalls = 0
  registry.register({id:'workspace.files',label:()=> '宿主文件',aliases:[],defaults:{'desktop:windows':{code:'KeyP',modifiers:['primary']}},
    regions:['page','editable','terminal'],modals:[],resolve:()=>({status:'handled',run:()=>{window.__hostFileCalls++}})})
  window.__worldShortcuts = { platform:'windows', registerFixed: command => registry.registerFixed(command) }
  window.__shortcutRegistry = registry
  window.addEventListener('keydown', event => {
    if (!event.ctrlKey || event.code !== 'KeyP') return
    const row = registry.catalog.getSnapshot()[0]
    if (row.issue || row.conflicts.length) return
    event.preventDefault(); event.stopImmediatePropagation()
    registry.dispatch({code:'KeyP',control:true,alt:false,shift:false,meta:false,repeat:false,composing:false,defaultPrevented:false},
      {region:'editable',modal:null,target:document.activeElement},()=>{})
  },true)
` } })
const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = [], calls = [], shots = process.env.WORLD_ENHANCEMENT_SHOTS_DIR || join(root, 'tmp/vscode-enhancements')
const terminalService = createTerminalFixture()
let mode = 'normal', releasePull, releasePush
const status = {
  repo: true, root: '/workspace', branch: 'master', upstream: 'origin/master', ahead: 1, behind: 1,
  remotes: ['origin'], identity: { ok: true }, files: [
    { path: 'src/main.js', open: 'src/main.js', index: 'M', worktree: ' ', staged: true },
    { path: 'README.md', open: 'README.md', index: '?', worktree: '?', untracked: true },
  ], staged: 1, changed: 1,
}
page.on('pageerror', error => errors.push(error.message))
try {
  await mkdir(shots, { recursive: true })
  await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
  await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
  await page.exposeBinding('__worldTerminalCall', async (_source, operation, payload) => {
    try { return { ok: true, value: await terminalService.call(operation, { ...payload, cwd: root }) } }
    catch (error) { return { ok: false, error: { message: error.message, code: error.code } } }
  })
  await page.exposeBinding('__worldGitCall', async (_source, operation, payload) => {
    calls.push({ operation, ...payload })
    if (operation === 'log') return { ok: true, value: { commits: [], truncated: false } }
    if (operation === 'status') return { ok: true, value: status }
    if (operation === 'pull') {
      if (mode === 'pull-error') return { ok: false, error: { message: '拉取失败：存在冲突' } }
      if (mode === 'delayed') await new Promise(resolve => { releasePull = resolve })
      return { ok: true, value: { status: { ...status, behind: 0 }, output: 'pull complete' } }
    }
    if (operation === 'push') {
      if (mode === 'push-error') return { ok: false, error: { message: '推送失败：远端拒绝' } }
      if (mode === 'delayed') await new Promise(resolve => { releasePush = resolve })
      status.ahead = 0; status.behind = 0
      return { ok: true, value: { status, output: 'push complete' } }
    }
    return { ok: false, error: { message: operation } }
  })
  await page.route('http://127.0.0.1/world-enhancements', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
    '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"><input aria-label="宿主草稿"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
  await page.goto('http://127.0.0.1/world-enhancements')
  await page.evaluate(() => localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode', 'terminal', 'browser'])))
  await page.addScriptTag({ content: shortcutBundle.outputFiles[0].text })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.locator('[data-world-icon-id="vscode"]').dblclick()
  const editor = page.locator('.world-vscode-window[data-world-vscode-key]')
  // 刚打开、还没有标签时必须是欢迎页铺满编辑区。
  // 编辑组改造之后「空组」没人认领宿主，欢迎页会留在隐藏节点里（0×0）—— 界面上就是一片空白
  {
    const welcome = editor.locator('.world-vscode-welcome')
    await welcome.waitFor()
    const box = await welcome.boundingBox(), pane = await editor.locator('.world-vscode-pane').first().boundingBox()
    assert.ok(box && pane && box.width > pane.width * 0.95, `欢迎页宽度应与格子一致，实际 ${JSON.stringify(box)} / 格子 ${JSON.stringify(pane)}`)
    assert.ok(box.height > pane.height - 40, `欢迎页高度应铺满格子（减去标签栏），实际 ${JSON.stringify(box)} / 格子 ${JSON.stringify(pane)}`)
    await welcome.getByRole('button', { name: /打开.*文件夹/u }).waitFor()
    // 浅色主题里 `.world-vscode-window :is(button…)` 那条通用规则会把按钮字刷成墨色，
    // 蓝底按钮必须自己抢回白字（原来 1.35:1，等于看不见）
    assert.equal(await welcome.getByRole('button', { name: /打开.*文件夹/u }).evaluate(node => getComputedStyle(node).color),
      'rgb(255, 255, 255)', '浅色主题下蓝底的开文件夹按钮必须是白字')
  }
  await editor.getByRole('button', { name: 'src', exact: true }).click()
  await editor.getByRole('button', { name: 'main.js', exact: true }).dblclick()
  const mainInput = editor.getByRole('textbox', { name: '编辑 main.js', exact: true })
  await mainInput.fill('alpha ALPHA\n中文 alpha\na+b alpha')
  await mainInput.press('Control+Home'); await page.keyboard.press('Control+f')
  const findbar = editor.getByRole('search', { name: '当前文件查找替换', exact: true })
  await findbar.getByRole('textbox', { name: '当前文件查找', exact: true }).fill('alpha')
  await findbar.getByRole('status').filter({ hasText: '1/4' }).waitFor()
  await findbar.getByRole('button', { name: '下一处', exact: true }).click()
  assert.deepEqual(await mainInput.evaluate(node => [node.selectionStart, node.selectionEnd]), [6, 11])
  await findbar.getByRole('button', { name: '上一处', exact: true }).click()
  assert.deepEqual(await mainInput.evaluate(node => [node.selectionStart, node.selectionEnd]), [0, 5])
  await findbar.getByRole('button', { name: '区分大小写', exact: true }).click()
  await page.keyboard.press('Control+h')
  await findbar.getByRole('textbox', { name: '当前文件替换为', exact: true }).fill('beta')
  await findbar.getByRole('button', { name: '替换', exact: true }).click()
  assert.equal(await mainInput.inputValue(), 'beta ALPHA\n中文 alpha\na+b alpha')
  await findbar.getByRole('button', { name: '全部替换', exact: true }).click()
  assert.equal(await mainInput.inputValue(), 'beta ALPHA\n中文 beta\na+b beta')
  assert.equal(await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-source/save').length), 0)
  await page.keyboard.press('Escape')
  assert.equal(await mainInput.evaluate(node => node === document.activeElement), true)
  await mainInput.press('Control+z')
  assert.equal(await mainInput.inputValue(), 'beta ALPHA\n中文 alpha\na+b alpha')
  // 行命令：Alt+↓ 移动、Shift+Alt+↓ 复制、Ctrl+/ 注释（main.js 是 JavaScript，注释符 //）
  await mainInput.fill('one\ntwo\nthree')
  await mainInput.press('Control+Home')
  await page.keyboard.press('Alt+ArrowDown')
  assert.equal(await mainInput.inputValue(), 'two\none\nthree', 'Alt+↓ 把当前行下移一行')
  assert.deepEqual(await mainInput.evaluate(node => [node.selectionStart, node.selectionEnd]), [4, 4], '光标跟着行一起走')
  await page.keyboard.press('Shift+Alt+ArrowDown')
  assert.equal(await mainInput.inputValue(), 'two\none\none\nthree', 'Shift+Alt+↓ 复制当前行')
  await mainInput.fill('const a = 1\nconst b = 2')
  await mainInput.press('Control+Home')
  await page.keyboard.press('Control+Slash')
  assert.equal(await mainInput.inputValue(), '// const a = 1\nconst b = 2', 'Ctrl+/ 注释当前行')
  await page.keyboard.press('Control+Slash')
  assert.equal(await mainInput.inputValue(), 'const a = 1\nconst b = 2', '再按一次取消注释')
  await mainInput.fill('// preserved draft')
  await page.keyboard.press('Control+p')
  await editor.locator('.world-vscode-quickopen').waitFor()
  assert.equal(await page.evaluate(() => window.__hostFileCalls), 0, 'the real shortcut registry reserves Ctrl+P for the focused editor')
  await page.keyboard.press('Escape')
  assert.equal(await editor.locator('.world-vscode-file[data-git-state="M"]').filter({ hasText: 'main.js' }).count(), 1)
  assert.equal(await editor.locator('.world-vscode-file[data-git-state="M"]').filter({ hasText: 'src' }).count(), 1)
  assert.equal(await editor.locator('.world-vscode-file[data-git-state="U"]').filter({ hasText: 'README.md' }).count(), 1)
  await editor.getByRole('button', { name: '源代码管理', exact: true }).click()
  const refresh = editor.getByRole('button', { name: '刷新 Git 状态', exact: true })
  assert.equal(await refresh.evaluate(node => node.previousElementSibling.classList.contains('world-vscode-status-branch')), true)
  assert.equal(await editor.locator('.world-vscode-git .world-vscode-git-refresh').count(), 0)
  mode = 'delayed'
  const sync = editor.locator('.world-vscode-git-actions button').first()
  await sync.click()
  await page.waitForFunction(() => document.querySelector('.world-vscode-git-actions button[aria-busy="true"]'))
  await sync.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  assert.equal(calls.filter(call => call.operation === 'pull').length, 1)
  assert.equal(calls.filter(call => call.operation === 'push').length, 0)
  assert.equal(await refresh.isDisabled(), true)
  releasePull()
  await page.getByText('拉取完成，正在推送…', { exact: true }).waitFor()
  while (!releasePush) await page.waitForTimeout(10)
  assert.equal(await editor.getByRole('button', { name: '同步中…', exact: true }).isDisabled(), true)
  releasePush()
  await sync.waitFor()
  assert.deepEqual(calls.filter(call => ['pull', 'push'].includes(call.operation)).map(call => call.operation), ['pull', 'push'])
  assert.equal(calls.find(call => call.operation === 'push').root, '/workspace')
  mode = 'pull-error'; await sync.click()
  await editor.getByRole('alert').filter({ hasText: '拉取失败' }).waitFor()
  assert.equal(calls.filter(call => call.operation === 'push').length, 1, 'a failed pull must never push')
  mode = 'push-error'; await sync.click()
  await editor.getByRole('alert').filter({ hasText: '推送失败' }).waitFor()
  mode = 'normal'; await sync.click()
  await editor.getByRole('status').filter({ hasText: 'push complete' }).waitFor()
  await refresh.click()
  assert.equal(await mainInput.inputValue(), '// preserved draft')
  await page.screenshot({ path: join(shots, 'git.png') })

  // Move a running terminal, rather than opening a replacement instance.
  await page.locator('[data-world-icon-id="terminal"]').dblclick()
  const terminal = page.locator('.world-terminal-window')
  const terminalInput = terminal.getByRole('textbox').first()
  await terminalInput.fill('echo preserved-terminal')
  const dockWindow = async (title, area, xFraction = .5, yFraction = .5) => {
    await title.evaluate(node => { for (const animation of node.closest('section').getAnimations()) animation.finish() })
    const source = await title.boundingBox(), target = await area.boundingBox()
    await page.mouse.move(source.x + Math.min(100, source.width / 3), source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(target.x + target.width * xFraction, target.y + target.height * yFraction, { steps: 15 })
    await page.mouse.up()
  }
  await dockWindow(terminal.locator('.world-vscode-titlebar'), editor.locator('.world-vscode-tabs').first())
  await editor.getByRole('tab', { name: '终端', exact: false }).waitFor()
  assert.equal(await terminalInput.inputValue(), 'echo preserved-terminal')
  assert.equal(await editor.locator('.world-terminal-window').count(), 1)
  assert.equal(await page.locator('[data-world-taskbar="terminal"]').count(), 0)
  assert.equal(await terminal.locator('.world-vscode-titlebar').isVisible(), false)
  await editor.getByRole('tab', { name: /main.js/u }).click()
  assert.equal(await mainInput.inputValue(), '// preserved draft')
  const splitTab = async (tab, pane, xFraction, yFraction) => {
    const target = await pane.boundingBox()
    await tab.dragTo(pane, { targetPosition: { x: target.width * xFraction, y: target.height * yFraction } })
  }
  await splitTab(editor.getByRole('tab', { name: /终端/u }), editor.locator('.world-vscode-pane:not(.is-hidden)').first(), .9, .5)
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window[data-world-vscode-key] .world-vscode-pane:not(.is-hidden)').length === 2)
  let panes = editor.locator('.world-vscode-pane:not(.is-hidden)')
  const boxes = await panes.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height } }))
  assert.ok(Math.abs(boxes[0].width - boxes[1].width) < 1)
  assert.equal(boxes[0].y, boxes[1].y)

  // 分隔条：拖动改比例、拖不出最小宽度、双击回等分、方向键微调
  const sash = editor.locator('.world-vscode-sash.is-row').first()
  const sashBox = await sash.boundingBox()
  const total = boxes[0].width + boxes[1].width
  const dragSash = async dx => {
    await page.mouse.move(sashBox.x + sashBox.width / 2, sashBox.y + sashBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(sashBox.x + sashBox.width / 2 + dx, sashBox.y + sashBox.height / 2, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(100)
    return panes.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width))
  }

  const dragged = await dragSash(150)
  assert.ok(Math.abs(dragged[0] - dragged[1]) > 250, `divider moves: ${dragged.join('/')}`)
  assert.ok(Math.abs(dragged[0] + dragged[1] - total) < 1, `total width unchanged: ${dragged.join('/')}`)
  await sash.dblclick()
  const reset = await panes.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width))
  assert.ok(Math.abs(reset[0] - reset[1]) < 1, `double click restores halves: ${reset.join('/')}`)
  const clamped = await dragSash(-800)
  assert.ok(Math.min(...clamped) >= 178, `both sides stay readable: ${clamped.join('/')}`)
  await sash.dblclick()
  await sash.focus()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(120)
  const keyed = await panes.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width))
  // 复位后是等分，一次方向键把差拉开 2×3%
  assert.ok(Math.abs(Math.abs(keyed[0] - keyed[1]) - total * 0.06) < 6, `arrow key nudges by 3%: ${keyed.join('/')}`)
  await sash.dblclick()
  await mainInput.fill('// split draft')
  await page.evaluate(() => window.__worldTesting.setFile('/workspace/README.md', 'second alpha file'))
  await editor.getByRole('button', { name: '资源管理器', exact: true }).click()
  await editor.getByRole('button', { name: 'README.md', exact: true }).dblclick()
  await editor.getByRole('textbox', { name: '编辑 README.md', exact: true }).waitFor()
  await splitTab(editor.getByRole('tab', { name: /main.js/u }), panes.filter({ has: page.getByRole('textbox', { name: '编辑 README.md', exact: true }) }), .1, .5)
  assert.equal(await mainInput.inputValue(), '// split draft')
  assert.equal(await editor.getByRole('textbox', { name: '编辑 README.md', exact: true }).inputValue(), 'second alpha file')
  assert.ok(await mainInput.locator('..').locator('.world-vscode-gutter-row').count() > 0, 'split source retains line numbers')
  await editor.getByRole('button', { name: '关闭标签 README.md', exact: true }).click()
  await page.locator('[data-world-icon-id="browser"]').dblclick()
  const browserWindow = page.locator('.world-browser-window')
  await page.route('http://world-dock.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<input aria-label="网页草稿"><div>embedded page</div>' }))
  await browserWindow.locator('[data-world-browser-address]').fill('http://world-dock.test/docked-page')
  await browserWindow.locator('[data-world-browser-address]').press('Enter')
  const browserDraft = browserWindow.frameLocator('iframe').getByRole('textbox', { name: '网页草稿', exact: true })
  await browserDraft.fill('browser draft survives')
  await dockWindow(browserWindow.locator('.world-vscode-titlebar'), panes.nth(1), .5, .9)
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window[data-world-vscode-key] .world-vscode-pane:not(.is-hidden)').length === 3)
  assert.equal(await terminalInput.inputValue(), 'echo preserved-terminal')
  assert.equal(await editor.getByRole('textbox', { name: '编辑 main.js', exact: true }).inputValue(), '// split draft')
  const three = await panes.evaluateAll(nodes => nodes.map(node => { const r=node.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height} }))
  assert.ok(Math.abs(three[1].h-three[2].h)<1)
  assert.equal(three[1].x, three[2].x)
  assert.ok(Math.abs(three[0].w-three[1].w)<1)
  assert.equal(await browserWindow.locator('[data-world-browser-address]').isVisible(), true)
  assert.equal(await browserDraft.inputValue(), 'browser draft survives', 'moving an iframe ancestor must preserve its browsing context')
  await mainInput.fill('split alpha alpha')
  await page.keyboard.press('Control+h')
  await findbar.getByRole('textbox', { name: '当前文件查找', exact: true }).fill('alpha')
  await findbar.getByRole('textbox', { name: '当前文件替换为', exact: true }).fill('beta')
  await findbar.getByRole('button', { name: '全部替换', exact: true }).click()
  assert.equal(await mainInput.inputValue(), 'split beta beta')
  assert.equal(await terminalInput.inputValue(), 'echo preserved-terminal')
  await page.screenshot({ path: join(shots, 'text-find-replace.png') })
  await page.keyboard.press('Escape')
  await page.screenshot({ path: join(shots, 'recursive-split.png') })
  await editor.getByRole('tab', { name: /^浏览器/u }).dragTo(editor.locator('.world-vscode-tabs').first())
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window[data-world-vscode-key] .world-vscode-pane:not(.is-hidden)').length === 2)
  assert.equal(await browserDraft.inputValue(), 'browser draft survives', 'merging panes preserves the embedded page')
  await editor.getByRole('button', { name: '关闭标签 浏览器', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.world-browser-window')?.closest('.world-dock-host')?.classList.contains('is-docked'))
  assert.equal(await browserWindow.locator('.world-vscode-titlebar').isVisible(), true)
  assert.equal(await browserDraft.inputValue(), 'browser draft survives')
  await browserWindow.getByRole('button', { name: '关闭', exact: true }).click()
  await editor.getByRole('button', { name: '关闭标签 终端', exact: true }).click()
  assert.equal(await terminalInput.inputValue(), 'echo preserved-terminal')
  await page.locator('[data-world-taskbar="terminal"]').waitFor()
  await page.locator('[data-world-icon-id="dsh"]').dblclick()
  const hostDraft = page.getByRole('textbox', { name: '宿主草稿', exact: true })
  await hostDraft.fill('host draft survives')
  await dockWindow(page.locator('.world-window-frame .world-titlebar'), editor.locator('.world-vscode-pane:not(.is-hidden)').first(), .1, .5)
  await editor.getByRole('tab', { name: /DeepSeek Harness/u }).waitFor()
  assert.equal(await hostDraft.inputValue(), 'host draft survives')
  assert.equal(await editor.locator('#root').count(), 1)
  await editor.getByRole('button', { name: '关闭标签 DeepSeek Harness', exact: true }).click()
  assert.equal(await hostDraft.inputValue(), 'host draft survives')
  assert.equal(await editor.locator('#root').count(), 0)
  await page.locator('[data-world-taskbar="dsh"]').click()
  await page.locator('.world-window-frame').getByRole('button', { name: '最小化', exact: true }).click()
  await page.getByRole('button', { name: '开始', exact: true }).click()
  await page.locator('[data-world-plugin-card="workflow-studio"]').click()
  const plugin = page.locator('[data-world-plugin="workflow-studio"]')
  const pluginIdentity = await plugin.locator('.world-plugin-test-page').evaluate(node => { node.dataset.testIdentity = 'same-instance'; return node.dataset.testIdentity })
  await dockWindow(plugin.locator('.world-plugin-titlebar'), editor.locator('.world-vscode-tabs').first())
  await editor.locator('[data-world-plugin="workflow-studio"]').waitFor()
  assert.equal(await plugin.locator('.world-plugin-test-page').getAttribute('data-test-identity'), pluginIdentity)
  await editor.getByRole('button', { name: '关闭标签 工作流', exact: true }).click()
  assert.equal(await plugin.locator('.world-plugin-test-page').getAttribute('data-test-identity'), pluginIdentity)
  await plugin.getByRole('button', { name: '关闭', exact: true }).click()
  await mainInput.press('Control+s')
  await page.waitForFunction(() => !document.querySelector('.world-vscode-tab.is-dirty'))
  await page.locator('[data-world-taskbar="terminal"]').click()
  await dockWindow(terminal.locator('.world-vscode-titlebar'), editor.locator('.world-vscode-tabs').first())
  await editor.locator('.world-terminal-window').waitFor()
  await editor.getByRole('button', { name: '关闭 Visual Studio Code', exact: true }).click()
  await editor.waitFor({ state: 'detached' })
  assert.equal(await terminalInput.inputValue(), 'echo preserved-terminal', 'closing the editor releases the existing app window')
  await page.locator('[data-world-taskbar="terminal"]').waitFor()
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'passed', shots, split: three, git: 'pull then push; pull failure stops; push failure retries; one in flight', drafts: 'preserved' }))
} catch (error) { console.log('Errors', errors); await page.screenshot({ path: join(shots, 'failure.png') }).catch(() => {}); throw error }
finally { await page.close(); await browser.close(); await terminalService.dispose() }
