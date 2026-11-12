import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkLanChatInput } from './lan-chat-browser.mjs'
import { checkBrowserWindow } from './browser-frame.browser.mjs'
import { checkWindowRestore } from './window-restore.mjs'
import { checkDesktopTools } from './desktop-browser.mjs'
import { createDesktopBridge } from '../desktop-bridge.js'
import { checkDesktopControl } from './control-browser.mjs'
import { checkWorkbenchSetup } from './setup-browser.mjs'
import { checkPersonalization } from './personalization-browser.mjs'
import { checkAssistantActivity } from './activity-browser.mjs'
import { checkWalkerPoses } from './walker-pose-browser.mjs'
import { checkOwnershipOrdering } from './ownership-browser.mjs'
import { checkAssistantConversation } from './conversation-browser.mjs'
import { checkJournal } from './journal-browser.mjs'
import { checkTasks } from './tasks-browser.mjs'
import { checkWalkerMotion } from './walker-motion-browser.mjs'
import { checkIconDrag } from './icons-browser.mjs'
import { checkStartSearch } from './start-search-browser.mjs'
import { checkDesktopItems } from './desktop-items-browser.mjs'
import { checkDesktopScreenshot } from './screenshot-browser.mjs'
import { checkTerminal } from './terminal-browser.mjs'
import { checkTerminalSsh } from './ssh-browser.mjs'
import { checkPluginRoots } from './roots-browser.mjs'
import { createDesktopBrain } from '../desktop-brain.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
let build
try {
  ({ build } = await import('esbuild'))
} catch {
  ({ build } = await import(pathToFileURL(join(root, '../pbpkg/node_modules/esbuild/lib/main.js'))))
}
const require = (await import('node:module')).createRequire(join(root, '../workflow-studio/package.json'))
const { chromium } = require('playwright-core')
const browserPath = process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
if (!existsSync(browserPath)) {
  console.log(`Skipped browser interaction check: no browser at ${browserPath}`)
  process.exit(0)
}

