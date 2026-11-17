import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

/**
 * 窗口边缘吸附：顶边 = 最大化（0.2.86），左右边 = 占半屏（0.2.106），最大化状态下拖标题栏 = 先还原再跟手。
 * 单独开一张干净的桌面页跑：主流程（browser.mjs）后面有一堆按绝对坐标点的断言，
 * 在这里把主窗口挪到半屏会连带把它们弄红。
 */
const HTML = '<!doctype html><html data-windows-titlebar style="--dsh-windows-titlebar-height:40px"><head><style>'
  + '#root{position:relative;width:100vw;height:100vh}.app-frame{position:relative;width:100%;height:100%;padding-top:var(--dsh-windows-titlebar-height);box-sizing:border-box}'
  + '.app-frame::before{content:"";position:absolute;inset:0 0 auto;height:var(--dsh-windows-titlebar-height);-webkit-app-region:drag}'
  + '#host-ui{position:absolute;inset:var(--dsh-windows-titlebar-height) 0 0;background:#262626}'
  + '[data-shell-overlay]{position:absolute;inset:0;z-index:20;pointer-events:none}[data-shell-overlay]>*{pointer-events:auto}'
  + '</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main>'
  + '<div id="overlay-root" data-shell-overlay></div></div></div></body></html>'

const rectOf = (page, selector) => page.locator(selector).evaluate(element => {
  const box = element.getBoundingClientRect()
  return {
    x: Math.round(box.x), y: Math.round(box.y), right: Math.round(box.right), bottom: Math.round(box.bottom),
    w: Math.round(box.width), h: Math.round(box.height),
  }
})

