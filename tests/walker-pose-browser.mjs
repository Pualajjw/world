// 小机器人按活动相位换姿势：逐相位截图 + 关键部件必须真的离开站姿。
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 每个相位的特征动作，以及该出现／该消失的点缀
const CASES = [
  { phase: 'idle' },
  { phase: 'starting' },
  { phase: 'thinking', show: '.wn-bubble .wn-dot' },
  { phase: 'executing', show: '.wn-spark path', hide: '.wn-dot' },
  { phase: 'responding' },
  { phase: 'waiting' },
  { phase: 'paused', show: '.wn-z' },
  { phase: 'error' },
  { phase: 'stopped', show: '.wn-z' },
]

export async function checkWalkerPoses(browser, bundleText, shotsDir) {
  // 截图是可选的：不给目录就只做几何断言，免得每次跑全量都在仓库里堆 27 张图。
  if (shotsDir) mkdirSync(shotsDir, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  try {
    const html = '<!doctype html><html data-windows-titlebar style="--dsh-windows-titlebar-height:40px"><head><style>#root{position:relative;width:100vw;height:100vh}.app-frame{position:relative;width:100%;height:100%;padding-top:var(--dsh-windows-titlebar-height);box-sizing:border-box}#host-ui{position:absolute;inset:var(--dsh-windows-titlebar-height) 0 0;background:#262626}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>'
    await page.route('http://world.test/**', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }))
    await page.goto('http://world.test/index.html')
    await page.evaluate(() => {
      localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode', 'lanchat']))
      localStorage.setItem('dsh.world.depth', 'on')
    })
    await page.reload()
    await page.addScriptTag({ content: bundleText })
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')

    // 站到一片空地上，等它停稳：姿势只在站定时才归相位管
    await page.mouse.move(700, 760)
    await page.waitForFunction(() => document.querySelector('.world-walker').dataset.walking === 'off', null, { timeout: 12000 })
    await page.waitForTimeout(600)

    const state = () => page.evaluate(() => {
      const walker = document.querySelector('.world-walker')
      const read = selector => {
        const node = document.querySelector(selector)
        if (!node) return null
        const r = node.getBoundingClientRect()
        return { x: +r.x.toFixed(1), y: +r.y.toFixed(1) }
      }
      return { phase: walker.dataset.phase, walking: walker.dataset.walking, grabbing: walker.dataset.grabbing,
        head: read('.wn-head'), armA: read('.wn-arm-a'), body: read('.world-walker-body') }
    })
    // 把这一帧定住：所有 CSS 动画暂停在周期内同一比例，逐相位才可比
    const pose = (phase, ratio) => page.evaluate(({ phase, ratio }) => {
      document.querySelector('.world-walker').setAttribute('data-phase', phase)
      for (const animation of document.getAnimations()) {
        try {
          const duration = Number(animation.effect.getComputedTiming().duration) || 0
          animation.pause()
          animation.currentTime = duration * ratio
        } catch { /* 已结束的动画忽略 */ }
      }
    }, { phase, ratio })
    const box = () => page.locator('.world-walker').evaluate(el => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })

    const report = {}
    for (const item of CASES) {
      report[item.phase] = []
      for (const ratio of [.08, .38, .62]) {
        await pose(item.phase, ratio)
        await page.waitForTimeout(60)
        if (ratio === .38 && shotsDir) {
          const shot = await box()
          await page.screenshot({ path: join(shotsDir, `${item.phase}.png`),
            clip: { x: shot.x - 26, y: shot.y - 34, width: shot.width + 52, height: shot.height + 46 } })
        }
        const now = await state()
        if (now.walking !== 'off') throw new Error(`相位测试要求站定：${item.phase} walking=${now.walking}`)
        report[item.phase].push(now)
      }
      // 点缀的显隐要在它自己「该亮」的那一帧看：统一停在周期 20%
      await pose(item.phase, .2)
      await page.waitForTimeout(50)
      if (item.show) {
        const shown = await page.locator(item.show).first().evaluate(el => Number(getComputedStyle(el).opacity))
        if (!(shown > .05)) throw new Error(`${item.phase} 应该显示 ${item.show}，实际 opacity=${shown}`)
      }
      if (item.hide) {
        const hidden = await page.locator(item.hide).first().evaluate(el => Number(getComputedStyle(el).opacity))
        if (hidden > .05) throw new Error(`${item.phase} 不该显示 ${item.hide}，实际 opacity=${hidden}`)
      }
    }

    const base = report.idle[1]
    const moved = phase => Math.max(...report[phase].map(row => Math.max(
      Math.abs(row.head.x - base.head.x), Math.abs(row.head.y - base.head.y),
      Math.abs(row.armA.x - base.armA.x), Math.abs(row.armA.y - base.armA.y),
      Math.abs(row.body.x - base.body.x))))
    const flat = Object.keys(report).filter(phase => phase !== 'idle' && moved(phase) < 1.5)
    if (flat.length) throw new Error(`这些相位的姿势和空闲没区别：${flat.join(', ')}`)
    return Object.fromEntries(Object.keys(report).map(phase => [phase, +moved(phase).toFixed(1)]))
  } finally { await page.close() }
}

// 单独跑：node tests/walker-pose-browser.mjs
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const { build } = await import(pathToFileURL(join(root, '../pbpkg/node_modules/esbuild/lib/main.js')).href)
  const require = (await import('node:module')).createRequire(join(root, '../workflow-studio/package.json'))
  const { chromium } = require('playwright-core')
  const browserPath = process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  if (!existsSync(browserPath)) { console.log('no browser'); process.exit(0) }
  const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true,
    format: 'iife', platform: 'browser', target: 'es2022', write: false,
    nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' }, legalComments: 'none' })
  const browser = await chromium.launch({ executablePath: browserPath, headless: true })
  try {
    console.log(JSON.stringify(await checkWalkerPoses(browser, bundle.outputFiles[0].text, join(root, 'prototype/shots/poses'))))
  } finally { await browser.close() }
}
