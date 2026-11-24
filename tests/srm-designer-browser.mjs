import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { profilePaint, profileSelection } from './srm-selection-profile.mjs'
import { backspaceProbe, testBackspace } from './pb-backspace-browser.mjs'
import { sample } from './srm-fixture.js'

const root = join(import.meta.dirname, '..'), shots = join(root, 'tmp/srm-designer')
const require = createRequire(join(root, '../workflow-studio/package.json'))
const { build } = require('esbuild'), { chromium } = require('playwright-core')
const profile = process.argv.includes('--profile'), backspace = process.argv.includes('--backspace')
const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true, format: 'iife', platform: 'browser',
  target: 'es2022', write: false, define: { 'process.env.NODE_ENV': '"production"' }, plugins: backspace ? [backspaceProbe] : profile ? [profilePaint] : [], nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' } })
const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
async function run() {
  const page = await browser.newPage({viewport:{width:1600,height:900}}), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('http://127.0.0.1/srm', route => route.fulfill({contentType:'text/html', body:'<!DOCTYPE html><html style="--dsh-windows-titlebar-height:40px"><style>body{margin:0}#root{width:100vw;height:100vh}</style><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></html>'}))
  await page.goto('http://127.0.0.1/srm')
  await page.evaluate(source => {
    localStorage.setItem('dsh.world.apps', '["vscode"]'); window.saved = source; window.version = '1'
    window.__worldDesktopCall = op => op === 'poll' ? new Promise(() => {}) : {}
    window.__worldBrainCall = () => ({sessionId:'session-1', setupRequired:false})
    window.__worldWorkspaceList = ({path}) => ({ok:true,value:{path,parent:'',entries:[{name:'m_test.SRM',type:'file'}]}})
    window.__worldSourceOpen = async ({path}) => ({ok:true,value:{path,source:window.saved,version:window.version,eol:'LF',encoding:'GBK',readOnly:false}})
    window.__worldSourceVersions = async ({paths}) => ({ok:true,value:{versions:paths.map(path => ({path,version:window.version}))}})
    window.__worldSourceSave = async ({path,source}) => { window.saved = source; window.version = '2'; return {ok:true,value:{path,source,version:'2'}} }
  }, sample)
  await page.addScriptTag({content:bundle.outputFiles[0].text}); await page.locator('[data-world-icon-id="vscode"]').dblclick()
  const editor = page.locator('.world-vscode-window'), group = editor.locator('.world-srw-panes')
  const btn = (scope,name) => scope.getByRole('button',{name,exact:true})
  await btn(editor,'最大化 Visual Studio Code').click()
  if (backspace) { await testBackspace(page,editor); assert.deepEqual(errors,[]); return }
  if (profile) {
    await mkdir(shots,{recursive:true}); await profileSelection(page, editor, shots)
    await page.evaluate(source => { window.saved = source }, sample)
  }
  await btn(editor,'m_test.SRM').dblclick()
  const tree = group.getByRole('region',{name:'菜单树'}), preview = group.getByRole('region',{name:'菜单预览'})
  const props = group.locator('[data-srw-view="properties"]'), layout = group.locator('.world-srm-layout')
  await btn(tree,'展开 Edit').click(); await btn(tree,'Help').click()
  await btn(preview,'Index').waitFor(); assert.match(await props.innerText(), /m_help/)
  const checkTabs = async () => { assert.equal(await group.getByRole('tab',{name:'Variables'}).count(),0); assert.equal(await group.getByRole('tab').count(),7) }
  await checkTabs()
  const [left,right,whole] = await Promise.all([tree,preview,layout].map(el => el.boundingBox()))
  assert.ok(Math.abs(left.width - whole.width * 339 / 1126) < 1); assert.ok(Math.abs(left.x+left.width-right.x) < 1)
  await mkdir(shots,{recursive:true}); await layout.screenshot({path:join(shots,'srm-layout.png')})
  await btn(preview,'Edit').click(); await btn(preview,'Color').click(); await btn(preview,'Blue & Green').click()
  assert.equal(await btn(tree,'Blue & Green').getAttribute('aria-pressed'),'true'); assert.match(await props.innerText(),/m_blue/)
  // A disclosure can remove and recreate a selected button without changing the object.
  await btn(tree,'折叠 Color').press('Enter'); assert.equal(await btn(tree,'Blue & Green').count(),0)
  await btn(tree,'展开 Color').press('Enter'); assert.equal(await btn(tree,'Blue & Green').getAttribute('aria-pressed'),'true')
  await btn(preview,'Color').click(); await btn(preview,'Color').click(); assert.equal(await btn(preview,'Blue & Green').count(),0)
  await btn(preview,'Color').press('Space'); await btn(preview,'Blue & Green').waitFor()
  await btn(preview,'Color').press('Escape'); assert.equal(await btn(tree,'m_test').getAttribute('aria-pressed'),'true')
  await btn(preview,'Edit').click()
  await btn(preview,'分隔线').waitFor(); await btn(tree,'Help').click(); await btn(preview,'Index').dblclick()
  const code = group.getByRole('textbox',{name:'编辑 m_index.clicked'}); await code.press('Control+End'); await page.keyboard.insertText(' // saved')
  await btn(editor,'保存').click(); assert.equal(await page.evaluate(() => window.saved), sample.replace('"Index")','"Index") // saved'))
  await btn(editor,'返回源码').click(); const source = editor.getByRole('textbox',{name:'编辑 m_test.SRM',exact:true})
  await source.fill((await source.inputValue()).replace('"&Help"','"帮助(&H)"')); await btn(editor,'设计视图').click()
  await editor.locator('[data-parent-tab]').click({button:'right'}); await editor.getByRole('menuitem',{name:'恢复默认布局'}).click()
  await btn(tree,'帮助(H)').click(); await btn(preview,'Index').waitFor(); await checkTabs(); assert.deepEqual(errors,[])
  console.log(`SRM layout ${whole.width}px = tree ${left.width}px + preview ${right.width}px. Screenshot: ${join(shots,'srm-layout.png')}`)
}
try { await run() } finally { await browser.close() }
