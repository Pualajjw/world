/** Cold-start diagnostic. Each sample gets a fresh browser process, no warm-up resize.
 * node tests/cold-maximize-browser.mjs [path/to/before/client.js path/to/after/client.js]
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..'), require = createRequire(join(root, '../workflow-studio/package.json'))
const { build } = require('esbuild'), { chromium } = require('playwright-core')
const paths = process.argv.slice(2).map(file => resolve(file))
if (!paths.length) paths.push(join(root, 'client.js'))
const fixture = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true,
  format: 'iife', platform: 'browser', target: 'es2022', write: false, define: { 'process.env.NODE_ENV': '"production"' },
  nodePaths: [join(root, '../workflow-studio/node_modules')], plugins: [{ name: 'built-world', setup(build) {
    // The DSH loader injects the host React. Exercise the distributable, not a development source build.
    build.onResolve({ filter: /^\.\.\/client-src\.js$/ }, () => ({ path: 'built-world', namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ resolveDir: root, contents: `
      import React from 'react'; import * as ReactDOM from 'react-dom';
      window.__ModuleLoader__ = {load({factory}) { window.__builtWorld = factory(id => {
        if (id === 'react') return React; if (id === 'react-dom') return ReactDOM; throw Error(id)
      }) }}; (0, eval)(window.__worldBundle); export const apply = window.__builtWorld.apply;` }))
  } }] })
const html = '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}</style></head><body><div id="root"><div><main></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>'

async function pair(text) {
  const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, args: ['--window-size=1180,820', '--screen-info={1920x1080}'] })
  try {
    const page = await browser.newPage({ viewport: null }), errors = []
    page.on('pageerror', e => errors.push(e.message))
    const cdp = await page.context().newCDPSession(page), { windowId } = await cdp.send('Browser.getWindowForTarget')
    await page.route('http://127.0.0.1/world-cold', route => route.fulfill({ contentType: 'text/html', body: html }))
    await page.goto('http://127.0.0.1/world-cold')
    await page.evaluate(text => {
      window.__worldBundle = text
      localStorage.setItem('dsh.world.apps', '["vscode"]')
      window.__worldDesktopCall = op => op === 'poll' ? new Promise(() => {}) : {}; window.__worldBrainCall = async () => ({ sessionId: 'session-1', setupRequired: false })
    }, text)
    await page.addScriptTag({ content: fixture.outputFiles[0].text })
    await page.locator('.world-wall').waitFor()
    const normal = await page.evaluate(() => innerWidth), times = []
    for (const state of ['maximized', 'normal', 'maximized']) {
      // Arm before sending the native command; no fixed wait and no synthetic resize event.
      await page.evaluate(() => { window.__painted = new Promise(resolve => {
        const timeout = setTimeout(() => resolve(null), 5000)
        window.addEventListener('resize', () => requestAnimationFrame(() => requestAnimationFrame(() => {
          clearTimeout(timeout); resolve([innerWidth, document.querySelector('.world-wall').getBoundingClientRect().width])
        })), { once: true })
      }) })
      const start = performance.now()
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: state } })
      const box = await page.evaluate(() => window.__painted), ms = Math.round(performance.now() - start)
      assert.ok(box && box[0] === box[1], 'desktop should cover the resized native viewport')
      assert.ok(state === 'normal' ? box[0] === normal : box[0] > normal)
      if (state === 'maximized') times.push(ms)
    }
    assert.deepEqual(errors, []); return times
  } finally { await browser.close() }
}
const cases = await Promise.all(paths.map(async file => ({ file, text: await readFile(file, 'utf8'), pairs: [] })))
for (let i = 0; i < 5; i++) for (const item of i % 2 ? [...cases].reverse() : cases) item.pairs.push(await pair(item.text))
const median = xs => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]
for (const { file, pairs } of cases) console.log(JSON.stringify({ file, pairs, firstMs: median(pairs.map(p => p[0])), secondMs: median(pairs.map(p => p[1])) }))
