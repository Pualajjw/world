/** Check: sru (user object) Properties panel must use the same grouped layout as the window designer. */
import { sruFiles } from './srw-fixture.js'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
let build
try { ({ build } = await import('esbuild')) } catch { ({ build } = await import(pathToFileURL(join(root, '../pbpkg/node_modules/esbuild/lib/main.js')))) }
const require = (await import('node:module')).createRequire(join(root, '../workflow-studio/package.json'))
const { chromium } = require('playwright-core')
const browserPath = process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
if (!existsSync(browserPath)) { console.log('no browser'); process.exit(0) }
const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false, nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' }, legalComments: 'none' })
const html = '<!doctype html><html data-windows-titlebar style="--dsh-windows-titlebar-height:40px"><head><style>#root{position:relative;width:100vw;height:100vh}.app-frame{position:relative;width:100%;height:100%;padding-top:var(--dsh-windows-titlebar-height);box-sizing:border-box}#host-ui{position:absolute;inset:var(--dsh-windows-titlebar-height) 0 0;background:#262626}[data-shell-overlay]{position:absolute;inset:0;z-index:20;pointer-events:none}[data-shell-overlay]>*{pointer-events:auto}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>'
const browser = await chromium.launch({ executablePath: browserPath, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })
  await page.setContent(html)
  await page.evaluate(sru => {
    window.__worldSourceOpen = async ({path}) => ({ok:true,value:{path,source:sru,version:'t',eol:'LF',encoding:'UTF-8'}})
    window.__worldWorkspaceList = async ({path}) => ({ok:true,value:{path,parent:'',entries:[{name:'sailjson.sru',type:'file'}]}})
  }, sruFiles['sailjson.sru'])
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.getByRole('button', {name:'开始', exact:true}).click()
  await page.locator('[data-world-app-card="vscode"] .world-app-open').click()
  const editor = page.locator('.world-vscode-window[data-world-vscode-key]')
  await editor.getByRole('button', {name:'sailjson.sru', exact:true}).dblclick()
  await editor.locator('.world-srw-panes').waitFor()
  const props = editor.locator('[data-srw-view=properties]')
  await editor.locator('.world-vscode-tab').filter({hasText:'Properties'}).click()
  await props.waitFor()
  await page.waitForTimeout(200)
  const groups = await props.locator('.world-srw-group > summary').allTextContents()
  const rows = await props.locator('dl > div').count()
  const labels = await props.locator('dt').allTextContents()
  const values = await props.locator('dd').evaluateAll(list => list.map(d => ({
    text: d.textContent.trim(), checkbox: Boolean(d.querySelector('input[type=checkbox]')),
    h: Math.round(d.getBoundingClientRect().height),
  })))
  const shots = join(root, 'tmp/ui-polish')
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: join(shots, 'sru-properties.png') })
  await page.close()

  // sailjson.sru: AutoInstantiate + EAServer Project. The bare <dl> had no group header at all.
  const failures = []
  if (groups.length !== 1) failures.push(`分组数 ${groups.length} != 1：${JSON.stringify(groups)}`)
  if (!groups[0]?.startsWith('用户对象')) failures.push(`第一个分组标题不是「用户对象」：${groups[0]}`)
  if (rows !== 2) failures.push(`字段行数 ${rows} != 2：${JSON.stringify(labels)}`)
  if (!labels.some(t => t === 'AutoInstantiate')) failures.push('缺少 AutoInstantiate 字段')
  // 空值必须给占位符：空 dd 比有字的矮 3px，整列看着像少了一块
  for (const [i, value] of values.entries()) if (!value.text && !value.checkbox) failures.push(`第 ${i + 1} 个值为空（应显示 —）`)
  const heights = values.map(v => v.h)
  if (heights.length && Math.max(...heights) - Math.min(...heights) > 1) failures.push(`值行高不齐：${heights.join('/')}`)
  console.log(JSON.stringify({ groups, rows, labels, values }))
  if (failures.length) {
    console.log('FAIL')
    for (const line of failures) console.log(' - ' + line)
    process.exitCode = 1
  } else console.log('PASS: sru 属性面板已分组（图见 tmp/ui-polish/sru-properties.png）')
} finally { await browser.close() }
