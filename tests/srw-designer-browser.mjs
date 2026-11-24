import { sample as menuSource } from './srm-fixture.js'
import { checkPainterGroupDrag } from './painter-group-drag.mjs'
import { card, layers, sruFiles } from './srw-fixture.js'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
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
const shots = join(root, 'tmp/srw-design')
mkdirSync(shots, { recursive: true })

const browser = await chromium.launch({ executablePath: browserPath, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent(html)
  const srus = { ...sruFiles }
  // Optional read-only copies exported from the reference PBL; no absolute machine path in CI.
  if (process.env.WORLD_SRU_FIXTURES) for (const name of ['sailjson.sru', 'uo_json_s.sru']) {
    srus[name] = readFileSync(join(process.env.WORLD_SRU_FIXTURES, name), 'utf8')
  }
  await page.evaluate(({source, layers, srus, menuSource}) => {
    const longHeader = '// row abcdefghijklmnopqrstuvwxyz0123456789\n'.repeat(25000)
    const files = {
      ...srus, 'w_dk.srw': source, 'w_edit.srw': source, 'w_layers.srw': layers, 'notes.txt': 'notes', 'slow.srw': source,
      'w_decl.srw': 'global type w_decl from window\ninteger width = 800\ninteger height = 600\nend type\nglobal variables\ninteger gi_count\nend variables\nshared variables\ninteger si_count\nend variables\ntype variables\ninteger ii_count\nend variables\ntype prototypes\nfunction long GetTickCount() library "kernel32.dll"\nglobal function ulong GlobalFn() library "user32.dll"\npublic function boolean LocalFn() library "user32.dll"\n' + Array.from({length: 2000}, (_,i) => `function long Local${i}() library "test.dll"`).join('\n') + '\nend prototypes\nevent open;\nreturn 1\nend event',
      'w_big.srw': 'global type w_big from window\ninteger width = 2000\ninteger height = 90000\nend type\nevent open;return 1\nend event\n' + Array.from({length:750}, (_,i) => `type cb_${i} from commandbutton within w_big\ninteger y = ${i*116}\ninteger height = 92\ninteger width = 457\nend type`).join('\n'),
      'W_LONG.SRW': 'global type w_long from window\nend type\nevent open;\n' + longHeader + ' '.repeat(12000) + 'MessageBox(42)\nend event',
      'long.js': 'hitHITHit\n' + longHeader + 'const last = 42',
      'w_drag.srw': source, 'uo_drag.sru': srus['uo_panel.SRU'],
      'm_test.srm': menuSource, 'd_test.srd': 'release 9; datawindow(units=0) detail(height=40)',
    }
    window.__worldSourceOpen = async ({path}) => {
      const name = path.split('/').pop()
      if (name === 'slow.srw') await new Promise(resolve => { window.finishSlow = resolve })
      return {ok:true,value:{path,source:files[name],version:'test',eol:'LF',encoding:name==='w_dk.srw'?'GBK':'UTF-8',readOnly:name==='w_dk.srw'}}
    }
    window.__worldWorkspaceList = async ({path}) => ({ok:true,value:{path,parent:'',entries:Object.keys(files).map(name=>({name,type:'file'}))}})
  }, { source: card, layers, srus, menuSource })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.getByRole('button', {name:'开始', exact:true}).click()
  await page.locator('[data-world-app-card="vscode"] .world-app-install').click()
  await page.locator('[data-world-app-card="vscode"] .world-app-open').click()
  const editor = page.locator('.world-vscode-window[data-world-vscode-key]')
  await checkPainterGroupDrag(page, editor, shots)
  const decl = editor.locator('.world-srw-panes'), declVars = decl.locator('[data-srw-view=variables]')
  const closeNotes = async () => {
    await editor.locator('.world-vscode-tab').filter({has:page.getByText('notes.txt',{exact:true})}).getByRole('button',{name:/关闭标签/}).click()
    await page.waitForTimeout(200)
  }
  // 设计组默认是预览标签：单击打开的被新文件替换，双击打开/双击父标签才定住
  await editor.getByRole('button',{name:'w_decl.srw', exact:true}).click()
  await decl.locator('[data-srw-view=layout]').waitFor()
  assert.match(await editor.locator('[data-parent-tab]').getAttribute('class'), /preview/, '单击打开的设计组应是预览态')
  await editor.getByRole('button',{name:'notes.txt', exact:true}).click()
  await page.waitForTimeout(400)
  assert.equal(await editor.locator('[data-parent-tab]').count(), 0, '预览设计组应被新打开的文件替换')
  await closeNotes()
  await editor.getByRole('button',{name:'w_decl.srw', exact:true}).dblclick()
  await decl.locator('[data-srw-view=layout]').waitFor()
  assert.match(await editor.locator('[data-parent-tab]').getAttribute('class'), /is-pinned/, '双击打开的设计组要定住')
  await editor.getByRole('button',{name:'notes.txt', exact:true}).click()
  await page.waitForTimeout(400)
  assert.equal(await editor.locator('[data-parent-tab]').count(), 1, '定住的设计组不被新文件替换')
  await closeNotes()
  await editor.locator('[data-parent-tab]').click()
  // Declare 面板的五类声明各占一页：切换分类能看到对应段，外部函数按 global 关键字分开
  const wrapButton = editor.locator('.world-vscode-status-wrap')
  assert.equal(await wrapButton.count(), 0, 'Layout has no code editor')
  await decl.getByRole('tab',{name:'Variables'}).click()
  await declVars.waitFor()
  assert.equal(await wrapButton.count(), 1, 'Variables should expose the source editor wrap toggle')
  assert.equal(await wrapButton.getAttribute('aria-pressed'), 'false')
  const instance = declVars.getByRole('textbox'), firstLine = instance.locator('.cm-line').first()
  const longLine = '// ' + '长行检查 '.repeat(100)
  await instance.press('Home'); await page.keyboard.insertText(longLine)
  const lineHeight = async () => (await firstLine.boundingBox()).height
  const oneRow = await lineHeight(), originalDraft = await instance.textContent()
  await wrapButton.click()
  assert.equal(await wrapButton.getAttribute('aria-pressed'), 'true')
  assert.ok(await lineHeight() >= oneRow * 2, 'one logical line must occupy multiple visual rows')
  assert.equal(await instance.textContent(), originalDraft)
  await editor.screenshot({path:join(shots,'srw-variables-word-wrap.png')})
  console.log('SRW Variables first-line height before/after wrap (px):', oneRow, await lineHeight())
  await instance.press('Alt+z'); assert.equal(await wrapButton.getAttribute('aria-pressed'), 'false')
  assert.equal(await lineHeight(), oneRow)
  await instance.press('Control+z'); assert.ok(await editor.getByRole('button',{name:'保存',exact:true}).isDisabled(), 'wrap must not reset undo or dirty the source')
  const checkExternalFill = async label => {
    const rect = await declVars.evaluate(pane => {
      const hint = pane.querySelector('.world-srw-declare-hint'), view = pane.getBoundingClientRect()
      const top = hint.getBoundingClientRect().bottom + parseFloat(getComputedStyle(hint).marginBottom)
      const code = pane.querySelector('.cm-scroller').getBoundingClientRect()
      return { available: view.bottom - top, editor: code.height, bottomGap: view.bottom - code.bottom }
    })
    assert.ok(rect.editor > 0 && Math.abs(rect.editor - rect.available) <= 1 && Math.abs(rect.bottomGap) <= 1, `${label}: ${JSON.stringify(rect)}`)
    console.log(label, rect)
  }
  // A loose object without an SRA cannot supply either application page.
  const missingApp = async () => {
    assert.match(await declVars.innerText(), /未找到对应的应用程序/)
    assert.equal(await declVars.locator('.cm-content').count(), 0)
  }
  for (const [label, text] of [['Global',null],['Shared','si_count'],['Instance','ii_count'],['Global External',null],['Local External','GetTickCount']]) {
    await declVars.getByRole('button',{name:label, exact:true}).click()
    if (!text) { await missingApp(); continue }
    assert.equal(await declVars.getByRole('textbox').count(), 1, `${label} is one editor`)
    await declVars.locator('.cm-lineNumbers .cm-gutterElement').filter({hasText:/^1$/}).last().waitFor()
    assert.match(await declVars.innerText(), new RegExp(text), `${label} 应显示 ${text}`)
    if (label.endsWith('External')) await checkExternalFill(`SRW ${label}`)
  }
  await declVars.screenshot({path:join(shots,'external-editor-fill.png')})
  const locals = declVars.getByRole('textbox'); await locals.press('Control+End')
  await declVars.locator('.cm-lineNumbers .cm-gutterElement').filter({hasText:/^2002$/}).waitFor()
  assert.ok(await declVars.locator('.cm-line').count() < 100, 'only viewport lines are mounted')
  await locals.press('Enter'); await page.keyboard.insertText('function long Extra() library "test.dll"')
  await declVars.locator('.cm-lineNumbers .cm-gutterElement').filter({hasText:/^2003$/}).waitFor()
  await declVars.getByRole('button',{name:'Global External',exact:true}).click()
  await missingApp()
  await declVars.getByRole('button',{name:'Local External',exact:true}).click()
  await locals.press('Control+End'); await locals.getByText('Extra',{exact:true}).waitFor()
  await locals.press('Shift+Home'); await locals.press('Backspace'); await locals.press('Backspace')
  assert.ok(await editor.getByRole('button',{name:'保存',exact:true}).isDisabled(), 'editing back to original is clean')
  await editor.locator('[data-parent-tab]').getByRole('button',{name:/关闭标签/}).click()
  await page.waitForTimeout(200)
  // 设计视图接管分组里最后一个文件时，分组本身要留下（空组能点开、能关掉），不能被直接拆掉
  await editor.getByRole('button',{name:'w_decl.srw', exact:true}).click()
  await editor.locator('.world-srw-panes').waitFor()
  await editor.locator('[data-parent-tab]').click({button:'right'})
  await editor.getByRole('menuitem',{name:'切换回源代码', exact:true}).click()
  await page.waitForTimeout(200)
  const declTab = () => editor.locator('.world-vscode-tab').filter({has:page.getByText('w_decl.srw',{exact:true})})
  await declTab().click({button:'right'})
  await editor.getByRole('menuitem',{name:'创建父标签组', exact:true}).click()
  const groupName = await editor.locator('[data-parent-tab] .world-vscode-tab-name').textContent()
  await declTab().click({button:'right'})
  await editor.getByRole('menuitem',{name:'打开设计视图', exact:true}).click()
  await editor.locator('.world-srw-panes').waitFor()
  const outerNames = () => editor.locator('.world-vscode-tabs').first().locator('.world-vscode-tab-name').allTextContents()
  assert.ok((await outerNames()).includes(groupName), `分组标签应保留：${JSON.stringify(await outerNames())}`)
  assert.ok((await outerNames()).includes('w_decl.srw · 设计'), '设计组应在外层打开')
  await editor.locator('.world-vscode-tab').filter({has:page.getByText(groupName,{exact:true})}).click()
  await editor.getByText('这个分组里没有标签了',{exact:true}).waitFor()
  await editor.getByRole('button',{name:'关闭分组', exact:true}).click()
  await page.waitForTimeout(200)
  assert.ok(!(await outerNames()).includes(groupName), '空组可以关掉')
  await editor.locator('[data-parent-tab]').getByRole('button',{name:/关闭标签/}).click()
  await page.waitForTimeout(200)
  await editor.getByRole('button',{name:'w_dk.srw', exact:true}).dblclick()
  const design = editor.getByRole('button',{name:'设计视图',exact:true}), grp = editor.locator('.world-srw-panes')
  const inner = name => grp.locator('.world-vscode-tab').filter({has:page.getByText(name,{exact:true})})
  const src = editor.locator('.world-vscode-tab').filter({has:page.getByText('w_dk.srw',{exact:true})})
  const parent = editor.locator('[data-parent-tab]')
  const canvas = grp.locator('[data-srw-view=layout]'), props = grp.locator('[data-srw-view=properties]')
  const cb = canvas.getByRole('button',{name:'cb_1',exact:true}); await cb.waitFor()
  assert.equal(await canvas.locator('[data-srw-object]').count(),9)
  assert.deepEqual(await grp.locator('.world-vscode-tab-name').allTextContents(),['Layout','open','Event List','Function List','Variables','Properties','Control List','Non-Visual Object List'])
  const geometry = await grp.evaluate(node => [...node.querySelectorAll('.world-vscode-pane')].map(p => {
    const {x,y,width,height}=p.getBoundingClientRect(),bar=p.querySelector('.world-vscode-tabs').getBoundingClientRect();return {x,y,width,height, stripBottom:bar.bottom,bottom:y+height}
  }))
  for (const pane of geometry) assert.equal(pane.stripBottom,pane.bottom)
  const panes = await grp.locator(':scope > .world-vscode-pane').evaluateAll(nodes => nodes.map(p => {
    const r = p.getBoundingClientRect(), strip = p.querySelector(':scope > .world-vscode-tabs').getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, stripRight: strip.right, stripHeight: strip.height,
      tabs: [...p.querySelectorAll('.world-vscode-tab')].map(t => { const b = t.getBoundingClientRect(); return { width: b.width, height: b.height, right: b.right, cls: t.className, selected: t.getAttribute('aria-selected') } }) }
  }))
  // 设计组标签是视图切换条：矮一档、同栏所有标签等宽，选中不改变宽度
  for (const pane of panes) {
    assert.equal(Math.round(pane.stripHeight), 28, `设计组标签栏 28px：${pane.stripHeight}`)
    const widths = pane.tabs.map(tab => Math.round(tab.width))
    assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `同栏标签等宽：${JSON.stringify(widths)}`)
    for (const tab of pane.tabs) assert.equal(Math.round(tab.height), 28)
  }
  // 80:20 会把属性栏压到 150px，标签栏只露出一个标签；默认比例要保住属性栏的可读宽度。
  assert.ok(panes[1].width >= 230, `属性栏至少 230px，实测 ${panes[1].width}`)
  for (const tab of panes[1].tabs) assert.ok(tab.right <= panes[1].stripRight + 1, `右栏标签必须落在标签栏里：${JSON.stringify(tab)}`)
  assert.equal(panes[1].tabs.filter(tab => tab.selected === 'true').length, 1, '每组只有一个 aria-selected')
  assert.match(panes[1].tabs[0].cls, /is-current/, '非活动组也要标出自己正在显示的标签')
  const box = await cb.boundingBox(); assert.deepEqual([box.width,box.height],[100,23]); assert.equal(await cb.textContent(),'none')
  await cb.click(); assert.ok((await props.innerText()).includes('cb_1'))
  // 多选：Ctrl+点击追加，工具栏给出选中数量与包围盒
  await canvas.locator('[data-srw-object="cb_2"]').click({modifiers: ['Control']})
  assert.equal(await canvas.locator('.world-srw-control.is-picked').count(), 1)
  assert.match(await canvas.locator('.world-srw-zoom').innerText(), /2 个 · 1197×92/)
  await canvas.locator('[data-srw-object="cb_3"]').click()
  assert.equal(await canvas.locator('.world-srw-control.is-picked').count(), 0, '普通点击退回单选')
  await cb.click()
  // 选中控件的 PB 尺寸显示在缩放条上
  assert.match(await canvas.locator('.world-srw-zoom').innerText(), /cb_1 457×92/)
  // 深色世界主题下属性值不能还是一张白纸
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
  await page.waitForFunction(() => document.body.dataset.worldTheme === 'dark')
  const darkFill = await props.evaluate(node => { const dd = node.querySelector('dd'); return dd ? getComputedStyle(dd).backgroundColor : '' })
  assert.notEqual(darkFill, 'rgb(255, 255, 255)', '深色主题下属性值底色应跟随窗口而不是 Canvas 白')
  await page.screenshot({ path: join(shots, 'layout-dark.png') })
  await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
  await page.waitForFunction(() => document.body.dataset.worldTheme === 'light')
  // 属性名与值并排：上下堆在 240px 的右栏里会把一屏挤成三四行一条
  const pair = await props.evaluate(node => {
    const dd = node.querySelector('dd'), dt = dd?.previousElementSibling
    if (!dd || !dt) return null
    const a = dt.getBoundingClientRect(), b = dd.getBoundingClientRect()
    return { dtTop: a.top, ddTop: b.top, dtRight: a.right, ddLeft: b.left }
  })
  assert.ok(pair && Math.abs(pair.dtTop - pair.ddTop) < 4 && pair.ddLeft > pair.dtRight, `属性应两列排：${JSON.stringify(pair)}`)
  // 属性按语义分段，能折叠：外观段折起后它的值是隐藏的
  const visualGroup = props.locator('details.world-srw-group').filter({hasText: '外观'})
  assert.ok(await visualGroup.count() >= 1, 'General 下应有语义分组')
  await visualGroup.first().locator('summary').click()
  assert.equal(await visualGroup.first().locator('dd').first().isVisible(), false, '折叠后属性值不可见')
  await visualGroup.first().locator('summary').click()
  // 方向键在控件之间移动选中；画布里只有一个 Tab 落点（roving tabindex）
  await cb.focus()
  assert.equal(await canvas.locator('[data-srw-object][tabindex="0"]').count(), 1)
  await page.keyboard.press('ArrowRight')
  assert.equal(await canvas.locator('[aria-pressed=true]').getAttribute('data-srw-object'), 'cb_2', '→ 到右边的按钮')
  await page.keyboard.press('ArrowDown')
  assert.equal(await canvas.locator('[aria-pressed=true]').getAttribute('data-srw-object'), 'cb_5', '↓ 到下面的按钮')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await canvas.locator('[aria-pressed=true]').getAttribute('data-srw-object'), 'cb_4', '← 回到左边')
  await cb.click()
  await page.screenshot({path:join(shots,'layout.png')})
  // 画布缩放：+ 号放大 10%，点百分比回到 100%
  const winBox = await canvas.locator('.world-srw-window').boundingBox()
  await grp.getByRole('button', {name: '放大画布', exact: true}).click()
  const zoomedBox = await canvas.locator('.world-srw-window').boundingBox()
  assert.ok(zoomedBox.width > winBox.width * 1.05, `放大后画布应变大：${winBox.width} → ${zoomedBox.width}`)
  await page.screenshot({path:join(shots,'zoom.png')})
  await grp.getByRole('button', {name: '110%', exact: true}).click()
  const backBox = await canvas.locator('.world-srw-window').boundingBox()
  assert.ok(Math.abs(backBox.width - winBox.width) <= 1, `点百分比应回到 100%：${backBox.width} vs ${winBox.width}`)
  await cb.dblclick(); const script = grp.locator('[data-srw-view=script]'); await script.waitFor()
  assert.match(await script.innerText(),/卡 1/); assert.equal(await script.locator('.cm-content').getAttribute('contenteditable'),'false', 'read-only provider stays read-only')
  const findScript = async (code, needle) => {
    await code.press('Control+f')
    const field = script.getByRole('textbox', {name:'查找', exact:true})
    await field.press('Control+a'); await field.pressSequentially(needle); await field.press('Enter')
    const match = script.locator('.cm-searchMatch-selected')
    await match.first().waitFor(); assert.equal((await match.allTextContents()).join(''), needle)
    await field.press('Escape'); assert.ok(await code.evaluate(n => n === document.activeElement))
    assert.equal(await field.count(), 0)
  }
  await findScript(script.locator('.cm-content'), '卡 1') // read-only scripts are searchable too
  await inner('Event List').click(); await grp.getByRole('button',{name:/w_dk · event open/}).click(); assert.match(await script.innerText(),/ibts\[i\].visible = false/)
  await script.getByTitle('折叠代码块').last().click(); await script.locator('.cm-foldPlaceholder').waitFor()
  await inner('Layout').click(); await inner('open').click(); await script.locator('.cm-foldPlaceholder').click()
  assert.match(await script.innerText(), /ibts\[i\].visible = false/)
  await inner('Event List').click()
  assert.equal(await grp.getByRole('button',{name:/w_dk · event open/}).getAttribute('aria-pressed'),'true','当前事件在列表里要有选中态')
  await page.screenshot({path:join(shots,'script.png')})
  await inner('Function List').click(); await grp.getByRole('button',{name:/wf_count/}).click(); assert.match(await script.innerText(),/return 9/)
  await inner('Variables').click(); assert.match(await grp.locator('[data-srw-view=variables]').innerText(),/commandbutton ibts/)
  await inner('Non-Visual Object List').click(); await grp.getByRole('button',{name:'ids : datastore'}).click()
  await inner('Properties').click(); assert.match(await props.innerText(),/datastore/)
  await inner('Layout').click(); await cb.click(); const pane=grp.locator('.world-vscode-pane').first(),r=await pane.boundingBox()
  await inner('clicked').dragTo(pane,{targetPosition:{x:r.width/2,y:r.height*.88}})
  assert.equal(await grp.locator('.world-vscode-pane').count(),3); assert.equal(await script.isVisible(),true)
  assert.equal(await src.count(),0, 'opening the design replaces the source tab')
  await editor.getByRole('button',{name:'notes.txt',exact:true}).dblclick(); assert.equal(await grp.count(),0)
  await parent.click(); await cb.waitFor(); assert.equal(await grp.locator('.world-vscode-pane').count(),3); assert.match(await props.innerText(),/cb_1/)
  // 分组结构也记住：关掉整个设计组再打开，仍是刚才拖出来的三个分栏
  await parent.getByRole('button',{name:/关闭标签/}).click()
  await editor.getByRole('button',{name:'w_dk.srw',exact:true}).click(); await cb.waitFor()
  assert.equal(await grp.locator('.world-vscode-pane').count(),3,'分组结构也要记住')
  const menuAction = async (target, name) => {
    await target.click({button:'right'}); const action = editor.getByRole('menuitem',{name,exact:true}); await action.waitFor()
    if(name === '切换回源代码') await editor.screenshot({path:join(shots,'design-context-menu.png')})
    await action.click()
  }
  // 设计组可以放到独立窗口：新窗口自己进设计视图，原窗口不受影响
  await menuAction(parent,'在新窗口打开')
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window[data-world-vscode-key]').length === 2, null, {timeout: 10000})
  await page.waitForFunction(() => document.querySelectorAll('.world-srw-panes').length === 2, null, {timeout: 15000})
  await page.screenshot({path:join(shots,'new-window.png')})
  const second = page.locator('.world-vscode-window[data-world-vscode-key]').nth(1)
  await second.getByRole('button', {name:'关闭 Visual Studio Code'}).click()
  await page.waitForFunction(() => document.querySelectorAll('.world-vscode-window[data-world-vscode-key]').length === 1, null, {timeout: 10000})
  await inner('Control List').getByRole('button',{name:/关闭标签/}).click(); assert.equal(await inner('Control List').count(),0)
  await menuAction(inner('Layout'),'恢复默认布局'); await cb.waitFor()
  assert.equal(await grp.locator('.world-vscode-pane').count(),2)
  // 重开设计组后脚本标签回落到第一个事件（open）；恢复默认布局把刚才关掉的 Control List 补回来
  assert.deepEqual(await grp.locator('.world-vscode-tab-name').allTextContents(),['Layout','open','Event List','Function List','Variables','Properties','Control List','Non-Visual Object List'])
  const close = () => parent.getByRole('button',{name:/关闭标签/}).click()
  const reopen = async () => { await editor.getByRole('button',{name:'w_dk.srw',exact:true}).click(); await inner('Layout').click(); await cb.waitFor() }
  await close(); const cdp = await page.context().newCDPSession(page), samples=[]
  for(let i=0;i<8;i++) {
    await reopen(); await cb.dblclick(); await script.locator('.world-vscode-tok-str').first().waitFor(); await close(); assert.equal(await editor.locator('[data-srw-view],[data-parent-tab]').count(),0)
    await cdp.send('HeapProfiler.collectGarbage'); samples.push(await cdp.send('Memory.getDOMCounters'))
  }
  // 单轮 GC 会随机把已脱管节点数到 672；取前三轮的最大值当基线，既不会误报也不放松泄漏检查。
  const base = samples.slice(0, 3).reduce((a, b) => ({ nodes: Math.max(a.nodes, b.nodes), jsEventListeners: Math.max(a.jsEventListeners, b.jsEventListeners) }))
  assert.ok(samples.at(-1).nodes <= base.nodes+20 && samples.at(-1).jsEventListeners <= base.jsEventListeners+5,JSON.stringify(samples))
  assert.equal(await page.evaluate(()=>window.__worldTesting.calls.filter(c=>c.method==='world-vscode-source/save').length),0)
  await editor.getByRole('button',{name:'w_edit.srw',exact:true}).dblclick()
  const draft = card.replace('请选择读卡内容', '未保存的标题'), edit = editor.getByRole('textbox',{name:'编辑 w_edit.srw',exact:true})
  await menuAction(parent,'切换回源代码'); await edit.fill(draft); await design.click(); await canvas.getByText('未保存的标题',{exact:true}).waitFor()
  // 分栏比例按文件记住：切回源码再打开，不重新读文件也保持
  const beforeWidth = (await grp.locator(':scope > .world-vscode-pane').first().boundingBox()).width
  await grp.getByRole('button', {name: '放大画布', exact: true}).click()
  await grp.getByRole('separator').press('ArrowLeft'); await grp.getByRole('separator').press('ArrowLeft')
  const narrowWidth = (await grp.locator(':scope > .world-vscode-pane').first().boundingBox()).width
  assert.ok(narrowWidth < beforeWidth - 20, `键盘应能改窄左栏：${beforeWidth} → ${narrowWidth}`)
  await menuAction(parent,'切换回源代码'); await edit.waitFor()
  await design.click(); await canvas.getByText('未保存的标题',{exact:true}).waitFor()
  const reopenedWidth = (await grp.locator(':scope > .world-vscode-pane').first().boundingBox()).width
  assert.ok(Math.abs(reopenedWidth - narrowWidth) <= 2, `设计组应记住分栏比例：${narrowWidth} → ${reopenedWidth}`)
  assert.match(await grp.locator('.world-srw-zoom').innerText(), /110%/, '缩放比例是全局偏好，重开也要记住')
  await grp.getByRole('button', {name: '110%', exact: true}).click()
  await menuAction(parent,'恢复默认布局'); await canvas.getByText('未保存的标题',{exact:true}).waitFor()
  const save = editor.getByRole('button',{name:'保存',exact:true}), back = editor.getByRole('button',{name:'返回源码',exact:true})
  assert.equal(await edit.count(),0); assert.ok(await save.isEnabled())
  await close(); await page.getByRole('button',{name:'取消',exact:true}).click(); await canvas.waitFor()
  await menuAction(parent,'切换回源代码'); assert.equal(await parent.count(),0); assert.equal(await edit.inputValue(),draft)
  await design.click(); await canvas.waitFor()
  await canvas.getByRole('button',{name:'cb_1',exact:true}).dblclick()
  const input = script.getByRole('textbox',{name:'编辑 cb_1.clicked',exact:true})
  const fill = async () => {
    const rects = await script.evaluate(node => { const v=node.getBoundingClientRect(), nav=node.querySelector('nav').getBoundingClientRect(), cm=node.querySelector('.cm-editor').getBoundingClientRect();return {pane:v.width, code:cm.width, remaining:v.bottom-nav.bottom, height:cm.height, top:cm.top-nav.bottom, bottom:v.bottom-cm.bottom} })
    for(const diff of [rects.top,rects.bottom,rects.pane-rects.code,rects.remaining-rects.height]) assert.ok(Math.abs(diff)<=1,JSON.stringify(rects)); return rects
  }
  await input.waitFor(); const eventFill=await fill(); assert.equal(await input.evaluate(node=>node===document.activeElement),true)
  assert.equal(await grp.getByRole('button',{name:/编辑代码|预览代码/}).count(),0)
  await input.locator('.world-vscode-tok-fn').filter({hasText:'MessageBox'}).waitFor()
  // Type immediately, without focusing/clicking an edit-mode button. Highlight is in the editable text itself.
  await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.insertText('/* 跨行\n仍是注释 */ return 42')
  await input.locator('.world-vscode-tok-cmt').filter({hasText:'仍是注释'}).waitFor()
  await input.locator('.world-vscode-tok-ctl').filter({hasText:'return'}).waitFor()
  const num=input.locator('.world-vscode-tok-num').filter({hasText:'42'}); await num.waitFor()
  assert.notEqual(await num.evaluate(n=>getComputedStyle(n).color),await input.evaluate(n=>getComputedStyle(n).color))
  await editor.screenshot({path:join(shots,'direct-edit.png')})
  await script.getByRole('textbox').fill('MessageBox("中文", "已修改")')
  await inner('Function List').click(); await grp.getByRole('button',{name:/wf_count/}).click()
  await grp.getByRole('separator').press('ArrowLeft'); const functionFill=await fill(); assert.ok(functionFill.code < eventFill.code)
  // 设计组的默认比例不是 50:50，双击分隔条要回到「按宽度算出来的默认值」
  await grp.getByRole('separator').dblclick()
  const restored = await grp.locator(':scope > .world-vscode-pane').first().boundingBox()
  assert.ok(Math.abs(restored.width - geometry[0].width) <= 8, `双击分隔条应回到默认比例：${restored.width} vs ${geometry[0].width}`)
  await script.getByRole('textbox').focus(); await script.getByRole('textbox').fill('return 10')
  await inner('Variables').click(); const vars=grp.locator('[data-srw-view=variables]')
  await vars.getByRole('textbox').fill('commandbutton ibts[]\ndatastore ids\nstring 新变量')
  await menuAction(parent,'恢复默认布局'); assert.ok(await save.isEnabled()); await inner('Variables').click()
  await vars.getByRole('textbox').locator('.world-vscode-tok-type').filter({hasText:'string'}).waitFor(); assert.match(await vars.getByRole('textbox').innerText(),/新变量/)
  const expected = draft.replace('MessageBox("读卡", "卡 1")','MessageBox("中文", "已修改")').replace('return 9','return 10').replace('datastore ids','datastore ids\nstring 新变量')
  // Delay a provider response while the same document receives another edit.
  await page.evaluate(() => { window.__worldSourceSave = payload => new Promise(resolve => { window.srwSent=payload; window.srwFinish=()=>resolve({ok:true,value:{source:payload.source,version:'v2',encoding:'UTF-8',eol:'LF'}}) }) })
  await vars.getByRole('textbox').press('Control+s'); await page.waitForFunction(()=>!!window.srwFinish)
  assert.equal(await page.evaluate(()=>window.srwSent.source),expected)
  await vars.getByRole('textbox').fill('commandbutton ibts[]\ndatastore ids\nstring more'); await page.evaluate(()=>window.srwFinish()); await page.waitForFunction(()=>!document.querySelector('button[title="保存 (Ctrl+S)"]')?.disabled)
  await page.evaluate(()=>{window.__worldSourceSave=async()=>({ok:false,error:{message:'版本冲突，未覆盖'}})})
  await save.click(); await editor.locator('.world-vscode-status-error').filter({hasText:'版本冲突，未覆盖'}).waitFor(); assert.ok(await save.isEnabled())
  await page.evaluate(()=>{window.__worldSourceSave=async payload=>{window.srwSent=payload;return {ok:true,value:{source:payload.source,version:'v3',encoding:'UTF-8',eol:'LF'}}}})
  await save.click(); await page.waitForFunction(()=>document.querySelector('button[title="保存 (Ctrl+S)"]')?.disabled)
  assert.equal(await page.evaluate(()=>window.srwSent.version),'v2'); await back.click(); assert.equal(await edit.inputValue(),expected.replace('新变量','more')); assert.equal(await save.isDisabled(),true)
  await editor.getByRole('button',{name:'w_big.srw',exact:true}).dblclick(); await canvas.locator('[data-srw-object="cb_0"]').waitFor()
  assert.ok(await canvas.locator('[data-srw-object]').count()<40)
  // 缩放后虚拟化仍按视口取景（缩放坐标要换算回 PB 坐标）
  await grp.getByRole('button',{name:'放大画布',exact:true}).click()
  assert.ok(await canvas.locator('[data-srw-object]').count()<60, '缩放后仍只挂视口内的控件')
  await grp.getByRole('button',{name:'110%',exact:true}).click()
  await canvas.evaluate(n=>{n.scrollTop=749*116/4}); await canvas.locator('[data-srw-object="cb_749"]').waitFor()
  // Remount the real canvas away from its origin: reuse the index, not the old viewport/DOM.
  const painted = () => canvas.locator('[data-srw-object]').evaluateAll(nodes => nodes.map(n => n.dataset.srwObject))
  const bottomIds = await painted()
  for (let i = 0; i < 3; i++) {
    await inner('open').click(); await script.getByRole('textbox', {name: '编辑 w_big.open'}).waitFor()
    assert.equal(await canvas.count(), 0)
    await inner('Layout').click(); await canvas.locator('[data-srw-object="cb_749"]').waitFor()
    assert.deepEqual(await painted(), bottomIds)
  }
  // Keep the native picker complete and in declaration order, including controls with no script.
  // A selection change in either pane must not replace option nodes or keep a stale value.
  await inner('open').click()
  const picker = script.getByRole('combobox', {name: '脚本对象'}), eventPicker = script.getByRole('combobox', {name: '事件或函数'})
  assert.deepEqual(await picker.evaluate(s => [...s.options].map(o => [o.value, o.text])),
    ['w_big', ...Array.from({length: 750}, (_, i) => `cb_${i}`)].map(id => [id, id]))
  const lastOption = await picker.locator('option').last().elementHandle()
  await picker.press('End'); assert.equal(await picker.inputValue(), 'cb_749')
  assert.equal(await eventPicker.locator('option').count(), 0); await script.getByText('此对象没有已实现的事件或函数。').waitFor()
  await picker.press('ArrowUp'); assert.equal(await picker.inputValue(), 'cb_748')
  await inner('Control List').click(); await grp.getByRole('button', {name: 'cb_749 : commandbutton', exact: true}).click()
  assert.equal(await picker.inputValue(), 'cb_749'); assert.ok(await picker.evaluate((s, last) => s.options[s.length - 1] === last, lastOption))
  await lastOption.dispose()
  await picker.press('Home'); await script.getByRole('textbox', {name: '编辑 w_big.open'}).waitFor()
  assert.equal(await picker.inputValue(), 'w_big'); assert.equal(await eventPicker.locator('option').count(), 1)
  await inner('Layout').click()
  await canvas.evaluate(n=>{n.scrollTop=749*116/4}); await canvas.locator('[data-srw-object="cb_749"]').waitFor()
  await canvas.locator('[data-srw-object="cb_749"]').click()
  await inner('Control List').click()
  // 选中的控件在第 8 页：进 Control List 直接翻到那一页，而不是永远停在第 1 页
  assert.match(await grp.locator('[data-srw-view=controls] nav').innerText(), /8\/8/)
  assert.equal(await grp.locator('.world-srw-row').count(), 51)
  // 滚动发生在 rAF 里：等目标行真正进入视口再量，别和测试的读取抢帧
  await page.waitForFunction(() => {
    const view = document.querySelector('[data-srw-view=controls]'), row = view?.querySelector('[aria-pressed="true"]')
    if (!view || !row) return false
    const v = view.getBoundingClientRect(), r = row.getBoundingClientRect()
    return r.top >= v.top - 1 && r.bottom <= v.bottom + 1
  }, null, {timeout: 4000})
  const lastRow = await grp.getByRole('button', {name: 'cb_749 : commandbutton', exact: true}).boundingBox()
  const listView = await grp.locator('[data-srw-view=controls]').boundingBox()
  assert.ok(lastRow && listView && lastRow.y >= listView.y - 1 && lastRow.y + lastRow.height <= listView.y + listView.height + 1,
    `选中行应滚进视口：${JSON.stringify({ lastRow, listView })}`)
  for (let i = 0; i < 7; i++) await grp.getByRole('button', {name: '上一页', exact: true}).click()
  // 选中视口外的控件（滚到底部后从 Control List 选第 2 个），切回画布应自动定位过去
  await grp.getByRole('button', {name: 'cb_1 : commandbutton', exact: true}).click()
  await inner('Layout').click()
  await page.waitForFunction(() => (document.querySelector('[data-srw-view=layout]')?.scrollTop ?? 1) < 300, null, {timeout: 4000})
  await close(); assert.equal(await editor.locator('[data-srw-view]').count(),0)
  await editor.getByRole('button', { name: 'w_layers.srw', exact: true }).dblclick()
  const control = id => canvas.locator(`[data-srw-object="${id}"]`)
  await control('st_5').waitFor()
  assert.equal(await control('dw_logon').count(), 0, 'a statically hidden DataWindow must not paint or intercept input')
  assert.equal(await control('dw_shown').isVisible(), true)
  for (const id of ['st_5', 'st_1', 'cb_exit']) {
    const target = control(id), b = await target.boundingBox()
    const center = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    assert.equal(await page.evaluate(({x, y}) => document.elementFromPoint(x, y)?.closest('[data-srw-object]')?.dataset.srwObject, center), id)
    if (id === 'cb_exit') assert.deepEqual([b.width, b.height], [59, 23])
    await page.mouse.click(center.x, center.y); assert.equal(await target.getAttribute('aria-pressed'), 'true')
  }
  await control('gb_1').click({position: {x: 3, y: 3}})
  assert.equal(await control('gb_1').getAttribute('aria-pressed'), 'true', 'exposed groupbox is still selectable')
  assert.equal(await control('gb_1').locator(':scope > span').textContent(), '账户信息', 'groupbox caption comes from text')
  assert.equal(await control('gb_1').evaluate(node => getComputedStyle(node).borderTopStyle), 'solid', 'a groupbox is a solid frame, not a dashed selection box')
  await inner('Control List').click(); await grp.getByRole('button', {name: 'dw_logon : datawindow', exact: true}).click()
  await inner('Properties').click(); assert.match(await props.innerText(), /dw_logon/)
  await close()
  // Both a previously unseen uppercase SRW and a normal large source colour EOF, including a long physical line.
  await editor.getByRole('button',{name:'W_LONG.SRW',exact:true}).click(); await inner('open').click()
  const longBody = script.getByRole('textbox'); await longBody.press('Control+End')
  await longBody.locator('.world-vscode-tok-num').filter({hasText:'42'}).waitFor()
  await page.keyboard.insertText(' // changed'); assert.ok(await save.isEnabled())
  await longBody.press('Control+z'); assert.ok(await save.isDisabled(), 'undo to the original long body clears dirty state')
  await editor.getByRole('button',{name:'W_LONG.SRW',exact:true}).click(); assert.equal(await parent.count(),1); assert.equal(await script.isVisible(),true)
  // Jump from a design tab into its large backing source without losing the unsaved event body.
  await longBody.press('Control+End'); await page.keyboard.insertText(' // keep-jump-draft')
  await findScript(longBody, 'keep-jump-draft')
  const scroller = script.locator('.cm-scroller')
  const topBefore = await scroller.evaluate(n => n.scrollTop); assert.ok(topBefore > 1000)
  await inner('Layout').click(); await inner('open').click()
  await longBody.locator('.cm-line').filter({hasText:'keep-jump-draft'}).waitFor()
  assert.ok(Math.abs((await scroller.evaluate(n => n.scrollTop)) - topBefore) < 2)
  assert.equal(await page.evaluate(() => getSelection().toString()), 'keep-jump-draft')
  await longBody.press('Control+p'); const jumpInput = editor.locator('.world-vscode-quickopen input')
  await jumpInput.fill(':25004:12001'); await jumpInput.press('Enter')
  const srwSource = editor.getByRole('textbox',{name:'编辑 W_LONG.SRW',exact:true}); await srwSource.waitFor()
  await editor.getByTitle('光标位置：行 25004, 列 12001', {exact:true}).waitFor()
  await srwSource.getByText('// keep-jump-draft', {exact:true}).waitFor(); assert.ok(await save.isEnabled())
  await editor.getByRole('button',{name:'long.js',exact:true}).click()
  const js = editor.getByRole('textbox',{name:'编辑 long.js',exact:true}); await js.press('Control+End'); await js.locator('.world-vscode-tok-num').filter({hasText:'42'}).waitFor()
  // Native textarea coverage lives in vscode-enhancements-browser. Check the same offset semantics
  // on a virtualized source: the first hit is zero, all three hits are adjacent and mixed case.
  await js.press('Control+Home'); await js.press('Control+h')
  const findBar = editor.getByRole('search', {name: '当前文件查找替换'}), query = findBar.getByRole('textbox', {name: '当前文件查找', exact: true})
  await query.fill('hit'); const count = findBar.getByRole('status')
  await count.filter({hasText:'1/3'}).waitFor()
  await query.press('Shift+Enter'); await count.filter({hasText:'3/3'}).waitFor()
  await query.press('Enter'); await count.filter({hasText:'1/3'}).waitFor()
  await findBar.getByRole('textbox', {name:'当前文件替换为'}).fill('😀$&')
  await findBar.getByRole('button', {name:'替换', exact:true}).click()
  assert.equal(await js.locator('.cm-line').first().textContent(), '😀$&HITHit')
  await findBar.getByRole('button', {name:'全部替换', exact:true}).click()
  assert.equal(await js.locator('.cm-line').first().textContent(), '😀$&😀$&😀$&')
  await count.filter({hasText:'无匹配'}).waitFor(); await query.press('Escape')
  await editor.getByRole('button',{name:'slow.srw',exact:true}).dblclick(); await page.waitForFunction(()=>!!window.finishSlow)
  await editor.getByRole('button',{name:'notes.txt',exact:true}).click(); await page.evaluate(()=>window.finishSlow()); await editor.getByRole('textbox',{name:'编辑 notes.txt'}).waitFor()
  assert.equal(await grp.count(),0,'a background SRW read cannot activate a design group over the current file')
  await editor.getByRole('button',{name:'slow.srw',exact:true}).click(); await cb.waitFor(); assert.equal(await parent.count(),1)
  // 窄窗口里左右两栏摆不下属性栏，默认布局改成上下分组
  await page.setViewportSize({ width: 1024, height: 768 })
  await menuAction(parent, '恢复默认布局'); await cb.waitFor()
  const stacked = await grp.locator(':scope > .world-vscode-pane').evaluateAll(nodes => nodes.map(p => {
    const r = p.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height }
  }))
  assert.equal(stacked.length, 2)
  assert.ok(stacked[1].top > stacked[0].top + 10, `窄窗口应上下分组：${JSON.stringify(stacked)}`)
  assert.ok(stacked[1].width >= 500, '上下分组时属性面板拿满宽度')
  await page.screenshot({ path: join(shots, 'stacked.png') })
  // 触屏没有右键：手机视图菜单里要能「恢复默认布局」
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForFunction(() => document.querySelector('.world-vscode-window')?.classList.contains('is-phone'))
  await editor.getByRole('button', {name: '视图菜单', exact: true}).click()
  const resetItem = editor.getByRole('menuitem', {name: '恢复默认布局', exact: true})
  await resetItem.click(); await cb.waitFor()
  assert.equal(await grp.locator(':scope > .world-vscode-pane').count(), 2, '手机菜单也能复位布局')
  await page.screenshot({ path: join(shots, 'phone-menu.png') })
  const keyboard = async overlap => {
    await page.evaluate(overlap => {
      if (overlap) Object.defineProperty(visualViewport, 'height', { configurable: true, value: innerHeight - overlap })
      else delete visualViewport.height
      visualViewport.dispatchEvent(new Event('resize'))
    }, overlap)
    await page.waitForFunction(open => document.body.classList.contains('has-keyboard') === open, Boolean(overlap))
  }
  const visiblePanes = grp.locator(':scope > .world-vscode-pane:visible')
  const sash = grp.getByRole('separator', { name: '调整分屏比例' })
  const paneShares = () => grp.evaluate(group => {
    const bounds = group.getBoundingClientRect()
    return Array.from(group.querySelectorAll(':scope > .world-vscode-pane'), pane => {
      const rect = pane.getBoundingClientRect()
      return [Math.round(100 * rect.width / bounds.width), Math.round(100 * rect.height / bounds.height)]
    })
  })
  const splitShares = await paneShares()
  await inner('open').click()
  const codeInput = grp.locator('.cm-content:visible').first()
  assert.equal(await wrapButton.getAttribute('aria-pressed'), 'true', 'phone scripts wrap by default')
  assert.ok(await codeInput.evaluate(n => n.classList.contains('cm-lineWrapping')))
  await codeInput.focus()
  await keyboard(280)
  assert.equal(await visiblePanes.count(), 1)
  assert.ok(await codeInput.isVisible())
  assert.deepEqual((await paneShares()).find(([width]) => width), [100, 100])
  assert.equal(await sash.isVisible(), false)
  await page.screenshot({ path: join(shots, 'phone-keyboard-edit.png') })
  await page.locator('.world-her-message.is-phone input').focus()
  assert.equal(await visiblePanes.count(), 2, '焦点移出设计组时不必等键盘收起')
  assert.ok(await sash.isVisible())
  assert.deepEqual(await paneShares(), splitShares)
  await page.screenshot({ path: join(shots, 'phone-keyboard-outside.png') })
  const propertyButton = props.getByRole('button').first()
  await propertyButton.focus()
  assert.equal(await visiblePanes.count(), 1)
  assert.ok(await propertyButton.isVisible())
  await keyboard(0)
  assert.equal(await visiblePanes.count(), 2)
  assert.deepEqual(await paneShares(), splitShares)
  assert.ok(await sash.isVisible())
  console.log('手机设计器：编辑 → 组外输入 → 属性栏 → 收键盘；可见栏数 1/2/1/2，原分栏占比', splitShares)
  await page.setViewportSize({ width: 1628, height: 920 }); await close()
  await editor.getByRole('button', {name: 'uo_panel.SRU', exact: true}).click()
  const apply = canvas.getByRole('button', {name: 'cb_apply', exact: true}); await apply.waitFor()
  assert.equal(await apply.textContent(), '应用'); assert.equal(await inner('Control List').count(), 1)
  await editor.screenshot({path: join(shots, 'sru-layout.png')}); await close()
  await editor.getByRole('button', {name: 'sailjson.sru', exact: true}).click()
  const selector = script.getByLabel('事件或函数'), addItem = /function sailjson addarrayitem/i
  await selector.waitFor(); const option = selector.locator('option').filter({hasText: addItem})
  await selector.selectOption(await option.getAttribute('value'))
  const labels = ['addarrayitem','Event List','Function List','Variables','Properties','Non-Visual Object List']
  assert.deepEqual(await grp.locator('.world-vscode-tab-name').allTextContents(), labels)
  const signature = srus['sailjson.sru'].match(/^\s*(public\s+function\s+sailjson\s+addarrayitem\s*\([^\r\n;]*\)[^\r\n;]*)\s*;/im)[1].trim()
  assert.equal(await selector.locator('option:checked').textContent(), signature)
  assert.equal(await selector.getAttribute('title'), signature)
  assert.equal(await script.locator('input[readonly]').count(), 0)
  assert.equal(await props.getByText('hjson', {exact: true}).locator('+ dd').textContent(), '0')
  const body = script.getByLabel('编辑 sailjson.addarrayitem'); await body.waitFor()
  await findScript(body, 'return'); await editor.screenshot({path: join(shots, 'sru-script.png')})
  await body.press('Alt+z'); assert.equal(await wrapButton.getAttribute('aria-pressed'), 'true')
  assert.ok(await body.evaluate(n => n.classList.contains('cm-lineWrapping')))
  assert.ok(await save.isDisabled(), 'toggling wrap alone is not an edit')
  await script.locator('.cm-lineNumbers .cm-gutterElement').filter({hasText:/^1$/}).last().waitFor()
  await inner('Variables').click()
  for (const name of ['Global', 'Shared', 'Instance', 'Global External', 'Local External']) {
    await declVars.getByRole('button', {name, exact:true}).click()
    if (name === 'Global' || name === 'Global External') { await missingApp(); continue }
    assert.equal(await declVars.locator('.cm-content[contenteditable=true]').count(), 1)
    if (name.endsWith('External')) await checkExternalFill(`SRU ${name}`)
    await declVars.locator('.cm-lineNumbers .cm-gutterElement').filter({hasText:/^1$/}).last().waitFor()
  }
  assert.ok(await declVars.getByRole('textbox').evaluate(n => n.classList.contains('cm-lineWrapping')), 'new declaration editors inherit wrap')
  await wrapButton.click()
  await declVars.getByRole('textbox').fill('function long Added() library "test.dll"')
  await inner('addarrayitem').click()
  await body.fill('return this // updated')
  await inner('Event List').click(); await grp.getByRole('button', {name: /on sailjson.create/i}).click()
  assert.equal(await script.getByLabel('脚本类别').inputValue(), 'events')
  assert.match(await selector.locator('option:checked').textContent(), /^on sailjson\.create$/i)
  assert.equal(await script.locator('input[readonly]').count(), 0)
  await inner('Function List').click(); await grp.getByRole('button', {name: addItem}).click()
  assert.equal(await body.innerText(), 'return this // updated')
  await menuAction(parent, '恢复默认布局'); assert.deepEqual(await grp.locator('.world-vscode-tab-name').allTextContents(), labels)
  await save.click(); await page.waitForFunction(() => window.srwSent?.path.endsWith('sailjson.sru'))
  await back.click(); const sourceBox = editor.getByRole('textbox', {name: '编辑 sailjson.sru'})
  assert.match(await sourceBox.inputValue(), /type prototypes\nfunction long Added\(\) library "test.dll"\nend prototypes/)
  assert.match(await sourceBox.inputValue(), /return this \/\/ updated/)
  await sourceBox.fill(sruFiles['uo_panel.SRU']); await design.click(); await apply.waitFor()
  assert.equal(await inner('Control List').count(), 1, 'changing the base in source must not restore the nonvisual preset')
  assert.deepEqual(errors,[]);console.log(JSON.stringify({geometry,box,eventFill,functionFill,samples,stacked,shots})); await cdp.detach()
} finally { await browser.close() }
