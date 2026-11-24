import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {join} from 'node:path'

const root = join(import.meta.dirname,'..'), shots = join(root,'tmp/srw-design')
const require = createRequire(join(root,'../workflow-studio/package.json'))
const {build} = require('esbuild'), {chromium} = require('playwright-core')
const bundle = await build({absWorkingDir:root, entryPoints:['tests/browser-entry.js'],bundle:true,write:false,target:'es2022',
  format:'iife', platform:'browser', define:{'process.env.NODE_ENV':'"production"'}, loader:{'.css':'text'}, nodePaths:[join(root,'../workflow-studio/node_modules')]})
const browser = await chromium.launch({executablePath:process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless:true})
try {
  const page = await browser.newPage({viewport:{width:1440,height:950}}), errors=[]
  page.on('pageerror', e=>errors.push(e.message)); page.setDefaultTimeout(6000)
  await page.route('http://127.0.0.1/complete',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html style="--dsh-windows-titlebar-height:40px"><style>body{margin:0}#root{width:100vw;height:100vh}</style><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></html>'}))
  await page.goto('http://127.0.0.1/complete')
  await page.evaluate(()=>{
    localStorage.setItem('dsh.world.apps','["vscode"]')
    window.__worldDesktopCall=op=>op==='poll'?new Promise(()=>{}):{}
    window.__worldBrainCall=()=>({sessionId:'session-1',setupRequired:false})
    const files = {'n_test.sru':'global type n_test from nonvisualobject\nend type\ntype variables\nstring is_label\ndatawindow idw_detail\nend variables\npublic function string of_run (string as_name, ref datawindow adw);return as_name\nend function\npublic function integer of_total ();return 1\nend function',
      'w_test.srw':'global type w_test from window\nevent ue_validate ( )\ninteger width = 400\nend type\nevent open;return\nend event'}
    files['demo.sra']='global type demo from application\nend type\nevent open;\nreturn\nend event'
    files['w_read.srw']=files['w_test.srw'].replaceAll('w_test','w_read')
    window.__worldWorkspaceList=({path})=>({ok:true,value:{path,parent:'',entries:Object.keys(files).map(name=>({name,type:'file'}))}})
    window.__worldSourceOpen=async({path})=>({ok:true,value:{path,source:files[path.split('/').pop()],version:'1',encoding:'UTF-8',eol:'LF',readOnly:path.endsWith('w_read.srw')}})
  })
  await page.addScriptTag({content:bundle.outputFiles[0].text}); await page.locator('[data-world-icon-id="vscode"]').dblclick()
  const editor=page.locator('.world-vscode-window'), script=editor.locator('[data-srw-view=script]:visible'), body=script.locator('.cm-content')
  const list=editor.getByRole('listbox',{name:'代码提示'}), selected=list.locator('.cm-completionLabel')
  const tab=name=>editor.locator('.world-srw-panes:visible .world-vscode-tab').filter({has:page.getByText(name,{exact:true})})
  const open=async name=>await editor.getByRole('button',{name,exact:true}).dblclick()
  const replace=async text=>{await body.focus(); await body.press('Control+a'); await page.keyboard.insertText(text)}
  await open('n_test.sru')
  // A real Ctrl+Space on a blank body, then the physical Space key as reported by Windows IMEs.
  await body.press('Control+a'); await body.press('Backspace'); await body.press('Control+Space'); await list.waitFor()
  await body.press('Escape'); await list.waitFor({state:'hidden'})
  await body.dispatchEvent('keydown',{code:'Space',key:'Process',keyCode:229,ctrlKey:true,bubbles:true,cancelable:true})
  await list.waitFor(); await body.press('Escape'); await list.waitFor({state:'hidden'})
  await body.press('Alt+/'); await list.waitFor(); await body.press('Escape'); assert.equal((await body.innerText()).trim(),'')
  await replace('Mess'); await list.waitFor(); assert.deepEqual(await selected.allTextContents(),['MessageBox'])
  // Do not catch Enter during CodeMirror's short initial interaction guard.
  await page.waitForTimeout(100); await body.press('Enter'); assert.equal(await body.innerText(),'MessageBox')
  await body.press('Control+z'); assert.equal(await body.innerText(),'Mess')
  await replace('this.'); await list.waitFor(); assert.ok((await selected.allTextContents()).includes('of_total'))
  assert.ok(!(await selected.allTextContents()).includes('MessageBox')); await mkdir(shots,{recursive:true}); await editor.screenshot({path:join(shots,'srw-script-completion.png')})
  await body.press('Escape'); await list.waitFor({state:'hidden'}); assert.equal(await body.innerText(),'this.')
  await body.press('Control+Space'); await list.waitFor(); await page.waitForTimeout(100); await body.press('ArrowDown')
  const chosen=await list.locator('[aria-selected=true] .cm-completionLabel').innerText(); await body.press('Enter'); assert.equal(await body.innerText(),'this.'+chosen)
  await replace('string ls_customer\nls_c'); await list.waitFor()
  assert.deepEqual(await selected.allTextContents(),['ls_customer']); await list.getByRole('option').click(); assert.match(await body.innerText(),/\nls_customer$/)
  await replace('datawindow ldw_detail\nldw_detail'); await page.keyboard.type('.geti')
  const getString=list.getByText('getitemstring',{exact:true}); await getString.waitFor()
  await editor.screenshot({path:join(shots,'script-local-datawindow.png')}); await getString.click()
  assert.equal(await body.innerText(),'datawindow ldw_detail\nldw_detail.getitemstring')
  await replace('adw'); await page.keyboard.type('.geti'); await getString.waitFor()
  await editor.screenshot({path:join(shots,'script-parameter-datawindow.png')}); await getString.click()
  assert.equal(await body.innerText(),'adw.getitemstring')
  await replace('idw_detail'); await page.keyboard.type('.geti'); await getString.waitFor()
  await editor.screenshot({path:join(shots,'script-instance-datawindow.png')}); await getString.click()
  assert.equal(await body.innerText(),'idw_detail.getitemstring')
  await replace('MessBox'); await body.press('ArrowLeft'); await body.press('ArrowLeft'); await body.press('ArrowLeft'); await body.press('Control+Space')
  await list.waitFor(); await list.getByRole('option').filter({hasText:'MessageBox'}).click(); assert.equal(await body.innerText(),'MessageBox')
  await replace('Mess'); await list.waitFor(); await body.press('Tab'); assert.doesNotMatch(await body.innerText(),/MessageBox/)
  await replace('Mess'); await list.waitFor(); await body.dispatchEvent('compositionstart'); await list.waitFor({state:'hidden'})
  await body.press('Control+Space'); await page.waitForTimeout(200); assert.equal(await list.count(),0); await body.dispatchEvent('compositionend')
  await replace('ret'); await list.waitFor(); await page.keyboard.type('urn'); await list.waitFor({state:'hidden'})
  await body.press('Enter'); assert.equal(await body.locator('.cm-line').count(),2)
  await replace('// Mess'); await body.press('Control+Space'); await page.waitForTimeout(200); assert.equal(await list.count(),0)
  await tab('Variables').click()
  const vars=editor.locator('[data-srw-view=variables] .cm-content'); await vars.focus(); await vars.press('Control+End'); await vars.press('Control+Space')
  await page.waitForTimeout(200); assert.equal(await list.count(),0)
  // The active Variables draft is visible to the script without saving or reopening.
  await vars.fill('window idw_detail'); await tab('of_run').click(); await replace('idw_detail.arranges')
  await list.getByText('arrangesheets',{exact:true}).click(); assert.equal(await body.innerText(),'idw_detail.arrangesheets')
  await open('w_test.srw'); await tab('open').click(); await replace('this.wi')
  await list.waitFor(); assert.ok((await selected.allTextContents()).includes('width')); await body.press('Escape')
  // Reproduce a popup crossing into Properties: height is short enough that the
  // dropdown overlays a sibling pane. Hit tests must belong to a suggestion, not a tab.
  const panes=editor.locator('.world-srw-panes:visible'), sash=panes.getByRole('separator').first()
  await page.setViewportSize({width:950,height:800})
  await editor.locator('[data-parent-tab].active').click({button:'right'}); await editor.getByRole('menuitem',{name:'恢复默认布局'}).click()
  await tab('open').click(); await replace('this.'); await list.waitFor(); await body.press('Escape')
  assert.equal(await sash.getAttribute('aria-orientation'),'horizontal')
  const bar=await sash.boundingBox(), rect=await panes.boundingBox(); await page.mouse.move(bar.x+bar.width/2,bar.y+bar.height/2); await page.mouse.down(); await page.mouse.move(bar.x+bar.width/2,rect.y+rect.height*.32,{steps:4}); await page.mouse.up()
  await replace('// test scope\n// window members\n// picker above properties\nthis.'); await list.waitFor()
  let hit
  for (const [theme,color,bg] of [['dark','white','rgb(37, 37, 38)'],['light','black','rgb(255, 255, 255)']]) {
    await page.evaluate(t=>{document.body.dataset.worldTheme=t},theme)
    const actual=await body.evaluate(async el=>{
      const cursor=getComputedStyle(el.querySelector('.cm-line')).cursor, url=/url\("([^"]+)"\)/.exec(cursor)?.[1]
      if (!url) return {cursor}
      const img=new Image(); img.src=url; await img.decode()
      const c=document.createElement('canvas'); c.width=img.width; c.height=img.height
      const ctx=c.getContext('2d'); ctx.drawImage(img,0,0); return {cursor,pixel:[...ctx.getImageData(16,16,1,1).data]}
    })
    assert.deepEqual(actual.pixel,color==='white'?[255,255,255,255]:[0,0,0,255],actual.cursor)
    assert.equal(await list.evaluate(el=>getComputedStyle(el).backgroundColor),bg)
    const overlap=await list.evaluate(el=>{
      const p=el.closest('.world-srw-panes').querySelector('[data-srw-view="properties"]').getBoundingClientRect(), b=el.getBoundingClientRect()
      const x=Math.max(b.left,p.left)+10,y=Math.max(b.top,p.top)+10
      const li=document.elementFromPoint(x,y)?.closest('li')
      return {x,y,label:li?.querySelector('.cm-completionLabel')?.textContent,height: Math.min(b.bottom,p.bottom)-Math.max(b.top,p.top), topmost:el.contains(document.elementFromPoint(x,y)) }
    }); assert.ok(overlap.height>10 && overlap.topmost,JSON.stringify(overlap))
    hit=overlap
    console.log('Script popup / cursor:',theme,bg,actual.pixel,'overlap',overlap.height)
    await editor.screenshot({path:join(shots,`script-popup-${theme}.png`)})
  }
  assert.ok(hit.label); await page.mouse.click(hit.x,hit.y); assert.ok((await body.innerText()).endsWith('this.'+hit.label))
  await open('demo.sra'); await replace('m'); await body.press('Control+Space'); await list.waitFor()
  assert.ok((await selected.allTextContents()).includes('MessageBox')); await body.press('Escape')
  await open('w_read.srw'); await tab('open').click(); await body.press('Control+Space'); await page.waitForTimeout(200)
  assert.equal(await list.count(),0); assert.deepEqual(errors,[]); console.log('Script completion: SRU/SRW, keyboard, click, comment, undo, Variables and read-only verified.')
} finally {await browser.close()}
