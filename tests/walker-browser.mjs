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


  const feet = () => page.locator('.world-walker').evaluate(el => {
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.bottom, z: Number(el.style.zIndex), width: r.width }
  })
  const stop = () => page.waitForFunction(() => document.querySelector('.world-walker').dataset.walking === 'off')
  const icon = await page.locator('.world-desktop-icon').first().boundingBox()
  const x = icon.x + icon.width / 2
  await page.mouse.move(x, icon.y + icon.height - 30)
  await page.waitForTimeout(6500)
  await stop()
  const behind = await feet()
  const iconZ = () => page.locator('.world-desktop-icon').first().evaluate(el => Number(el.style.zIndex))
  if (behind.z >= await iconZ()) throw new Error('robot behind icon must have lower z-index')
  await page.screenshot({ path: join(shots, 'shot-walker-behind-icon.png') })
  await page.evaluate(() => {
    window.baseCheck = { crossings: 0, violations: 0 }
    let previous = null
    const sample = () => {
      const robot = document.querySelector('.world-walker').getBoundingClientRect()
      const current = { x: robot.x + robot.width / 2, y: robot.bottom, half: robot.width / 2 }
      if (previous) for (const icon of document.querySelectorAll('.world-desktop-icon')) {
        const r = icon.getBoundingClientRect()
        if ((previous.y - r.bottom) * (current.y - r.bottom) < 0) {
          const t = (r.bottom - previous.y) / (current.y - previous.y)
          const x = previous.x + (current.x - previous.x) * t
          const half = previous.half + (current.half - previous.half) * t
          window.baseCheck.crossings++
          if (x > r.left - half + .2 && x < r.right + half - .2) window.baseCheck.violations++
        }
      }
      previous = current
      window.baseRAF = requestAnimationFrame(sample)
    }
    sample()
  })
  await page.mouse.move(x, Math.min(840, icon.y + icon.height + 15))
  await page.waitForTimeout(5000)
  await stop()
  const front = await feet()
  if (front.z <= await iconZ()) throw new Error('robot in front must have higher z-index')
  const collision = await page.evaluate(() => { cancelAnimationFrame(window.baseRAF); return window.baseCheck })
  if (collision.violations) throw new Error(JSON.stringify(collision))
  await page.screenshot({ path: join(shots, 'shot-walker-front-icon.png') })
  await page.locator('.world-desktop-icon').first().dblclick()
  await page.waitForTimeout(500)
  const frame = await page.locator('.world-window-frame').boundingBox()
  await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2)
  await page.waitForFunction(() => document.querySelector('.world-walker').dataset.grabbing === 'on', null, { timeout: 15000 })
  const grip = await page.evaluate(() => {
    const r = document.querySelector('.world-window-frame').getBoundingClientRect()
    const hand = document.querySelector('.wn-arm-a circle:last-child').getBoundingClientRect()
    const x = hand.x + hand.width / 2
    return { gap: Math.min(Math.abs(x - r.left), Math.abs(x - r.right)), handY: hand.y + hand.height / 2, top: r.top, bottom: r.bottom }
  })
  if (grip.gap > .3 || grip.handY < grip.top || grip.handY > grip.bottom) throw new Error(JSON.stringify(grip))
  await page.screenshot({ path: join(shots, 'shot-walker-window-grip.png') })
  await page.mouse.move(1100, 800)
  await page.waitForFunction(() => document.querySelector('.world-walker').dataset.grabbing === 'off')
  await page.waitForTimeout(4500)
  await page.evaluate(() => {
    const iframe = document.createElement('iframe')
    iframe.srcdoc = '<body style="margin:0;background:#262626;color:white">Virtual screen</body>'
    iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0'
    document.querySelector('#host-ui').append(iframe)
  })
  await page.mouse.move(frame.x + frame.width - 40, frame.y + frame.height / 2)
  await page.waitForFunction(() => document.querySelector('.world-walker').dataset.grabbing === 'on', null, { timeout: 15000 })
  const rightGap = await page.evaluate(() => {
    const edge = document.querySelector('.world-window-frame').getBoundingClientRect().right
    const hand = document.querySelector('.wn-arm-a circle:last-child').getBoundingClientRect()
    return Math.abs(hand.x + hand.width / 2 - edge)
  })
  if (rightGap > .3) throw new Error('right/iframe grip gap: ' + rightGap)
  await page.screenshot({ path: join(shots, 'shot-walker-window-grip-right.png') })
  console.log(JSON.stringify({ behind, front, collision, grip, rightGap, released: true }))
} finally { await browser.close() }
