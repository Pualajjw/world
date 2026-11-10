import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { build } = await import(pathToFileURL(join(root, '../pbpkg/node_modules/esbuild/lib/main.js')))
const require = (await import('node:module')).createRequire(join(root, '../workflow-studio/package.json'))
const { chromium } = require('playwright-core')
const browserPath = process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
if (!existsSync(browserPath)) { console.log('no browser'); process.exit(0) }

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
const shots = join(root, 'prototype/shots')
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const html = '<!doctype html><html data-windows-titlebar style="--dsh-windows-titlebar-height:40px"><head><style>#root{position:relative;width:100vw;height:100vh}.app-frame{position:relative;width:100%;height:100%;padding-top:var(--dsh-windows-titlebar-height);box-sizing:border-box}#host-ui{position:absolute;inset:var(--dsh-windows-titlebar-height) 0 0;background:#262626}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>'
  await page.route('http://world.test/**', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }))
  await page.goto('http://world.test/index.html')
  await page.evaluate(() => {
    localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode', 'lanchat']))
    localStorage.setItem('dsh.world.depth', 'on')
  })
  await page.reload()
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')

  await page.mouse.move(300, 780)
  await page.waitForTimeout(4200)
  await page.screenshot({ path: join(shots, 'shot-plane-near.png') })

  await page.mouse.move(980, 520)
  await page.waitForTimeout(4200)
  await page.screenshot({ path: join(shots, 'shot-plane-far.png') })

  await page.mouse.move(620, 700)
  await page.waitForTimeout(3600)
  await page.screenshot({ path: join(shots, 'shot-plane-mid.png') })

  // 连拍几帧看抖动：同一位置停住，各帧脚底应当在同一处
  const feet = []
  for (let i = 0; i < 6; i += 1) {
    await page.waitForTimeout(120)
    feet.push(await page.locator('.world-walker').evaluate(el => {
      const box = el.getBoundingClientRect()
      return [Math.round(box.x + box.width / 2), Math.round(box.y + box.height)]
    }))
  }
  console.log('feet over 6 frames:', JSON.stringify(feet))
  console.log('icons:', JSON.stringify(await page.locator('.world-desktop-icon').evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect()
    return { left: Math.round(box.x), top: Math.round(box.y), w: Math.round(box.width), bottom: Math.round(box.y + box.height) }
  }))))

  // 连续移动鼠标（模拟人手），记录 data-walking 与翻面次数：应当只在开头/结尾各变一次
  await page.evaluate(() => {
    window.__log = []
    const el = document.querySelector('.world-walker')
    const face = el.querySelector('.world-walker-face')
    let prevWalking = el.dataset.walking
    let prevFace = face.style.transform
    const tick = () => {
      const now = el.dataset.walking
      const f = face.style.transform
      if (now !== prevWalking || f !== prevFace) {
        window.__log.push({ t: Math.round(performance.now()), walking: now, face: f })
        prevWalking = now
        prevFace = f
      }
      window.__raf = requestAnimationFrame(tick)
    }
    window.__raf = requestAnimationFrame(tick)
  })
  for (let i = 0; i <= 40; i += 1) {
    await page.mouse.move(200 + i * 24, 700 - Math.sin(i / 6) * 120)
    await page.waitForTimeout(16)
  }
  await page.waitForTimeout(2500)
  const log = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__log })
  console.log('transitions:', JSON.stringify(log))
} finally {
  await browser.close()
}
