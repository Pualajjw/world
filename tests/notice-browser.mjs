import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HTML = '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>'

/** Exercise real desktop actions; only the shortcut RPC is simulated (no OS files are created). */
export async function checkNotices(browser, bundleText, shotsDir) {
  for (const phone of [false, true]) {
    const viewport = phone ? { width: 360, height: 640 } : { width: 1280, height: 800 }
    const page = await browser.newPage({ viewport, hasTouch: phone })
    const errors = [], calls = []
    let mode = 'failure'
    page.on('pageerror', error => errors.push(error.message))
    const shortcut = async () => {
      await page.locator('[data-world-icon-id="dsh"]').click({ button: 'right' })
      await page.locator('[data-role="launch-shortcut"]').click()
    }
    const notifySuccess = async () => {
      await page.locator('[data-world-icon-id="dsh"]').click({ button: 'right' })
      await page.locator('[data-role="reposition"]').click()
    }
    const text = () => page.locator('.world-toast [role="alert"]').innerText()
    const dismiss = () => page.getByRole('button', { name: '关闭错误提示', exact: true })
    try {
      await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
      await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
      await page.exposeBinding('__worldLaunchShortcut', payload => {
        calls.push(payload)
        if (mode === 'failure') throw new Error('无法写入快捷方式，请检查目录权限。')
        if (mode === 'partial') return { wrapper: 'C:/world/' + 'long-path-'.repeat(12) + '/launch.cmd', shortcutError: '桌面目录不可写。' }
        return { shortcut: 'C:/world/world.lnk' }
      })
      await page.route('http://127.0.0.1/world-notice-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML }))
      await page.goto('http://127.0.0.1/world-notice-fixture')
      if (!phone) await page.evaluate(() => document.documentElement.setAttribute('data-ds-dark-theme', ''))
      else await page.addStyleTag({ content: ':root{--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#17233c;--dsw-alias-label-secondary:#646e82;--dsw-alias-label-tertiary:#919baf}' })
      await page.addScriptTag({ content: bundleText })
      await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')

      // A success timer already running must not clear the error that arrives afterwards.
      await notifySuccess()
      assert.equal(await page.locator('.world-toast').getAttribute('role'), 'status')
      await shortcut()
      await dismiss().waitFor()
      assert.match(await text(), /创建快捷方式失败.*目录权限/u)
      assert.equal(await dismiss().evaluate(node => node === document.activeElement), false, 'errors do not steal keyboard focus')

      // Later successes, other errors and duplicate errors cannot replace the unread first error.
      await notifySuccess()
      mode = 'partial'
      await shortcut()
      await shortcut()
      await page.waitForTimeout(2800)
      assert.match(await text(), /目录权限/u, 'error survives the original and subsequent success timers')
      assert.equal(calls.length, 3, 'notices never retry shortcut creation automatically')
      const geometry = await page.locator('.world-toast').evaluate(node => {
        const box = node.getBoundingClientRect(), style = getComputedStyle(node)
        return { center: box.x + box.width / 2, bottom: innerHeight - box.bottom,
          padding: style.padding, radius: style.borderRadius, fontSize: style.fontSize }
      })
      assert.equal(geometry.center, viewport.width / 2)
      assert.equal(geometry.bottom, 64)
      assert.equal(geometry.padding, '9px 18px')
      assert.equal(geometry.radius, '10px')
      assert.equal(geometry.fontSize, '12px')
      if (shotsDir) {
        await mkdir(shotsDir, { recursive: true })
        await page.screenshot({ path: join(shotsDir, `notice-${phone ? 'phone' : 'desktop'}.png`) })
      }
      if (phone) await dismiss().tap()
      else { await dismiss().focus(); await page.keyboard.press('Enter') }
      assert.match(await text(), /启动器已生成.*快捷方式失败.*桌面目录不可写/u)
      await page.waitForTimeout(2800)
      assert.match(await text(), /桌面目录不可写/u, 'the next error also persists until dismissed')
      const bounds = await page.locator('.world-toast').boundingBox()
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width, 'long error stays within the viewport')
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, 'close action stays visible')
      assert.equal(await page.locator('.world-toast').evaluate(node => node.scrollWidth <= node.clientWidth), true)
      if (shotsDir) await page.screenshot({ path: join(shotsDir, `notice-long-${phone ? 'phone' : 'desktop'}.png`) })
      if (phone) await dismiss().tap()
      else { await dismiss().focus(); await page.keyboard.press('Space') }
      await page.waitForFunction(() => !document.querySelector('.world-toast'))

      // Normal success still disappears, and dismissing an error allows the same failure to be reported again.
      mode = 'success'
      await shortcut()
      await page.waitForFunction(() => document.querySelector('.world-toast')?.textContent.includes('已创建快捷方式'))
      assert.equal(await page.locator('.world-toast').getAttribute('role'), 'status')
      assert.equal(await dismiss().count(), 0)
      await page.waitForTimeout(2800)
      assert.equal(await page.locator('.world-toast').count(), 0)
      mode = 'failure'
      await shortcut()
      await dismiss().waitFor()
      await dismiss().click()
      await page.waitForFunction(() => !document.querySelector('.world-toast'))
      await notifySuccess()
      await page.evaluate(() => window.__worldTesting.dispose())
      assert.equal(await page.locator('.world-toast').count(), 0)
      assert.deepEqual(errors, [])
      console.log(`Notices passed: ${phone ? 'phone' : 'desktop'}; ${JSON.stringify(geometry)}`)
    } finally { await page.close() }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  let build
  try { ({ build } = await import('esbuild')) }
  catch { ({ build } = await import('../../pbpkg/node_modules/esbuild/lib/main.js')) }
  const require = createRequire(new URL('../../workflow-studio/package.json', import.meta.url))
  const { chromium } = require('playwright-core')
  const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true,
    format: 'iife', platform: 'browser', target: 'es2022', write: false,
    nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' } })
  const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  try { await checkNotices(browser, bundle.outputFiles[0].text, process.env.WORLD_NOTICE_SHOTS_DIR) }
  finally { await browser.close() }
}
