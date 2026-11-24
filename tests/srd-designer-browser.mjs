import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { profileSelection } from './srd-selection-profile.mjs'
import { revealSource, testPickerReveal } from './srd-picker-reveal.mjs'

const root = join(import.meta.dirname, '..'), shots = join(root, 'tmp/srd-designer')
const require = createRequire(join(root, '../workflow-studio/package.json'))
const { build } = require('esbuild'), { chromium } = require('playwright-core')
const sample = new TextDecoder('gbk').decode(await readFile(join(root, '../../../src/templates/uo_datawindow.srd')))
const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true, platform: 'browser', format: 'iife',
  target: 'es2022', write: false, define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'text' },
  plugins: [{ name: 'count-srd-object-paints', setup(b) {
    b.onLoad({ filter: /srd-layout\.js$/ }, async ({path}) => {
      const src = await readFile(path, 'utf8'), line = 'const { type, props: p, box } = obj'
      assert.equal(src.split(line).length, 2)
      return { contents: src.replace(line, `window.__srdPaints++; ${line}`), loader: 'js' }
    })
  } }], nodePaths: [join(root, '../workflow-studio/node_modules')] })
const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
try {
  const page = await browser.newPage({ viewport: {width: 1440, height: 950} }), errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('http://127.0.0.1/srd', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><style>body{margin:0}#root{width:100vw;height:100vh}</style><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></html>' }))
  await page.goto('http://127.0.0.1/srd')
  await page.evaluate(({sample, revealSource}) => {
    localStorage.setItem('dsh.world.apps', '["vscode"]'); window.__source = sample; window.__revealSource = revealSource; window.__version = '1'; window.__srdPaints = 0
    window.__worldDesktopCall = op => op === 'poll' ? new Promise(() => {}) : {}
    window.__worldBrainCall = () => ({sessionId:'session-1', setupRequired:false})
    window.__worldWorkspaceList = ({path}) => ({ok:true,value:{path,parent:'',entries:[{name:'d_sample.SRD', type:'file'}, {name:'d_dense.srd', type:'file'}, {name:'d_reveal.srd', type:'file'}]}})
    window.__worldSourceOpen = async ({path}) => ({ok:true,value:{path,source:path.endsWith('d_dense.srd') ? window.__dense : path.endsWith('d_reveal.srd') ? window.__revealSource : window.__source,version:window.__version,eol:'LF',encoding:'GBK',readOnly:false}})
    window.__worldSourceVersions = async ({paths}) => ({ok:true,value:{versions:paths.map(path => ({path,version:window.__version}))}})
  }, {sample, revealSource})
  await page.addScriptTag({content:bundle.outputFiles[0].text})
  await page.locator('[data-world-icon-id="vscode"]').dblclick()
  const editor = page.locator('.world-vscode-window'), group = editor.locator('.world-srw-panes')
  const canvas = group.locator('[data-srw-view=layout]'), props = group.locator('[data-srw-view=properties]'), parent = editor.locator('[data-parent-tab]')
  const checkTabs = async () => assert.deepEqual(await group.locator('.world-vscode-tab-name').allTextContents(), ['Layout','Properties'])
  await editor.getByRole('button', {name:'d_sample.SRD',exact:true}).dblclick()
  const field = canvas.getByRole('button', {name:'column a4',exact:true}); await field.click(); await checkTabs()
  assert.equal(await props.locator('select option:checked').innerText(), 'column · a4')
  assert.match(await props.innerText(), /绑定列/); assert.match(await props.innerText(), /下拉1/)
  const geometry = await field.evaluate(el => { const band = el.closest('[data-band]'), a = el.getBoundingClientRect(), b = band.getBoundingClientRect();
    return [a.x-b.x, a.y-b.y, a.width, a.height, b.height].map(n => Math.round(n*10)/10) })
  assert.deepEqual(geometry, [178.1, 15, 141.1, 19, 223]); console.log('a4 x/y/w/h, detail height (CSS px):', geometry)
  await mkdir(shots,{recursive:true}); await editor.screenshot({path:join(shots,'srd-layout-properties.png')})
  await props.getByLabel('属性对象').selectOption('band:detail'); assert.match(await props.innerText(), /控件数量/)
  await parent.click({button:'right'}); await editor.getByRole('menuitem',{name:'恢复默认布局'}).click(); await checkTabs()
  await field.focus(); await field.press('Space'); assert.equal(await props.locator('select option:checked').innerText(), 'column · a4')
  const picker = props.getByLabel('属性对象'), oldCount = await picker.locator('option').count()
  await page.evaluate(() => { window.__source = window.__source.replace('A1:', '已刷新') + '\ntext(band=detail name=added_in_refresh text="Added")'; window.__version = '2' })
  await canvas.getByText('已刷新',{exact:true}).waitFor({timeout:12000})
  assert.equal(await field.getAttribute('aria-pressed'), 'true', 'a refreshed model must restore its selected button')
  assert.equal(await picker.inputValue(), 'band:detail/a4'); assert.equal(await picker.locator('option').count(), oldCount + 1)
  await picker.selectOption('band:detail/added_in_refresh'); assert.match(await props.innerText(), /Added/)
  await page.evaluate(() => { window.__source = window.__source.slice(0, window.__source.lastIndexOf('\ntext(band=detail name=added_in_refresh')); window.__version = '3' })
  await picker.locator('option[value="band:detail/added_in_refresh"]').waitFor({state:'detached',timeout:12000})
  assert.equal(await picker.inputValue(), 'datawindow'); assert.equal(await picker.locator('option').count(), oldCount)
  const back = editor.getByRole('button',{name:'返回源码',exact:true}), source = editor.getByRole('textbox',{name:'编辑 d_sample.SRD',exact:true})
  await back.click(); const refreshed = await source.inputValue(); assert.match(refreshed, /已刷新/)
  await source.press('Control+f')
  const find = editor.getByRole('textbox', {name:'当前文件查找',exact:true})
  await find.fill('已刷新'); await find.press('Escape')
  assert.equal(await source.evaluate(n => n.value.slice(n.selectionStart, n.selectionEnd)), '已刷新')
  const draft = refreshed.replace('已刷新', '草稿'); await source.fill(draft)
  await editor.getByRole('button',{name:'设计视图',exact:true}).click(); await canvas.getByText('草稿',{exact:true}).waitFor(); await checkTabs()
  await back.click(); assert.equal(await source.inputValue(),draft); await profileSelection(page, editor, group, shots)
  await testPickerReveal(editor, shots); assert.deepEqual(errors,[])
  console.log('Passed: Layout/Properties only, selection, reset, external refresh, source draft round-trip. Screenshot:', shots)
} finally { await browser.close() }