const bundle = await build({
  absWorkingDir: root,
  entryPoints: ['tests/browser-entry.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  write: false,
  nodePaths: [join(root, '../workflow-studio/node_modules')],
  loader: { '.css': 'text' },
  legalComments: 'none',
})

const browser = await chromium.launch({ executablePath: browserPath, headless: true })
const desktopBridge = createDesktopBridge()
const brainDirectory = await mkdtemp(join(tmpdir(), 'world-brain-'))
const brain = createDesktopBrain({ sessions: { get: id => ['session-1', 'session-2'].includes(id) ? {} : null } },
  { file: join(brainDirectory, 'brain.json') })
await brain.call('configure', { sessionId: 'session-1' })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.route('http://127.0.0.1:53317/**', route => route.fulfill({
    contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><body>World app fixture</body></html>',
  }))
  await page.exposeBinding('__worldDesktopCall', (_source, operation, payload) => desktopBridge.call(operation, payload))
  await page.exposeBinding('__worldBrainCall', (_source, operation, payload) => brain.call(operation, payload))
  await page.setContent('<!doctype html><html data-windows-titlebar style="--dsh-windows-titlebar-height:40px"><head><style>#root{position:relative;width:100vw;height:100vh}.app-frame{position:relative;width:100%;height:100%;padding-top:var(--dsh-windows-titlebar-height);box-sizing:border-box}.app-frame::before{content:"";position:absolute;inset:0 0 auto;height:var(--dsh-windows-titlebar-height);-webkit-app-region:drag}#host-ui{position:absolute;inset:var(--dsh-windows-titlebar-height) 0 0;background:#262626}[data-shell-overlay]{position:absolute;inset:0;z-index:20;pointer-events:none}[data-shell-overlay]>*{pointer-events:auto}[data-testid=host-modal]{position:fixed;inset:0;z-index:1000;display:grid;place-items:center}[data-testid=host-dialog]{width:800px;height:700px;max-width:calc(100vw - 48px);max-height:calc(100vh - 48px);background:#fff;color:#111}</style></head><body><div data-windows-menu><button>Native window menu</button></div><div id="root"><div class="app-frame"><main id="host-ui"><button id="host-focus">Native DSH UI</button></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')

  const themeStyle = await page.addStyleTag({ content: `
    :root { --dsw-alias-bg-base: rgb(255, 255, 255); --dsw-alias-bg-layer-1: rgb(247, 249, 253);
      --dsw-alias-bg-layer-2: rgb(241, 243, 245); --dsw-alias-bg-layer-3: rgb(230, 234, 240);
      --dsw-alias-label-primary: rgb(23, 35, 60); --dsw-alias-label-secondary: rgb(100, 110, 130);
      --dsw-alias-label-tertiary: rgb(145, 155, 175); --dsw-alias-border-l2: rgb(225, 230, 238);
      --dsw-alias-interactive-bg-hover: rgb(235, 240, 250); --dsw-alias-interactive-bg-active: rgb(225, 233, 250);
      --dsw-alias-state-business-primary: rgb(59, 110, 246); }
    :root[data-ds-dark-theme] { --dsw-alias-bg-base: rgb(21, 21, 23); --dsw-alias-bg-layer-1: rgb(30, 32, 36);
      --dsw-alias-bg-layer-2: rgb(39, 42, 48); --dsw-alias-bg-layer-3: rgb(48, 52, 60);
      --dsw-alias-label-primary: rgb(249, 250, 251); --dsw-alias-label-secondary: rgb(190, 196, 205);
      --dsw-alias-label-tertiary: rgb(140, 148, 160); --dsw-alias-border-l2: rgb(65, 70, 80);
      --dsw-alias-interactive-bg-hover: rgb(50, 55, 65); --dsw-alias-interactive-bg-active: rgb(60, 65, 75);
      --dsw-alias-state-business-primary: rgb(90, 130, 255); }
  ` })
  await page.evaluate(() => document.documentElement.setAttribute('data-ds-dark-theme', ''))
  await page.waitForFunction(() => document.body.dataset.worldTheme === 'dark')
  assert.equal(await page.locator('.world-wall').evaluate(node => getComputedStyle(node).color), 'rgb(249, 250, 251)')
  assert.equal(await page.locator('.world-taskbar').evaluate(node => getComputedStyle(node).color), 'rgb(249, 250, 251)')
  await page.evaluate(() => document.documentElement.removeAttribute('data-ds-dark-theme'))
  await page.waitForFunction(() => document.body.dataset.worldTheme === 'light')
  assert.equal(await page.locator('.world-wall').evaluate(node => getComputedStyle(node).color), 'rgb(23, 35, 60)')
  await themeStyle.evaluate(node => node.remove())

  assert.equal(await page.locator('.world-desktop-icon').count(), 4)
  // 任务栏：开始按钮 + 3D 景深开关（窗口按钮在有窗口时才出现）
  assert.equal(await page.locator('.world-taskbar-center button').count(), 1)
  assert.equal(await page.locator('.world-depth-toggle').count(), 1)
  assert.equal(await page.locator('body').getAttribute('data-world-depth'), 'on')
  assert.equal(await page.locator('.world-floor').count(), 1)
  assert.equal(await page.locator('.world-desktop-icon').first().evaluate(element => getComputedStyle(element).perspective), 'none')
  // DSH + VSCode + 局域网聊天 + 浏览器 + 终端（0.2.37 起浏览器、0.2.81 起终端默认已安装）
  // 设置 / 插件 / 日记 / 垃圾箱 / 待办 / VSCode / 局域网聊天 / 浏览器 / 终端
  assert.equal(await page.locator('.world-start').locator('.world-app-card').count(), 9)
  assert.equal(await page.locator('.world-app-card[data-world-app-card="browser"]').count(), 1)
  assert.equal(await page.locator('[data-world-browser-icon]').count(), 1)
  assert.equal(await page.locator('.world-app-card[data-world-app-card="terminal"]').count(), 1)
  assert.equal(await page.locator('[data-world-terminal-icon]').count(), 1)
  assert.equal(await page.locator('.world-app-card[data-world-app-card="lanchat"]').count(), 1)
  assert.equal(await page.locator('#root').evaluate(rootElement => rootElement.inert), false)
  assert.equal(await page.locator('#root .app-frame').evaluate(element => getComputedStyle(element, '::before').webkitAppRegion), 'drag')
  assert.equal(await page.locator('#host-ui').evaluate(element => element.inert), true)
  assert.equal(await page.locator('[data-windows-menu]').evaluate(element => element.inert), false)
  assert.equal(await page.locator('#overlay-root').evaluate(element => element.inert), false)
  assert.deepEqual(await page.locator('.world-taskbar').evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { top: rect.top, height: rect.height }
  }), { top: 752, height: 48 })
  assert.equal(await page.locator('.world-wall').evaluate(element => element.getBoundingClientRect().top), 40)

  // 桌面右键先给菜单：个性化（打开背景面板）和刷新（重读桌面数据并重排图标）。
  await page.locator('.world-wall').click({ button: 'right', position: { x: 700, y: 320 } })
  const desktopMenu = page.locator('.world-context-menu.is-desktop')
  await desktopMenu.waitFor()
  assert.deepEqual(await desktopMenu.locator('button').evaluateAll(nodes => nodes.map(node => node.dataset.role)),
    ['personalize', 'refresh'])
  assert.equal(await page.locator('.world-wallpaper-panel').count(), 0, 'right-click no longer jumps straight into the panel')
  await desktopMenu.locator('[data-role="refresh"]').click()
  await page.locator('.world-toast').filter({ hasText: '桌面已刷新' }).waitFor()
  assert.equal(await page.locator('.world-desktop-icon').count(), 4, 'a refresh keeps the icons where they belong')
  await page.locator('.world-wall').click({ button: 'right', position: { x: 700, y: 320 } })
  await page.locator('.world-context-menu.is-desktop [data-role="personalize"]').click()
  await page.locator('.world-wallpaper-panel').waitFor()
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.world-wallpaper-panel'))
  assert.equal(await page.locator('.world-icons').evaluate(element => element.getBoundingClientRect().top), 50)

  const desktopIcon = page.getByRole('button', { name: 'DeepSeek Harness', exact: true })
  await desktopIcon.click()
  assert.equal(await desktopIcon.evaluate(element => element.classList.contains('selected')), true)
  assert.equal(await page.locator('body').getAttribute('data-world-window'), 'closed')
  await desktopIcon.dblclick()
  await page.waitForFunction(() => document.body.dataset.worldWindow === 'normal')
  assert.equal(await page.locator('#root').evaluate(rootElement => rootElement.inert), false)
  assert.equal(await page.locator('#host-ui').evaluate(element => element.inert), false)
  assert.equal(await page.locator('#root .app-frame').evaluate(element => getComputedStyle(element, '::before').webkitAppRegion), 'no-drag')
  assert.equal(await page.locator('.world-cap').first().evaluate(element => getComputedStyle(element).webkitAppRegion), 'no-drag')
  assert.equal(await page.evaluate(() => document.elementFromPoint(400, 300)?.closest('#host-ui')?.id === 'host-ui'), true)
  assert.equal(await page.evaluate(() => document.elementFromPoint(1100, 200)?.closest('.world-wall') !== null), true)
  assert.deepEqual(await page.locator('#root').evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }), { x: 256, y: 72, width: 768, height: 544 })
  assert.equal(await page.locator('#host-ui').evaluate(element => element.getBoundingClientRect().top), 112)

  for (const modalName of ['settings', 'confirmation']) {
    await page.evaluate(name => {
      const overlay = document.createElement('div')
      overlay.dataset.testid = 'host-modal'
      overlay.innerHTML = `<div data-testid="host-dialog" role="dialog" aria-label="${name}"></div>`
      document.body.append(overlay)
    }, modalName)
    assert.deepEqual(await page.locator('[data-testid="host-modal"]').last().evaluate(element => {
      const rect = element.getBoundingClientRect()
      const dialog = element.querySelector('[role="dialog"]')
      const popup = dialog.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, popupWidth: popup.width, popupHeight: popup.height }
    }), { x: 256, y: 72, width: 768, height: 544, popupWidth: 720, popupHeight: 496 })
    assert.equal(await page.evaluate(() => document.elementFromPoint(640, 344)?.getAttribute('data-testid') === 'host-dialog'), true)
    await page.locator('[data-testid="host-modal"]').last().evaluate(element => element.remove())
  }
  await page.evaluate(() => {
    const menu = document.createElement('div')
    menu.dataset.testid = 'host-menu'
    menu.setAttribute('role', 'menu')
    menu.style.cssText = 'position:fixed;left:500px;top:200px;z-index:10'
    menu.textContent = 'Menu item'
    document.body.append(menu)
  })
  assert.equal(await page.locator('[data-testid="host-menu"]').evaluate(element => getComputedStyle(element).zIndex), '1000')
  assert.equal(await page.locator('[data-testid="host-menu"]').evaluate(element => getComputedStyle(element).maxWidth), '744px')
  assert.equal(await page.evaluate(() => document.elementFromPoint(510, 210)?.getAttribute('data-testid') === 'host-menu'), true)
  await page.locator('[data-testid="host-menu"]').evaluate(element => element.remove())

  const titlebar = page.locator('.world-titlebar')
  const titlebarBox = await titlebar.boundingBox()
  const startX = titlebarBox.x + titlebarBox.width / 2
  const startY = titlebarBox.y + titlebarBox.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 50, startY + 40)
  await page.mouse.up()
  await page.waitForFunction(() => {
    const rect = document.querySelector('.world-window-frame').getBoundingClientRect()
    return Math.abs(rect.x - 306) <= 1 && Math.abs(rect.y - 112) <= 1
  })
  const moved = await page.locator('.world-window-frame').evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { x: Math.round(rect.x), y: Math.round(rect.y) }
  })
  assert.ok(moved.x >= 305 && moved.x <= 306, `unexpected horizontal drag result: ${moved.x}`)
  assert.ok(moved.y >= 111 && moved.y <= 112, `unexpected vertical drag result: ${moved.y}`)

  const titlebarAfterMove = await page.locator('.world-titlebar').boundingBox()
  const dragStartX = titlebarAfterMove.x + titlebarAfterMove.width / 2
  const dragStartY = titlebarAfterMove.y + titlebarAfterMove.height / 2
  await page.mouse.move(dragStartX, dragStartY)
  await page.mouse.down()
  await page.mouse.move(dragStartX - 276, dragStartY - 72)
  await page.mouse.up()
  await page.waitForFunction(() => {
    const rect = document.querySelector('#root').getBoundingClientRect()
    return Math.abs(rect.x - 30) <= 1 && Math.abs(rect.y - 40) <= 1
  })
  assert.equal(await page.evaluate(() => document.elementFromPoint(50, 90)?.closest('#host-ui')?.id === 'host-ui'), true)

  const eastGrip = page.locator('.world-resize-e')
  assert.equal((await eastGrip.boundingBox()).width, 8)
  const eastBox = await eastGrip.boundingBox()
  await page.mouse.move(eastBox.x + eastBox.width / 2, eastBox.y + eastBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(eastBox.x + eastBox.width / 2 + 80, eastBox.y + eastBox.height / 2)
  await page.mouse.up()
  await page.waitForFunction(() => Math.abs(document.querySelector('#root').getBoundingClientRect().width - 848) < 1)
  assert.equal(await page.locator('#root').evaluate(element => element.getBoundingClientRect().width), 848)

  await page.getByRole('button', { name: '最大化' }).click()
  await page.waitForFunction(() => document.body.dataset.worldWindow === 'max')
  assert.deepEqual(await page.locator('#root').evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }), { x: 0, y: 40, width: 1280, height: 712 })
  await page.evaluate(() => {
    const overlay = document.createElement('div')
    overlay.dataset.testid = 'host-modal'
    overlay.innerHTML = '<div data-testid="host-dialog" role="dialog" aria-label="maximized dialog"></div>'
    document.body.append(overlay)
  })
  assert.deepEqual(await page.locator('[data-testid="host-modal"]').evaluate(element => {
    const rect = element.getBoundingClientRect()
    const popup = element.querySelector('[role="dialog"]').getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, popupWidth: popup.width, popupHeight: popup.height }
  }), { x: 0, y: 40, width: 1280, height: 712, popupWidth: 800, popupHeight: 664 })
  assert.equal(await page.evaluate(() => document.elementFromPoint(640, 344)?.getAttribute('data-testid') === 'host-dialog'), true)
  await page.locator('[data-testid="host-modal"]').evaluate(element => element.remove())
  await page.getByRole('button', { name: '最小化' }).click()
  await page.waitForFunction(() => document.body.dataset.worldWindow === 'min')
  assert.equal(await page.locator('#root').evaluate(rootElement => rootElement.inert), false)
  assert.equal(await page.locator('#host-ui').evaluate(element => element.inert), true)
  await page.getByRole('button', { name: 'DeepSeek Harness', exact: true }).dblclick()
  await page.waitForFunction(() => document.body.dataset.worldWindow === 'max')
  await page.getByRole('button', { name: '关闭' }).click()
  await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')
  assert.equal(await page.locator('#root .app-frame').evaluate(element => getComputedStyle(element, '::before').webkitAppRegion), 'drag')

  await page.getByRole('button', { name: '开始' }).click()
  assert.equal(await page.locator('.world-start').evaluate(element => element.classList.contains('open')), true)
  await page.locator('.world-app-card[data-world-app-card="vscode"] .world-app-install').click()
  assert.equal(await page.locator('.world-desktop-icon').count(), 5)
  const vscodeIcon = page.getByRole('button', { name: 'Visual Studio Code' })
  await vscodeIcon.dblclick({ force: true })
  const vscodeWindow = page.locator('.world-vscode-window')
  await vscodeWindow.waitFor()
  assert.equal(await vscodeWindow.locator('.world-vscode-menubar').count(), 0)
  assert.equal(await vscodeWindow.locator('.world-vscode-activity .world-vscode-activity-btn').count(), 4)
  assert.equal(await vscodeWindow.locator('.world-vscode-sidebar-title').textContent(), '资源管理器')
  // 没有打开文件时不放一个永远点不动的「保存」按钮，也不放假的「欢迎」标签
  assert.equal(await vscodeWindow.getByRole('button', { name: '保存', exact: true }).count(), 0)
  assert.equal(await vscodeWindow.locator('.world-vscode-tab').count(), 0)
  assert.equal(await vscodeWindow.evaluate(element => getComputedStyle(element).zIndex), '5')
  assert.equal(await page.locator('#root').evaluate(element => getComputedStyle(element).zIndex), '0')
  assert.equal(await page.locator('#host-ui').evaluate(element => element.inert), true)
  await page.getByRole('button', { name: 'DeepSeek Harness', exact: true }).dblclick({ force: true })
  await page.waitForFunction(() => document.body.dataset.worldActiveWindow === 'dsh')
  assert.equal(await vscodeWindow.evaluate(element => getComputedStyle(element).zIndex), '3')
  assert.equal(await page.locator('#root').evaluate(element => getComputedStyle(element).zIndex), '4')
  await page.mouse.click(1100, 300)
  await page.waitForFunction(() => String(document.body.dataset.worldActiveWindow).startsWith('vscode'))
  assert.equal(await vscodeWindow.evaluate(element => getComputedStyle(element).zIndex), '5')
  await page.getByRole('button', { name: '关闭 Visual Studio Code' }).click()
  await vscodeWindow.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '开始' }).click()
  await page.locator('.world-app-card[data-world-app-card="vscode"] .world-app-open').click()
  await vscodeWindow.waitFor()
  await page.waitForFunction(() => String(document.body.dataset.worldActiveWindow).startsWith('vscode'))
  assert.equal(await vscodeWindow.evaluate(element => getComputedStyle(element).zIndex), '5')
  assert.deepEqual(await page.locator('.world-vscode-window').evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  }), { width: 1024, height: 640 })
  assert.equal(await page.locator('.world-vscode-file.is-dir .world-vscode-file-icon.is-dir svg').count(), 1)
  assert.equal(await page.locator('.world-vscode-file-icon.is-md svg').count(), 1)
  await page.locator('.world-vscode-file').filter({ hasText: 'src' }).click()
  assert.equal(await page.getByRole('button', { name: 'README.md', exact: true }).count(), 1)
  const nodePads = await page.locator('.world-vscode-file').evaluateAll(nodes => nodes.map(node => ({
    name: node.querySelector('.world-vscode-file-name')?.textContent || '',
    pad: Number.parseFloat(getComputedStyle(node).paddingLeft),
  })))
  assert.ok(nodePads.find(item => item.name === 'main.js').pad > nodePads.find(item => item.name === 'src').pad)
  await page.getByRole('button', { name: 'main.js', exact: true }).click()
  if (process.env.WORLD_VSCODE_SHOT) {
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.world-start')).opacity === '0')
    await page.screenshot({ path: process.env.WORLD_VSCODE_SHOT })
  }
  const editor = page.getByRole('textbox', { name: '编辑 main.js' })
  await editor.click()

  // 输入手感：Tab 走原生插入，撤销栈不能丢；Enter 继承缩进；整块缩进/反缩进
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Tab')
  assert.equal(await editor.inputValue(), 'const value = 1\n  ')
  await page.keyboard.press('Control+z')
  assert.equal(await editor.inputValue(), 'const value = 1\n')
  await page.keyboard.type('if (ready) {')
  // 打字后光标读数必须跟着走，不能停在上一次点击的位置
  assert.equal(await page.locator('.world-vscode-status-pos').textContent(), '行 2, 列 13')
  await page.keyboard.press('Enter')
  assert.equal(await editor.inputValue(), 'const value = 1\nif (ready) {\n  ')
  assert.equal(await page.locator('.world-vscode-status-pos').textContent(), '行 3, 列 3')
  await page.keyboard.type('run()')
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Tab')
  assert.equal(await editor.inputValue(), '  const value = 1\n  if (ready) {\n    run()')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await editor.inputValue(), 'const value = 1\nif (ready) {\n  run()')

  // 状态栏读数：光标位置随移动更新
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  assert.equal(await page.locator('.world-vscode-status-pos').textContent(), '行 1, 列 3')
  // 状态栏如实报告换行符与编码（保存时会原样写回）
  assert.equal(await page.evaluate(() => document.querySelector('.world-vscode-statusbar')?.textContent?.includes('LF')), true)

  await editor.fill('const value = 2\n')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__worldTesting.calls.some(call => call.method === 'world-vscode-source/open' && call.payload.path === '/workspace/src/main.js')), true)
  assert.equal(await page.evaluate(() => window.__worldTesting.calls.some(call => call.method === 'world-vscode-source/save' && call.payload.source === 'const value = 2\n')), true)

  // 焦点不在 VSCode 里时不能抢宿主的 Ctrl+S：外面按不保存，回到编辑器里才保存
  await editor.fill('const value = 3\n')
  const savesBefore = await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-source/save').length)
  await page.locator('.world-depth-toggle').click()
  await page.waitForFunction(() => document.body.dataset.worldDepth === 'off')
  await page.keyboard.press('Control+s')
  await page.waitForTimeout(150)
  assert.equal(await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-source/save').length), savesBefore)
  await page.locator('.world-depth-toggle').click()
  await page.waitForFunction(() => document.body.dataset.worldDepth === 'on')
  await page.locator('.world-vscode-textarea').click()
  await page.keyboard.press('Control+s')
  await page.waitForFunction(count => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-source/save').length > count, savesBefore)
  // 「已保存」只在状态栏亮一下（1.8s），不会一直挂着像还有没存的东西
  await page.waitForFunction(() => document.querySelector('.world-vscode-status-msg')?.textContent === '已保存')
  await page.waitForFunction(() => document.querySelector('.world-vscode-status-msg')?.textContent !== '已保存', null, { timeout: 5000 })

  assert.equal(await page.locator('.world-vscode-tab').count(), 1)
  // 编辑过的标签自动锁定，不再被下一个单击的文件顶掉
  assert.equal(await page.locator('.world-vscode-tab.is-pinned').count(), 1)
  assert.equal(await page.locator('.world-vscode-tab.preview').count(), 0)
  await page.getByRole('button', { name: 'README.md', exact: true }).click()
  assert.equal(await page.locator('.world-vscode-tab').count(), 2)
  assert.equal(await page.locator('.world-vscode-tab.is-pinned').count(), 1)
  assert.equal(await page.locator('.world-vscode-tab.preview').count(), 1)
  // 再点回同一个文件复用的是预览标签，不新增
  await page.getByRole('button', { name: 'README.md', exact: true }).click()
  assert.equal(await page.locator('.world-vscode-tab').count(), 2)
  await page.locator('.world-vscode-tab.is-pinned').click()
  // 切回固定标签要看到刚才编辑并保存的内容，而不是磁盘上的旧版本
  assert.equal(await page.locator('.world-vscode-textarea').inputValue(), 'const value = 3\n')
  if (process.env.WORLD_VSCODE_TABS_SHOT) await page.screenshot({ path: process.env.WORLD_VSCODE_TABS_SHOT })
  await page.locator('.world-vscode-tab.preview .world-vscode-tab-close').click()
  assert.equal(await page.locator('.world-vscode-tab').count(), 1)
  // 中键关闭标签（和浏览器、VSCode 一致）
  await page.getByRole('button', { name: 'README.md', exact: true }).click()
  assert.equal(await page.locator('.world-vscode-tab').count(), 2)
  await page.locator('.world-vscode-tab.preview').click({ button: 'middle' })
  assert.equal(await page.locator('.world-vscode-tab').count(), 1)

  await page.getByRole('button', { name: 'big.txt', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.world-vscode-statusbar')?.textContent.includes('50000 行'))
  const largeStats = await page.evaluate(() => ({
    gutterRows: document.querySelectorAll('.world-vscode-gutter-row').length,
    lineCount: document.querySelector('.world-vscode-textarea').value.split('\n').length,
  }))
  assert.equal(largeStats.lineCount, 50000)
  assert.ok(largeStats.gutterRows > 0 && largeStats.gutterRows < 100, `gutter rows: ${largeStats.gutterRows}`)
  await page.locator('.world-vscode-textarea').evaluate(element => {
    element.scrollTop = 200000
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await page.waitForFunction(() => {
    const first = document.querySelector('.world-vscode-gutter-row')
    return first && Number(first.textContent) > 1000
  })
  const scrolledFirst = await page.locator('.world-vscode-gutter-row').first().textContent()
  console.log(`Large file check: ${largeStats.lineCount} lines, ${largeStats.gutterRows} gutter rows, scrolled to line ${scrolledFirst}.`)

  // 源代码管理：分组、逐行/批量暂存、提交后清空
  await page.getByRole('button', { name: '源代码管理', exact: true }).click()
  assert.equal(await page.locator('.world-vscode-git-group').count(), 2)
  assert.equal(await page.locator('.world-vscode-git-file').count(), 3)
  assert.equal(await page.locator('.world-vscode-activity-badge').textContent(), '3')
  assert.equal(await page.locator('.world-vscode-git-primary').isDisabled(), true)
  assert.equal(await page.locator('.world-vscode-git-actions button').first().isEnabled(), true)
  await page.locator('.world-vscode-git-file').filter({ hasText: 'README.md' }).click()
  assert.ok(await page.locator('.world-vscode-tab-name').filter({ hasText: 'README.md' }).count() >= 1)
  const changesGroup = page.locator('.world-vscode-git-group-head').filter({ hasText: '更改' })
  await changesGroup.hover()
  await changesGroup.getByRole('button').click()
  assert.equal(await page.locator('.world-vscode-git-group').count(), 1)
  assert.equal(await page.locator('.world-vscode-git-file').count(), 3)
  await page.locator('.world-vscode-git-message').fill('feat: git 面板')
  assert.equal(await page.locator('.world-vscode-git-primary').isEnabled(), true)
  await page.locator('.world-vscode-git-primary').click()
  await page.waitForFunction(() => document.querySelector('.world-vscode-git-empty') !== null)
  assert.equal((await page.locator('.world-vscode-git-empty').textContent()).trim(), '工作区没有更改')
  assert.equal(await page.locator('.world-vscode-activity-badge').count(), 0)
  assert.match(await page.locator('.world-vscode-git-msg').textContent(), /feat: git 面板/u)
  assert.equal(await page.evaluate(() => window.__worldTesting.calls.some(call => call.method === 'world-vscode-git/stage')), true)
  assert.equal(await page.evaluate(() => window.__worldTesting.calls.some(call => call.method === 'world-vscode-git/commit' && call.payload.message === 'feat: git 面板')), true)

  // 搜索：输入即搜、结果按文件分组、点击命中定位到行
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  assert.equal(await page.locator('.world-vscode-sidebar-title').textContent(), '搜索')
  await page.locator('.world-vscode-search-input').fill('value')
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-search-file').length === 2)
  assert.equal(await page.locator('.world-vscode-search-hit').count(), 2)
  assert.match(await page.locator('.world-vscode-search-summary').textContent(), /2 个结果 · 2 个文件/u)
  assert.equal(await page.locator('.world-vscode-search-text mark').first().textContent(), 'value')
  assert.equal(await page.evaluate(() => window.__worldTesting.calls.some(call => call.method === 'world-vscode-search/find' && call.payload.query === 'value')), true)
  await page.locator('.world-vscode-search-flag').first().click()
  await page.waitForFunction(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-search/find').length >= 2)
  assert.equal(await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-search/find').at(-1).payload.caseSensitive), true)
  await page.locator('.world-vscode-search-hit').first().click()
  await page.waitForFunction(() => document.activeElement?.classList.contains('world-vscode-textarea'))
  const caret = await page.locator('.world-vscode-textarea').evaluate(element => ({ start: element.selectionStart, value: element.value }))
  assert.equal(caret.value.slice(caret.start, caret.start + 5), 'value')
  // 搜索结果是相对路径，文件树是绝对路径：同一个文件不能开成两个标签
  assert.equal(await page.locator('.world-vscode-tab').count(), 3)
  assert.equal(await page.locator('.world-vscode-tab.active .world-vscode-tab-name').textContent(), 'main.js')

  // Ctrl+Shift+F 直接切到搜索视图，并把焦点放进输入框
  await page.getByRole('button', { name: '资源管理器', exact: true }).click()
  await page.locator('.world-vscode-textarea').click()
  await page.keyboard.press('Control+Shift+F')
  await page.waitForFunction(() => document.activeElement?.classList.contains('world-vscode-search-input'))
  assert.equal(await page.locator('.world-vscode-sidebar-title').textContent(), '搜索')
  assert.equal(await page.locator('.world-vscode-search-hit').count(), 2)

  // 语法高亮覆盖层与文本逐行对齐，关键字有独立颜色
  assert.equal(await page.locator('.world-vscode-highlight').count(), 1)
  assert.equal(await page.locator('.world-vscode-highlight .world-vscode-tok-kw').first().textContent(), 'const')
  assert.equal(await page.locator('.world-vscode-textarea').evaluate(element => getComputedStyle(element).color), 'rgba(0, 0, 0, 0)')
  assert.deepEqual(await page.evaluate(() => {
    const line = document.querySelector('.world-vscode-hl-line')
    const gutter = document.querySelector('.world-vscode-gutter-row')
    return { line: line.getBoundingClientRect().height, gutter: gutter.getBoundingClientRect().height }
  }), { line: 20, gutter: 20 })

  // 侧栏：Ctrl+B 折叠、拖拽改宽、双击复位
  await page.locator('.world-vscode-textarea').click()
  await page.keyboard.press('Control+b')
  assert.equal(await page.locator('.world-vscode-sidebar').count(), 0)
  await page.keyboard.press('Control+b')
  await page.locator('.world-vscode-sidebar').waitFor()
  const sidebarBefore = await page.locator('.world-vscode-sidebar').evaluate(element => element.getBoundingClientRect().width)
  const handle = await page.locator('.world-vscode-sidebar-resize').boundingBox()
  await page.mouse.move(handle.x + 3, handle.y + 120)
  await page.mouse.down()
  await page.mouse.move(handle.x + 63, handle.y + 120, { steps: 6 })
  await page.mouse.up()
  const sidebarAfter = await page.locator('.world-vscode-sidebar').evaluate(element => element.getBoundingClientRect().width)
  assert.ok(sidebarAfter > sidebarBefore + 40, `sidebar ${sidebarBefore} → ${sidebarAfter}`)
  await page.locator('.world-vscode-sidebar-resize').dblclick()
  assert.equal(await page.locator('.world-vscode-sidebar').evaluate(element => element.clientWidth), 220)

  await page.getByRole('button', { name: '资源管理器', exact: true }).click()
  assert.equal(await page.locator('.world-vscode-explorer-list').count(), 1)

  // 打开文件夹：对话框只列子文件夹，选定后资源管理器、搜索和 Git 都换根
  await page.locator('.world-vscode-title-btn').click()
  const picker = page.locator('.world-vscode-picker')
  await picker.waitFor()
  assert.equal(await picker.locator('.world-vscode-picker-row').count(), 1)
  assert.equal(await picker.locator('.world-vscode-picker-row').first().textContent(), 'src')
  // 路径框可以直接输入 / 粘贴路径跳转
  await picker.locator('.world-vscode-picker-input').fill('/workspace/src')
  await picker.locator('.world-vscode-picker-input').press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-picker-row').length === 0)
  await picker.locator('.world-vscode-picker-input').fill('/workspace')
  await picker.locator('.world-vscode-picker-input').press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-picker-row').length === 1)
  assert.equal(await picker.locator('.world-vscode-picker-input').inputValue(), '/workspace')
  await picker.locator('.world-vscode-picker-row').first().click()
  await page.waitForFunction(() => document.querySelector('.world-vscode-picker-input')?.value === '/workspace/src')
  // src 里没有子文件夹
  assert.equal(await picker.locator('.world-vscode-picker-row').count(), 0)
  await picker.getByRole('button', { name: '打开', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.world-vscode-status-root')?.textContent.includes('src'))
  // 换根会关掉旧标签，树换成 src 的内容
  assert.equal(await page.locator('.world-vscode-tab').count(), 0)
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-file').length === 2)
  assert.equal(await page.getByRole('button', { name: 'main.js', exact: true }).count(), 1)
  assert.equal(await page.getByRole('button', { name: 'README.md', exact: true }).count(), 0)
  assert.equal(await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-source/list').at(-1).payload.path), '/workspace/src')
  assert.equal(await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-git/status').at(-1).payload.root), '/workspace/src')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.locator('.world-vscode-search-input').fill('value')
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-search-file').length === 2)
  assert.equal(await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-vscode-search/find').at(-1).payload.root), '/workspace/src')

  // 多开：桌面图标再开一个独立窗口，标签互不影响，任务栏各占一项
  await page.getByRole('button', { name: '开始' }).click()
  await page.locator('.world-app-card[data-world-app-card="vscode"] .world-app-open').click()
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window').length === 2)
  const windows = page.locator('.world-vscode-window')
  assert.equal(await page.locator('[data-world-taskbar^="vscode:"]').count(), 2)
  assert.equal(await windows.nth(1).locator('.world-vscode-tab').count(), 0)
  await windows.nth(1).getByRole('button', { name: 'README.md', exact: true }).click()
  await windows.nth(1).locator('.world-vscode-tab').waitFor()
  assert.equal(await windows.nth(1).locator('.world-vscode-tab').count(), 1)
  assert.equal(await windows.nth(0).locator('.world-vscode-tab').count(), 0)
  // 每个窗口各带一份侧栏视图：新窗口是资源管理器，旧窗口停在搜索
  assert.equal(await windows.nth(0).locator('.world-vscode-sidebar-title').textContent(), '搜索')
  assert.equal(await windows.nth(1).locator('.world-vscode-sidebar-title').textContent(), '资源管理器')
  // 点哪个窗口哪个就压到最上面
  // 后面的窗口只在左侧错开 60px 露面：点露出来的那条（标题栏左侧）才会激活它
  await windows.nth(0).click({ force: true, position: { x: 24, y: 10 } })
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelectorAll('.world-vscode-window')[0]).zIndex) === 5)
  assert.equal(await windows.nth(1).evaluate(element => getComputedStyle(element).zIndex), '4')
  assert.equal((await page.locator('[data-world-taskbar^="vscode:"]').evaluateAll(nodes => nodes.map(node => node.textContent))).join('|'), 'src|workspace')
  // 快捷键只归一个窗口：两个窗口都挂着 window 监听，Ctrl+B 不能把两个侧栏一起收掉
  await page.keyboard.press('Control+b')
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window')[0].querySelector('.world-vscode-sidebar') === null)
  assert.equal(await windows.nth(1).locator('.world-vscode-sidebar').count(), 1)
  await page.keyboard.press('Control+b')
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window')[0].querySelector('.world-vscode-sidebar') !== null)
  await windows.nth(1).getByRole('button', { name: '关闭 Visual Studio Code' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window').length === 1)

  // 对话框是模态的：焦点落在列表行上也能 Esc 关掉，点卡片外面也能关，点里面不关
  await page.locator('.world-vscode-title-btn').click()
  await page.locator('.world-vscode-picker').waitFor()
  // 当前根是 /workspace/src（没有子文件夹），先回上一级拿到可聚焦的行
  await page.locator('.world-vscode-picker-up').click()
  await page.locator('.world-vscode-picker-row').first().waitFor()
  await page.locator('.world-vscode-picker-row').first().focus()
  await page.keyboard.press('Escape')
  await page.locator('.world-vscode-picker').waitFor({ state: 'detached' })
  await page.locator('.world-vscode-title-btn').click()
  await page.locator('.world-vscode-picker').waitFor()
  // Tab 在卡片里循环：从最后一个键（打开）按 Tab 回到第一个可聚焦元素（关闭 ×）
  await picker.getByRole('button', { name: '打开', exact: true }).focus()
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '关闭打开文件夹')
  await page.locator('.world-vscode-picker-card').click({ position: { x: 20, y: 200 } })
  assert.equal(await page.locator('.world-vscode-picker').count(), 1)
  await page.locator('.world-vscode-picker').click({ position: { x: 4, y: 4 } })
  await page.locator('.world-vscode-picker').waitFor({ state: 'detached' })

  // 同一个文件夹只有一个实例：「在新窗口打开」只会把已开的窗口拿到前台
  await page.locator('.world-vscode-title-btn').click()
  await page.locator('.world-vscode-picker').getByRole('button', { name: '在新窗口打开' }).click()
  await page.waitForTimeout(250)
  assert.equal(await page.locator('.world-vscode-window').count(), 1)
  assert.equal(await page.locator('.world-vscode-picker').count(), 0)
  // 换一个文件夹才真的再开一个窗口：标签只显示文件夹名，不重复
  await page.locator('.world-vscode-title-btn').click()
  await page.locator('.world-vscode-picker-up').click()
  await page.locator('.world-vscode-picker').getByRole('button', { name: '在新窗口打开' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window').length === 2)
  assert.equal(
    (await page.locator('[data-world-taskbar^="vscode:"] .world-taskbar-app-name').evaluateAll(nodes => nodes.map(node => node.textContent))).join('|'),
    'src|workspace',
  )
  // 桌面图标再开「同一个文件夹」同样只聚焦，不再叠一个窗口
  await page.getByRole('button', { name: '开始' }).click()
  await page.locator('.world-app-card[data-world-app-card="vscode"] .world-app-open').click()
  await page.waitForTimeout(250)
  assert.equal(await page.locator('.world-vscode-window').count(), 2)
  assert.equal(await page.locator('.world-vscode-window').last().evaluate(node => node.classList.contains('is-active')), true)
  while (await page.locator('.world-vscode-window').count() > 1) {
    await page.locator('.world-vscode-window').last().getByRole('button', { name: '关闭 Visual Studio Code' }).click()
    await page.waitForTimeout(120)
  }

  // 窗口键：最大化铺满桌面（顶栏到任务栏之间），双击标题栏还原，最小化后交给任务栏
  const solo = page.locator('.world-vscode-window').first()
  await solo.getByRole('button', { name: '最大化 Visual Studio Code' }).click()
  await page.waitForFunction(() => document.querySelector('.world-vscode-window')?.classList.contains('is-max'))
  const box = await solo.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return {
      left: Math.round(rect.left), width: Math.round(rect.width), bottom: Math.round(rect.bottom),
      vw: window.innerWidth, vh: window.innerHeight,
    }
  })
  assert.equal(box.left, 0)
  assert.equal(box.width, box.vw)
  // 任务栏 48px：最大化时不能盖住任务栏，也不能压到桌面顶栏
  assert.equal(box.bottom, box.vh - 48)
  // 最大化时八个缩放手柄全部撤掉，否则边缘拖动会改一个看不见的 rect
  assert.equal(await solo.locator('.world-vscode-resize').count(), 0)
  assert.equal(await solo.getByRole('button', { name: '还原 Visual Studio Code' }).count(), 1)
  // 双击标题栏（不是按钮）还原，宽度回到 80vw
  await solo.locator('.world-vscode-titlebar').dblclick({ position: { x: 120, y: 12 } })
  await page.waitForFunction(() => !document.querySelector('.world-vscode-window').classList.contains('is-max'))
  assert.equal(await solo.evaluate(element => Math.round(element.getBoundingClientRect().width) < window.innerWidth), true)
  assert.equal(await solo.locator('.world-vscode-resize').count(), 8)

  // 最大化状态下最小化，任务栏还原后仍是最大化（lastOpen）
  await solo.getByRole('button', { name: '最大化 Visual Studio Code' }).click()
  await page.waitForFunction(() => document.querySelector('.world-vscode-window')?.classList.contains('is-max'))
  await solo.getByRole('button', { name: '最小化 Visual Studio Code' }).click()
  await page.waitForFunction(() => document.querySelector('.world-vscode-window').classList.contains('is-min'))
  // 淡出动画有 140ms，visibility 要等动画结束才隐藏
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.world-vscode-window')).visibility === 'hidden')
  // 看不见的窗口不再吃快捷键：Ctrl+Shift+O 不该在它里面弹出对话框
  await page.keyboard.press('Control+Shift+O')
  await page.waitForTimeout(200)
  assert.equal(await page.locator('.world-vscode-picker').count(), 0)
  assert.equal(await page.locator('[data-world-taskbar^="vscode:"]').first().evaluate(element => element.classList.contains('is-min')), true)
  await page.locator('[data-world-taskbar^="vscode:"]').first().click()
  await page.waitForFunction(() => !document.querySelector('.world-vscode-window').classList.contains('is-min'))
  assert.equal(await solo.evaluate(element => element.classList.contains('is-max')), true)
  // 还原后键盘要回到窗口里，否则还得再点一下才能按 Ctrl+S
  assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('.world-vscode-window'))), true)
  // 还原成普通窗口，后面的关闭流程不受影响
  await solo.getByRole('button', { name: '还原 Visual Studio Code' }).click()
  await page.waitForFunction(() => !document.querySelector('.world-vscode-window').classList.contains('is-max'))

  // 关掉前台窗口时把前台交给还开着的那一个，而不是一律退回桌面
  await page.getByRole('button', { name: '开始' }).click()
  await page.locator('.world-app-card[data-world-app-card="vscode"] .world-app-open').click()
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window').length === 2)
  assert.equal(await page.locator('.world-vscode-window').evaluateAll(nodes => nodes.filter(node => node.classList.contains('is-active')).length), 1)
  assert.equal(await page.locator('.world-vscode-window').last().evaluate(node => node.classList.contains('is-active')), true)
  await page.locator('.world-vscode-window').last().getByRole('button', { name: '关闭 Visual Studio Code' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window').length === 1)
  assert.equal(await page.evaluate(() => String(document.body.dataset.worldActiveWindow).startsWith('vscode:')), true)
  assert.equal(await page.locator('.world-vscode-window').evaluate(node => node.classList.contains('is-active')), true)

  await page.getByRole('button', { name: '关闭 Visual Studio Code' }).click()
  await page.locator('.world-vscode-window').waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '开始' }).click()
  await page.locator('.world-app-card[data-world-app-card="vscode"] .world-app-open').click()
  const reopened = page.locator('.world-vscode-window')
  await reopened.waitFor()
  await page.getByRole('button', { name: '关闭 Visual Studio Code' }).click()
  await reopened.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '开始' }).click()
  await page.locator('.world-app-card[data-world-app-card="vscode"] .world-app-uninstall').click()
  assert.equal(await page.locator('.world-desktop-icon').count(), 4)
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.world-start').evaluate(element => element.classList.contains('open')), false)

  await page.getByRole('button', { name: '开始' }).click()
  assert.equal(await page.locator('.world-plugin-card').count(), 2)
  assert.equal(await page.locator('[data-world-plugin-card="pbide"]').count(), 0)
  await page.locator('[data-world-plugin-card="workflow-studio"]').click()
  const firstWindow = page.locator('[data-world-plugin="workflow-studio"]')
  await firstWindow.waitFor()
  assert.equal(await page.locator('[data-world-plugin-page="workflow-studio"]').count(), 1)
  assert.equal(await page.locator('[data-world-taskbar="plugin:workflow-studio"]').count(), 1)
  assert.equal(await page.locator('body').getAttribute('data-world-active-window'), 'plugin:workflow-studio')

  await page.getByRole('button', { name: '开始' }).click()
  await page.locator('[data-world-plugin-card="assessment"]').click()
  const secondWindow = page.locator('[data-world-plugin="assessment"]')
  await secondWindow.waitFor()
  assert.equal(await page.locator('.world-plugin-window').count(), 2)
  assert.equal(await page.locator('body').getAttribute('data-world-window'), 'normal')
  assert.equal(await firstWindow.isVisible(), true)
  assert.equal(await secondWindow.isVisible(), true)

  await page.locator('[data-world-taskbar="plugin:workflow-studio"]').click()
  assert.equal(await page.locator('body').getAttribute('data-world-active-window'), 'plugin:workflow-studio')
  assert.equal(await firstWindow.evaluate(element => getComputedStyle(element).zIndex), '6')
  assert.equal(await secondWindow.evaluate(element => getComputedStyle(element).zIndex), '2')
  if (process.env.WORLD_SHOT) {
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.world-start')).opacity === '0')
    await page.screenshot({ path: process.env.WORLD_SHOT })
  }

  await firstWindow.getByRole('button', { name: '最小化' }).click()
  assert.equal(await firstWindow.evaluate(element => element.classList.contains('is-min')), true)
  await page.locator('[data-world-taskbar="plugin:workflow-studio"]').click()
  assert.equal(await firstWindow.evaluate(element => element.classList.contains('is-min')), false)
  assert.equal(await page.locator('body').getAttribute('data-world-active-window'), 'plugin:workflow-studio')
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-world-plugin="workflow-studio"]')).transform === 'none')

  await page.evaluate(() => {
    const modal = document.createElement('div')
    modal.dataset.testid = 'plugin-modal'
    modal.innerHTML = '<div role="dialog" aria-label="plugin dialog"></div>'
    document.body.append(modal)
  })
  await page.waitForFunction(() => document.querySelector('[data-testid="plugin-modal"]')?.dataset.worldDialog === 'workflow-studio')
  const pluginModal = await page.locator('[data-testid="plugin-modal"]').evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
  })
  const pluginWindowRect = await firstWindow.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
  })
  assert.deepEqual(pluginModal, pluginWindowRect)
  await page.locator('[data-testid="plugin-modal"]').evaluate(element => element.remove())

  await secondWindow.getByRole('button', { name: '关闭' }).click()
  assert.equal(await page.locator('.world-plugin-window').count(), 1)
  assert.equal(await firstWindow.count(), 1)
  await firstWindow.getByRole('button', { name: '关闭' }).click()
  assert.equal(await page.locator('.world-plugin-window').count(), 0)

  // 内置局域网聊天：应用目录安装 → 桌面图标 → 窗口/任务栏 → 最小化/最大化 → 关闭 → 卸载
  const openStart = async () => {
    if (!(await page.locator('.world-start').evaluate(element => element.classList.contains('open')))) {
      await page.getByRole('button', { name: '开始' }).click()
    }
  }
  await openStart()
  const chatCard = page.locator('.world-app-card[data-world-app-card="lanchat"]')
  await chatCard.locator('.world-app-install').click()
  assert.equal(await page.locator('.world-desktop-icon').count(), 5)
  await chatCard.locator('.world-app-open').click()
  const chatWindow = page.locator('.world-lanchat-window')
  await chatWindow.waitFor()
  assert.equal(await page.locator('[data-world-taskbar="lanchat"]').count(), 1)
  assert.equal(await page.locator('body').getAttribute('data-world-active-window'), 'lanchat')
  assert.equal(await page.locator('.world-lanchat-frame').count(), 1)
  assert.equal(await chatWindow.evaluate(element => getComputedStyle(element).zIndex), '5')
  await chatWindow.locator('[aria-label="最小化"]').click()
  assert.equal(await chatWindow.evaluate(element => element.style.display), 'none')
  await page.locator('[data-world-taskbar="lanchat"]').click()
  assert.equal(await chatWindow.evaluate(element => element.style.display), '')
  await checkWindowRestore(page, chatWindow, 'lanchat', async () => {
    await openStart()
    await chatCard.locator('.world-app-open').click()
  })
  await chatWindow.locator('[aria-label="关闭"]').click()
  assert.equal(await page.locator('.world-lanchat-window').count(), 0)
  await openStart()
  await chatCard.locator('.world-app-uninstall').click()
  assert.equal(await page.locator('.world-desktop-icon').count(), 4)
  await page.keyboard.press('Escape')

  // 主应用右键：只有「打开」，明确标记不可卸载
  const contextClick = locator => locator.evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2, clientX: 80, clientY: 90,
  })))
  await contextClick(page.getByRole('button', { name: 'DeepSeek Harness', exact: true }))
  assert.equal(await page.locator('.world-context-menu [data-role="open"]').count(), 1)
  assert.equal(await page.locator('.world-context-menu [data-role="uninstall"]').count(), 0)
  assert.match(await page.locator('.world-context-menu [data-role="protected"]').textContent(), /不可卸载/)
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.world-context-menu').count(), 0)

  // 拖放安装 .worldapp：数据层校验 → 桌面图标 / 开始菜单卡片 / 窗口 / 任务栏 → 右键卸载
  const dropPackage = async (name, content) => page.evaluate(({ name, content }) => {
    const dt = new DataTransfer()
    dt.items.add(new File([content], name, { type: 'application/json' }))
    const target = document.querySelector('[data-world-portal="dsh-world"]')
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
    }
  }, { name, content })

  const goodPackage = JSON.stringify({
    format: 'dsh-world-app/1', id: 'demo-test', name: '演示应用', description: '拖放安装自检',
    icon: '🧩', color: '#22aa88', url: 'http://127.0.0.1:53317/prototype.html', size: { w: 70, h: 70 },
  })
  await dropPackage('demo-test.worldapp', goodPackage)
  await page.waitForFunction(() => document.querySelectorAll('.world-desktop-icon').length === 5)
  assert.equal(await page.locator('.world-app-card[data-world-app-card="demo-test"]').count(), 1)
  assert.match(await page.locator('.world-toast').textContent(), /已安装/)
  const externalIcon = page.locator('[data-world-external-icon="demo-test"]')
  await contextClick(externalIcon)
  assert.equal(await page.locator('.world-context-menu [data-role="uninstall"]').count(), 1)
  await page.locator('.world-context-menu [data-role="open"]').click()
  const externalWindow = page.locator('.world-external-window')
  await externalWindow.waitFor()
  assert.equal(await page.locator('.world-external-frame').getAttribute('src'), 'http://127.0.0.1:53317/prototype.html')
  assert.equal(await page.locator('body').getAttribute('data-world-active-window'), 'ext:demo-test')
  assert.equal(await page.locator('[data-world-taskbar="ext:demo-test"]').count(), 1)
  await checkWindowRestore(page, externalWindow, 'ext:demo-test', async () => {
    await openStart()
    await page.locator('.world-app-card[data-world-app-card="demo-test"] .world-app-open').click()
  })
  await externalWindow.locator('[aria-label="关闭"]').click()
  assert.equal(await page.locator('.world-external-window').count(), 0)
  await contextClick(externalIcon)
  await page.locator('.world-context-menu [data-role="uninstall"]').click()
  assert.equal(await page.locator('.world-desktop-icon').count(), 4)
  assert.equal(await page.locator('.world-app-card[data-world-app-card="demo-test"]').count(), 0)

  // 非法包：javascript: 地址必须被拒绝，且不写入任何应用
  await dropPackage('bad.worldapp', JSON.stringify({
    format: 'dsh-world-app/1', id: 'bad-app', name: '坏包', url: 'javascript:alert(1)',
  }))
  await page.waitForFunction(() => document.querySelector('.world-toast')?.textContent?.includes('http'))
  assert.equal(await page.locator('.world-desktop-icon').count(), 4)

  // 3D 景深开关：关掉后地面消失、图标不再透视，再打开恢复
  await page.locator('.world-depth-toggle').click()
  await page.waitForFunction(() => document.body.dataset.worldDepth === 'off')
  assert.equal(await page.locator('.world-floor-wrap').evaluate(element => getComputedStyle(element).display), 'none')
  assert.equal(await page.locator('.world-desktop-icon').first().evaluate(element => getComputedStyle(element).perspective), 'none')
  assert.equal(await page.locator('.world-depth-toggle').getAttribute('data-world-depth-toggle'), 'off')
  // 关掉 3D：图标回到左侧常规网格（绝对定位，位置仍按列排）
  assert.equal(await page.locator('.world-desktop-icon').first().evaluate(element => getComputedStyle(element).position), 'absolute')
  assert.equal(Math.round((await page.locator('.world-desktop-icon').first().boundingBox()).y), 50)
  await page.locator('.world-depth-toggle').click()
  await page.waitForFunction(() => document.body.dataset.worldDepth === 'on')
  assert.notEqual(await page.locator('.world-floor-wrap').evaluate(element => getComputedStyle(element).display), 'none')
  // 打开 3D：图标站到地面上——脚底落在地平线以下、地面前沿附近
  const iconOnFloor = await page.locator('.world-desktop-icon').first().evaluate(element => {
    const box = element.getBoundingClientRect()
    return { top: box.top, bottom: box.bottom, left: box.left }
  })
  assert.ok(iconOnFloor.bottom > 640 && iconOnFloor.bottom <= 800 - 48, '图标应站在地面前沿附近，实测脚底 ' + Math.round(iconOnFloor.bottom))
  assert.ok(iconOnFloor.left < 120, '第一列图标应贴着左边')

  // 图标必须留在平面上：不透视、不挤出厚度、不做 3D 位移
  const iconFlat = await page.locator('.world-desktop-icon').first().evaluate(element => {
    const glyph = element.querySelector('.world-glyph')
    const edge = getComputedStyle(glyph, '::before')
    const style = getComputedStyle(glyph)
    return {
      perspective: getComputedStyle(element).perspective,
      edgeContent: edge.content,
      transform: style.transform,
      shadow: style.boxShadow,
    }
  })
  assert.equal(iconFlat.perspective, 'none')
  assert.equal(iconFlat.edgeContent, 'none')
  assert.equal(iconFlat.transform, 'none')
  assert.equal(iconFlat.shadow, 'none')

  // 地面上的卡通小机器人：走向「鼠标与地面的交点」，指针换位置就重新走过去
  assert.equal(await page.locator('.world-walker').count(), 1)
  assert.equal(await page.locator('.world-walker').evaluate(element => getComputedStyle(element).animationName), 'none')

  const walkerFeet = () => page.locator('.world-walker').evaluate(element => {
    const box = element.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height, width: box.width }
  })
  const walkerWalking = () => page.locator('.world-walker').getAttribute('data-walking')
  const waitWalking = (value, timeout) => page.waitForFunction(
    expected => document.querySelector('.world-walker')?.dataset.walking === expected, value, { timeout },
  )

  await page.mouse.move(280, 700)
  await waitWalking('on', 3000)
  // 走的瞬间播放步态动画
  assert.equal(await page.locator('.wn-leg-a').evaluate(element => getComputedStyle(element).animationName), 'world-walk-leg-a')
  assert.equal(await page.locator('.wn-foot-a').evaluate(element => getComputedStyle(element).animationName), 'world-walk-foot-a')
  await waitWalking('off', 9000)
  const walkerNear = await walkerFeet()
  assert.ok(Math.abs(walkerNear.x - 280) < 6, '脚底应落在指针与地面的交点（横）实测 ' + walkerNear.x.toFixed(1))
  assert.ok(Math.abs(walkerNear.y - 700) < 6, '脚底应落在指针与地面的交点（纵）实测 ' + walkerNear.y.toFixed(1))

  // 指针往右上移动：既要横着走，也要沿地面往远处走（更小）
  await page.mouse.move(1000, 430)
  await waitWalking('on', 3000)
  await waitWalking('off', 12000)
  const walkerFar = await walkerFeet()
  assert.ok(walkerFar.x > walkerNear.x + 600, '机器人应跟随指针横向移动，实测 ' + Math.round(walkerNear.x) + ' → ' + Math.round(walkerFar.x))
  assert.ok(walkerFar.y < walkerNear.y - 200, '指针上移时机器人应沿地面后退，实测 ' + Math.round(walkerNear.y) + ' → ' + Math.round(walkerFar.y))
  assert.ok(walkerFar.width < walkerNear.width * .75, '远处更小，实测 ' + walkerNear.width.toFixed(1) + ' → ' + walkerFar.width.toFixed(1))
  assert.ok(Math.abs(walkerFar.y - 430) < 6, '走到远处后脚底仍应在指针处，实测 ' + walkerFar.y.toFixed(1))
  assert.ok(walkerNear.y + 2 < 800 - 48, '机器人应站在任务栏上方的地面上')

  // 到点就停住，不会自己往回飘（以前缓动尾巴会一直微动 -> 看起来在闪）
  await page.waitForTimeout(400)
  const still = await walkerFeet()
  await page.waitForTimeout(500)
  const stillAfter = await walkerFeet()
  assert.ok(Math.abs(stillAfter.x - still.x) < 1 && Math.abs(stillAfter.y - still.y) < 1,
    '停住后不该再动，实测 ' + still.x.toFixed(1) + ',' + still.y.toFixed(1) + ' → ' + stillAfter.x.toFixed(1) + ',' + stillAfter.y.toFixed(1))

  // 关掉 3D：机器人随地面一起消失
  await page.locator('.world-depth-toggle').click()
  await page.waitForFunction(() => document.body.dataset.worldDepth === 'off')
  assert.equal(await page.locator('.world-walker').isVisible(), false)
  await page.locator('.world-depth-toggle').click()
  await page.waitForFunction(() => document.body.dataset.worldDepth === 'on')

  await checkOwnershipOrdering(browser, bundle.outputFiles[0].text)
  await checkAssistantActivity(browser, bundle.outputFiles[0].text)
  const walkerPoses = await checkWalkerPoses(browser, bundle.outputFiles[0].text, process.env.WORLD_POSE_SHOTS_DIR)
  console.log('Walker poses passed: ' + JSON.stringify(walkerPoses))
  await checkAssistantConversation(browser, bundle.outputFiles[0].text)
  await checkJournal(browser, bundle.outputFiles[0].text, root)
  await checkTasks(browser, bundle.outputFiles[0].text, root)
  await checkWalkerMotion(browser, bundle.outputFiles[0].text)
  await checkIconDrag(browser, bundle.outputFiles[0].text)
  await checkStartSearch(browser, bundle.outputFiles[0].text)
  await checkDesktopItems(browser, bundle.outputFiles[0].text)
  await checkDesktopScreenshot(browser, bundle.outputFiles[0].text)
  await checkWorkbenchSetup(browser, bundle.outputFiles[0].text)
  await checkPersonalization(browser, bundle.outputFiles[0].text)
  await checkDesktopTools(page, desktopBridge, brain)
  await checkDesktopControl(page, desktopBridge, root, brain)
  await page.evaluate(() => window.__worldTesting.dispose())
  assert.equal(await page.locator('#root').evaluate(rootElement => rootElement.inert), false)
  assert.equal(await page.locator('#host-ui').evaluate(element => element.inert), false)
  assert.equal(await page.locator('style[data-plugin="dsh-world"]').count(), 0)
  console.log('Browser interactions passed: desktop, root box, drag, maximize, minimize/restore, close, start menu, plugin windows, taskbar restore, dialog ownership, built-in LAN chat app, .worldapp drop install, context-menu uninstall, main-app protection, 3D depth toggle, flat icons, cursor-following mascot, cleanup.')
  await checkBrowserWindow(browser, root, bundle.outputFiles[0].text)
  await checkTerminal(browser, bundle.outputFiles[0].text)
  await checkTerminalSsh(browser, bundle.outputFiles[0].text)
  await checkPluginRoots(browser, bundle.outputFiles[0].text)
  await checkLanChatInput(browser, root)
} finally {
  desktopBridge.dispose()
  await browser.close()
  assert.equal(dirname(brainDirectory), tmpdir())
  assert.ok(basename(brainDirectory).startsWith('world-brain-'))
  await rm(brainDirectory, { recursive: true, force: true })
}