/** 按住标题栏把窗口甩到某一点：行程要够（dragTraveled ≥ 4px），否则会被当成「点了一下」。 */
async function fling(page, selector, from, to) {
  const bar = await page.locator(selector).boundingBox()
  await page.mouse.move(bar.x + from.x, bar.y + from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(240)
}

export async function checkWindowEdges(browser, bundleText) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.route('http://127.0.0.1/world-edges', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML }))
    await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.goto('http://127.0.0.1/world-edges')
    await page.evaluate(() => localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode', 'terminal'])))
    await page.addScriptTag({ content: bundleText })
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')

    await page.locator('[data-world-icon-id="dsh"]').dblclick()
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'normal')
    await page.waitForTimeout(240)
    const normal = await rectOf(page, '#root')
    assert.deepEqual({ x: normal.x, y: normal.y, w: normal.w, h: normal.h }, { x: 256, y: 72, w: 768, h: 544 })

    // 最大化时拖标题栏：先还原成原来大小再跟手（以前 state !== 'normal' 直接 return，整条标题栏是死区）
    await page.getByRole('button', { name: '最大化' }).click()
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'max')
    await fling(page, '.world-titlebar', { x: 300, y: 20 }, { x: 300, y: 320 })
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'normal')
    // 窗口位置有 160ms 过渡：等它落定再量，否则量到的是动画起点
    await page.waitForTimeout(240)
    const draggedMax = await rectOf(page, '#root')
    assert.equal(draggedMax.w, normal.w, '拖最大化窗口要还原成原来的宽度，不是继续全屏')
    assert.equal(draggedMax.h, normal.h, '高度也一起还原')
    assert.ok(draggedMax.y > normal.y && draggedMax.y <= 320, `窗口要落在光标下面，实际 y=${draggedMax.y}`)

    // 左右边缘：甩到左边占左半屏，再甩到右边贴右边界。
    // 顺带核一遍拖动途中的预览——松手之前就得看见「会占到哪儿」，而且宽高要和真吸附后一致
    // （半屏受最小宽度兜底，不是死板的 50vw；预览画成 50vw 等于在骗人）。
    const dragBar = await page.locator('.world-titlebar').boundingBox()
    await page.mouse.move(dragBar.x + 300, dragBar.y + 20)
    await page.mouse.down()
    await page.mouse.move(4, 400, { steps: 8 })
    await page.waitForTimeout(120)
    const previewBox = await page.evaluate(() => {
      const element = document.querySelector('[data-world-snap-preview]')
      if (!element) return null
      const box = element.getBoundingClientRect()
      return {
        side: element.dataset.worldSnapPreview, x: Math.round(box.x), y: Math.round(box.y),
        w: Math.round(box.width), h: Math.round(box.height), pointerEvents: getComputedStyle(element).pointerEvents,
      }
    })
    assert.deepEqual(previewBox, { side: 'left', x: 0, y: 40, w: 720, h: 712, pointerEvents: 'none' }, '拖动途中要预演左半屏')
    await page.mouse.up()
    await page.waitForTimeout(240)
    assert.equal(await page.locator('[data-world-snap-preview]').count(), 0, '松手后预览要撤掉')
    const left = await rectOf(page, '#root')
    assert.equal(left.x, 0, '甩到左边就贴住左边')
    assert.equal(left.y, 40, '从桌面顶栏下面开始')
    assert.equal(left.h, 712, '铺到任务栏上沿')
    // 1280 的一半只有 640，会撞上主窗口 720px 的最小宽度：按 720 收，不留一条窄缝
    assert.equal(left.w, 720, `左半屏宽度 ${left.w}`)

    await fling(page, '.world-titlebar', { x: 300, y: 20 }, { x: 1278, y: 400 })
    const right = await rectOf(page, '#root')
    assert.equal(right.right, 1280, '甩到右边就贴住右边')
    assert.equal(right.w, left.w, '两边宽度一致')
    assert.equal(right.h, left.h, '两边高度一致')

    // 应用窗口走同一套边缘判定：VSCode 甩到右边也要贴住右边界与任务栏
    await page.locator('[data-world-icon-id="vscode"]').dblclick()
    await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window').length === 1)
    await fling(page, '.world-vscode-titlebar', { x: 150, y: 20 }, { x: 1278, y: 300 })
    const vscode = await rectOf(page, '.world-vscode-window')
    assert.equal(vscode.right, 1280, 'VSCode 窗口也要贴住右边界')
    assert.equal(vscode.bottom, 752, 'VSCode 窗口也要铺到任务栏上沿')
    assert.equal(await page.evaluate(() => document.querySelector('.world-vscode-window').classList.contains('is-max')), false, '半屏不是最大化')

    // 应用窗口的最大化拖动也一样：终端窗口以前是「一块死区」，现在拖起来先还原
    await page.locator('.world-vscode-window').getByRole('button', { name: '关闭 Visual Studio Code' }).click()
    await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window').length === 0)
    await page.locator('[data-world-icon-id="terminal"]').dblclick()
    await page.waitForFunction(() => document.querySelector('.world-terminal-window'))
    const terminal = page.locator('.world-terminal-window')
    await terminal.getByRole('button', { name: '最大化' }).click()
    await page.waitForFunction(() => document.querySelector('.world-terminal-window')?.classList.contains('is-max'))
    await page.waitForTimeout(240)
    assert.equal((await rectOf(page, '.world-terminal-window')).w, 1280, '终端最大化铺满')
    await fling(page, '.world-terminal-window .world-vscode-titlebar', { x: 200, y: 20 }, { x: 200, y: 300 })
    await page.waitForTimeout(240)
    assert.equal(await terminal.evaluate(element => element.classList.contains('is-max')), false, '拖最大化的终端要还原')
    assert.ok((await rectOf(page, '.world-terminal-window')).h < 712, '还原回普通高度')

    await page.evaluate(() => window.__worldTesting.dispose())
    assert.deepEqual(errors, [])
    console.log(`Window edges passed: ${JSON.stringify({ normal, draggedMax, left, right, vscode })}`)
  } finally {
    await page.close()
  }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/window-edges.mjs')) {
  const { createRequire } = await import('node:module')
  const { build } = await import('../../pbpkg/node_modules/esbuild/lib/main.js')
  const { chromium } = createRequire(new URL('../../workflow-studio/package.json', import.meta.url))('playwright-core')
  const root = new URL('../', import.meta.url)
  const bundle = await build({ absWorkingDir: fileURLToPath(root), entryPoints: ['tests/browser-entry.js'],
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false,
    nodePaths: [fileURLToPath(new URL('../../workflow-studio/node_modules', import.meta.url))], loader: { '.css': 'text' } })
  const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  try { await checkWindowEdges(browser, bundle.outputFiles[0].text) } finally { await browser.close() }
}
