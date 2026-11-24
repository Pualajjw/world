/**
 * 视觉截图工具（不做断言）：把设计组每个底部视图在深浅两套主题下各截一张到 tmp/ui-views/。
 * 断言在 tests/ui-polish-baseline.mjs 里，这里只负责出图给人看。
 */
import { card } from './srw-fixture.js'
import { existsSync, mkdirSync } from 'node:fs'
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
  absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true, format: 'iife', platform: 'browser',
  target: 'es2022', write: false, nodePaths: [join(root, '../workflow-studio/node_modules')],
  loader: { '.css': 'text' }, legalComments: 'none',
})
const html = '<!doctype html><html data-windows-titlebar style="--dsh-windows-titlebar-height:40px"><head><style>#root{position:relative;width:100vw;height:100vh}.app-frame{position:relative;width:100%;height:100%;padding-top:var(--dsh-windows-titlebar-height);box-sizing:border-box}#host-ui{position:absolute;inset:var(--dsh-windows-titlebar-height) 0 0;background:#262626}[data-shell-overlay]{position:absolute;inset:0;z-index:20;pointer-events:none}[data-shell-overlay]>*{pointer-events:auto}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>'
const shots = join(root, 'tmp/ui-views')
mkdirSync(shots, { recursive: true })

const browser = await chromium.launch({ executablePath: browserPath, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })
  await page.setContent(html)
  await page.evaluate(source => {
    window.__worldSourceOpen = async ({path}) => ({ok:true,value:{path,source,version:'t',eol:'LF',encoding:'UTF-8'}})
    window.__worldWorkspaceList = async ({path}) => ({ok:true,value:{path,parent:'',entries:['w_dk.srw'].map(name=>({name,type:'file'}))}})
  }, card)
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.getByRole('button', {name:'开始', exact:true}).click()
  await page.locator('[data-world-app-card="vscode"] .world-app-install').click()
  await page.locator('[data-world-app-card="vscode"] .world-app-open').click()
  const editor = page.locator('.world-vscode-window[data-world-vscode-key]')
  await editor.waitFor()
  await editor.getByRole('button', {name:'w_dk.srw', exact:true}).dblclick()
  const panes = editor.locator('.world-srw-panes')
  await panes.waitFor()
  await page.waitForTimeout(300)

  const views = ['Layout', 'Event List', 'Function List', 'Variables', 'Properties', 'Control List', 'Non-Visual Object List']
  for (const theme of ['light', 'dark']) {
    await page.evaluate(t => { document.body.dataset.worldTheme = t; document.body.dataset.worldWallTone = t }, theme)
    await page.waitForTimeout(120)
    for (const name of views) {
      const tab = panes.locator('.world-vscode-tab').filter({hasText: name}).first()
      if (!(await tab.count())) { console.log('missing view', theme, name); continue }
      await tab.click()
      await page.waitForTimeout(180)
      // The event/function list opens a script tab; screenshot the whole pane area, not just the view body.
      const box = await panes.boundingBox()
      if (!box) { console.log('no pane box', name); continue }
      await page.screenshot({ path: join(shots, `${theme}-${name.replace(/ /g, '-')}.png`), clip: box })
    }
  }
  await page.close()
  console.log('shots in tmp/ui-views')
} finally { await browser.close() }
