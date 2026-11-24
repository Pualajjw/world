import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const root = join(import.meta.dirname, '..'), out = join(root, 'tmp/performance')
const require = createRequire(join(root, '../workflow-studio/package.json'))
const { build } = require('esbuild'), { chromium } = require('playwright-core')
// Observe construction of actual tab headers. No counter or alternate implementation in the shipped UI.
const bundle = await build({ stdin: { resolveDir: root, contents: `import React from 'react'
  const create = React.createElement
  React.createElement = function(type, props) {
    if (type === 'div' && props?.role === 'tab' && window.tabCounts) {
      const id = props['data-tab-id']; window.tabCounts[id] = (window.tabCounts[id] || 0) + 1
    }
    return create.apply(this, arguments)
  }
  import('./tests/browser-entry.js')` }, bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'text' }, nodePaths: [join(root, '../workflow-studio/node_modules')] })
const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } }), errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('http://127.0.0.1/tab-strip', r => r.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><style>body{margin:0}#root{height:100vh;width:100vw}</style><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></html>' }))
  await page.goto('http://127.0.0.1/tab-strip')
  const names = [...Array.from({length:4}, (_,i) => `w_${i}.srw`), ...Array.from({length:40}, (_,i) => `file-${i}.js`)]
  await page.evaluate(names => {
    localStorage.setItem('dsh.world.apps', '["vscode"]')
    window.__worldDesktopCall = op => op === 'poll' ? new Promise(() => {}) : {}
    window.__worldBrainCall = () => ({ sessionId: 'session-1', setupRequired: false })
    window.__worldWorkspaceList = ({ path }) => ({ ok: true, value: { path, entries: names.map(name => ({name,type:'file'})) } })
    window.__worldSourceOpen = async ({path}) => ({ok:true, value:{path, version:'v1', eol:'LF', encoding:'UTF-8',
      source: path.endsWith('.srw') ? `global type ${path.split('/').pop().slice(0,-4)} from window\nend type\nevent open;return 1\nend event` : `// ${path.split('/').pop()}` }})
  }, names)
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.locator('[data-world-icon-id="vscode"]').dblclick()
  const editor = page.locator('.world-vscode-window'), strip = editor.locator('[data-world-group="main"]').first()
  const header = name => strip.locator('.world-vscode-tab').filter({has:page.getByText(name, {exact:true})})
  for (const name of names) {
    await editor.getByRole('button', {name, exact:true}).dblclick()
    if (name.endsWith('.srw')) await editor.locator('[data-srw-view="layout"]').waitFor()
    await header(name.endsWith('.srw') ? name + ' · 设计' : name).waitFor()
  }
  assert.equal(await strip.getByRole('tab').count(), names.length)
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable')
  const scriptMs = async () => 1000 * (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ScriptDuration').value
  const switches = 24
  const run = count => strip.evaluate(async (strip, { count, switches }) => {
    const tabs = [...strip.querySelectorAll('[role="tab"]')].slice(-2), ids = tabs.map(t => t.dataset.tabId)
    window.tabCounts = count ? {} : null
    for (let i = 0; i < switches; i++) {
      const tab = tabs[i % 2]; tab.click(); await new Promise(resolve => setTimeout(resolve, 0))
      const expected = tab.querySelector('.world-vscode-tab-name').textContent
      if (tab.getAttribute('aria-selected') !== 'true' || document.querySelector('.world-vscode-textarea')?.value !== `// ${expected}`) throw Error(`wrong selection: ${expected}`)
    }
    const counts = Object.entries(window.tabCounts || {}); window.tabCounts = null
    return { activeHeaders: counts.filter(([id]) => ids.includes(id)).reduce((n,[,v]) => n+v,0),
      unrelatedHeaders: counts.filter(([id]) => !ids.includes(id)).reduce((n,[,v]) => n+v,0) }
  }, {count, switches})
  await run(false)
  const samples = []
  for (let i = 0; i < 5; i++) { const start = await scriptMs(); await run(false); samples.push(await scriptMs() - start) }
  const result = { tabs:names.length, switches, ...await run(true), medianScriptMs:Math.round(samples.sort((a,b)=>a-b)[2]) }
  console.log('Tab switching:', JSON.stringify(result))
  // Mark a draft dirty, switch away and back by keyboard, then check the design owner still activates its child.
  const input = editor.locator('.world-vscode-textarea')
  await input.fill('// unsaved'); await header('file-39.js').locator('.world-vscode-tab-dirty').waitFor()
  await header('file-38.js').click(); await header('file-39.js').press('Enter'); assert.equal(await input.inputValue(), '// unsaved')
  await header('w_2.srw · 设计').click(); await editor.locator('[data-srw-view="layout"]').waitFor()
  await mkdir(out, { recursive:true }); await editor.screenshot({path:join(out,'tab-strip.png')})
  await writeFile(join(out,'tab-strip.json'),JSON.stringify(result,null,2)+'\n')
  assert.deepEqual(errors, [])
  assert.ok(result.activeHeaders >= switches * 2, 'the old and new active headers must update')
  assert.equal(result.unrelatedHeaders, 0, 'switching focus must not render other tab headers')
} finally { await browser.close() }
