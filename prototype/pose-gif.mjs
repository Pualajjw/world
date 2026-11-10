// 生成相位动效帧：每个相位一段，供合成 GIF 看动作差别。一次性工具。
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { build } = await import(pathToFileURL(join(root, '../pbpkg/node_modules/esbuild/lib/main.js')).href)
const require = (await import('node:module')).createRequire(join(root, '../workflow-studio/package.json'))
const { chromium } = require('playwright-core')
const browserPath = process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
if (!existsSync(browserPath)) { console.log('no browser'); process.exit(0) }

const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true,
  format: 'iife', platform: 'browser', target: 'es2022', write: false,
  nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' }, legalComments: 'none' })

const PHASES = ['thinking', 'executing', 'waiting', 'paused']
const FRAMES = 18
const out = join(root, 'prototype/shots/poses/frames')
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ executablePath: browserPath, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const html = '<!doctype html><html data-windows-titlebar style="--dsh-windows-titlebar-height:40px"><head><style>#root{position:relative;width:100vw;height:100vh}.app-frame{position:relative;width:100%;height:100%;padding-top:var(--dsh-windows-titlebar-height);box-sizing:border-box}#host-ui{position:absolute;inset:var(--dsh-windows-titlebar-height) 0 0;background:#262626}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>'
  await page.route('http://world.test/**', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }))
  await page.goto('http://world.test/index.html')
  await page.evaluate(() => localStorage.setItem('dsh.world.depth', 'on'))
  await page.reload()
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')
  await page.mouse.move(720, 700)
  await page.waitForFunction(() => document.querySelector('.world-walker').dataset.walking === 'off', null, { timeout: 12000 })
  await page.waitForTimeout(700)

  const box = await page.locator('.world-walker').evaluate(el => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  const clip = { x: Math.round(box.x - 24), y: Math.round(box.y - 40), width: Math.round(box.width + 48), height: Math.round(box.height + 54) }
  for (const phase of PHASES) {
    for (let i = 0; i < FRAMES; i++) {
      await page.evaluate(({ phase, ratio }) => {
        document.querySelector('.world-walker').setAttribute('data-phase', phase)
        for (const animation of document.getAnimations()) {
          try {
            const duration = Number(animation.effect.getComputedTiming().duration) || 0
            animation.pause()
            animation.currentTime = duration * ratio
          } catch { /* 忽略 */ }
        }
      }, { phase, ratio: i / FRAMES })
      await page.screenshot({ path: join(out, `${phase}-${String(i).padStart(2, '0')}.png`), clip })
    }
  }
  console.log(JSON.stringify({ clip, frames: FRAMES, phases: PHASES }, null, 1))
} finally { await browser.close() }
