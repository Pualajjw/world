import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
let build
try { ({ build } = await import('esbuild')) } catch {
  ({ build } = await import(pathToFileURL(join(root, '../pbpkg/node_modules/esbuild/lib/main.js'))))
}
const require = (await import('node:module')).createRequire(join(root, '../workflow-studio/package.json'))
const { chromium } = require('playwright-core')
const browserPath = process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
if (!existsSync(browserPath)) { console.log('no browser'); process.exit(0) }

const bundle = await build({
  absWorkingDir: root,
  entryPoints: ['tests/browser-entry.js'],
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false,
  nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' }, legalComments: 'none',
})
const html = '<!doctype html><html data-windows-titlebar style="--dsh-windows-titlebar-height:40px"><head><style>#root{position:relative;width:100vw;height:100vh}.app-frame{position:relative;width:100%;height:100%;padding-top:var(--dsh-windows-titlebar-height);box-sizing:border-box}#host-ui{position:absolute;inset:var(--dsh-windows-titlebar-height) 0 0;background:#262626}[data-shell-overlay]{position:absolute;inset:0;z-index:20;pointer-events:none}[data-shell-overlay]>*{pointer-events:auto}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>'
const shots = join(root, 'prototype/shots')

const browser = await chromium.launch({ executablePath: browserPath, headless: true })
try {
  const open = async (scale, viewport) => {
    const page = await browser.newPage({ viewport, deviceScaleFactor: scale })
    await page.setContent(html)
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')
    await page.getByRole('button', { name: '开始' }).click()
    await page.locator('.world-app-card[data-world-app-card="vscode"] .world-app-install').click()
    await page.locator('.world-app-card[data-world-app-card="vscode"] .world-app-open').click()
    await page.locator('.world-vscode-window').waitFor()
    await page.waitForTimeout(400)
    return page
  }

  const page = await open(1, { width: 1440, height: 900 })
  await page.screenshot({ path: join(shots, 'vscode-welcome.png') })

  await page.locator('.world-vscode-file').filter({ hasText: 'src' }).click()
  await page.getByRole('button', { name: 'main.js', exact: true }).click()
  await page.locator('.world-vscode-textarea').waitFor()
  await page.waitForTimeout(300)
  await page.locator('.world-vscode-textarea').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.screenshot({ path: join(shots, 'vscode-highlight.png') })

  // 加载态：大文件要 900ms，趁这段截一张
  await page.getByRole('button', { name: 'big.txt', exact: true }).click()
  await page.locator('.world-vscode-loading').waitFor()
  await page.screenshot({ path: join(shots, 'vscode-loading.png') })
  await page.waitForFunction(() => document.querySelector('.world-vscode-statusbar')?.textContent?.includes('50000 行'), null, { timeout: 15000 })
  await page.locator('.world-vscode-tab.active .world-vscode-tab-close').click()

  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.locator('.world-vscode-search-input').fill('value')
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-search-file').length === 2)
  await page.screenshot({ path: join(shots, 'vscode-search.png') })

  await page.locator('.world-vscode-search-input').fill('没有这样的词')
  await page.waitForFunction(() => document.querySelector('.world-vscode-search-empty') !== null)
  await page.screenshot({ path: join(shots, 'vscode-search-empty.png') })

  await page.getByRole('button', { name: '源代码管理', exact: true }).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(shots, 'vscode-git.png') })

  // 窄窗：状态栏与侧栏在 1000px 下不能挤成一团
  await page.getByRole('button', { name: '资源管理器', exact: true }).click()
  await page.setViewportSize({ width: 1000, height: 760 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(shots, 'vscode-narrow.png') })

  // 收起侧栏 / 拖宽侧栏
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(300)
  await page.keyboard.press('Control+b')
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(shots, 'vscode-collapsed.png') })
  await page.keyboard.press('Control+b')
  await page.waitForTimeout(250)
  const grip = await page.locator('.world-vscode-sidebar-resize').boundingBox()
  await page.mouse.move(grip.x + 3, grip.y + 200)
  await page.mouse.down()
  await page.mouse.move(grip.x + 143, grip.y + 200, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(shots, 'vscode-wide.png') })
  await page.locator('.world-vscode-sidebar-resize').dblclick()
  await page.waitForTimeout(200)

  // 打开文件夹：对话框 → 进入子目录 → 以它为新根
  await page.locator('.world-vscode-title-btn').click()
  await page.locator('.world-vscode-picker').waitFor()
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(shots, 'vscode-picker.png') })
  await page.locator('.world-vscode-picker-row').first().click()
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(shots, 'vscode-picker-inner.png') })
  await page.locator('.world-vscode-picker').getByRole('button', { name: '打开', exact: true }).click()
  await page.waitForTimeout(450)
  await page.screenshot({ path: join(shots, 'vscode-folder.png') })

  // 多开：不同文件夹各占一个窗口；同一个文件夹只会把已开的窗口拿到前台
  await page.getByRole('button', { name: '开始' }).click()
  await page.locator('.world-app-card[data-world-app-card="vscode"] .world-app-open').click()
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window').length === 2)
  await page.waitForTimeout(450)
  await page.screenshot({ path: join(shots, 'vscode-multi.png') })
  // 再开一次相同文件夹：窗口数不变，只是聚焦
  await page.getByRole('button', { name: '开始' }).click()
  await page.locator('.world-app-card[data-world-app-card="vscode"] .world-app-open').click()
  await page.waitForTimeout(350)
  if (await page.locator('.world-vscode-window').count() !== 2) throw new Error('同一个文件夹不该再开窗口')
  await page.close()

  // 最大化 / 最小化：最大化铺满桌面（顶栏到任务栏之间），最小化后任务栏留一格
  const maxed = await open(1, { width: 1440, height: 900 })
  await maxed.locator('.world-vscode-file').filter({ hasText: 'src' }).click()
  await maxed.getByRole('button', { name: 'main.js', exact: true }).click()
  await maxed.locator('.world-vscode-textarea').waitFor()
  await maxed.getByRole('button', { name: '最大化 Visual Studio Code' }).click()
  await maxed.waitForTimeout(350)
  await maxed.screenshot({ path: join(shots, 'vscode-max.png') })
  await maxed.getByRole('button', { name: '最小化 Visual Studio Code' }).click()
  await maxed.waitForTimeout(350)
  await maxed.screenshot({ path: join(shots, 'vscode-minimized.png') })
  await maxed.close()

  // 2x 细节图：行号对齐、着色、状态栏、活动栏、搜索面板
  const zoom = await open(2, { width: 1200, height: 760 })
  await zoom.setViewportSize({ width: 1440, height: 900 })
  await zoom.locator('.world-vscode-file').filter({ hasText: 'src' }).click()
  await zoom.getByRole('button', { name: 'main.js', exact: true }).click()
  await zoom.locator('.world-vscode-textarea').waitFor()
  await zoom.waitForTimeout(300)
  const box = await zoom.locator('.world-vscode-editor-content').boundingBox()
  await zoom.screenshot({ path: join(shots, 'vscode-highlight-zoom.png'), clip: { x: box.x, y: box.y, width: Math.min(560, box.width), height: Math.min(260, box.height) } })
  const bar = await zoom.locator('.world-vscode-statusbar').boundingBox()
  await zoom.screenshot({ path: join(shots, 'vscode-statusbar.png'), clip: { x: bar.x + bar.width - 520, y: bar.y, width: 520, height: bar.height } })
  const activity = await zoom.locator('.world-vscode-activity').boundingBox()
  await zoom.screenshot({ path: join(shots, 'vscode-activity.png'), clip: { x: activity.x, y: activity.y, width: activity.width, height: 220 } })
  await zoom.getByRole('button', { name: '搜索', exact: true }).click()
  await zoom.locator('.world-vscode-search-input').fill('value')
  await zoom.waitForFunction(() => document.querySelectorAll('.world-vscode-search-file').length === 2)
  await zoom.waitForTimeout(200)
  const side = await zoom.locator('.world-vscode-sidebar').boundingBox()
  await zoom.screenshot({ path: join(shots, 'vscode-search-zoom.png'), clip: { x: side.x, y: side.y, width: side.width, height: 210 } })

  // 标签溢出：横向滚动条只占 3px，36px 高的标签栏里不会把标签压扁
  await zoom.getByRole('button', { name: '资源管理器', exact: true }).click()
  // main.js 现在是预览标签，双击锁定它，后两个文件才会各开一个新标签
  await zoom.getByRole('button', { name: 'main.js', exact: true }).dblclick()
  await zoom.getByRole('button', { name: 'README.md', exact: true }).dblclick()
  await zoom.waitForFunction(() => document.querySelectorAll('.world-vscode-tab').length === 2)
  await zoom.getByRole('button', { name: 'big.txt', exact: true }).click()
  await zoom.waitForFunction(() => document.querySelectorAll('.world-vscode-tab').length === 3)
  await zoom.waitForFunction(() => document.querySelector('.world-vscode-loading') === null, null, { timeout: 15000 })
  // 窗口收窄 + 侧栏拉宽，三个标签必然溢出，正好看滚动条
  await zoom.setViewportSize({ width: 1000, height: 760 })
  await zoom.waitForTimeout(400)
  const gripZoom = await zoom.locator('.world-vscode-sidebar-resize').boundingBox()
  await zoom.mouse.move(gripZoom.x + 3, gripZoom.y + 200)
  await zoom.mouse.down()
  await zoom.mouse.move(gripZoom.x + 243, gripZoom.y + 200, { steps: 6 })
  await zoom.mouse.up()
  await zoom.waitForTimeout(350)
  const strip = await zoom.locator('.world-vscode-tabs').boundingBox()
  await zoom.screenshot({ path: join(shots, 'vscode-tabs.png'), clip: strip })
  // 窗口键细节（2x）：最大化后右侧是「还原」图标，三个键等高同宽
  await zoom.getByRole('button', { name: '最大化 Visual Studio Code' }).click()
  await zoom.waitForTimeout(350)
  const caps = await zoom.locator('.world-vscode-controls').boundingBox()
  await zoom.screenshot({ path: join(shots, 'vscode-caps.png'), clip: { x: caps.x - 140, y: caps.y, width: caps.width + 140, height: caps.height } })
  await zoom.close()
  console.log('shots written')
} finally {
  await browser.close()
}
