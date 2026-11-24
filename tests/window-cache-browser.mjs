import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {join} from 'node:path'

const root = join(import.meta.dirname,'..'), require = createRequire(join(root,'../workflow-studio/package.json'))
const {build} = require('esbuild'), {chromium} = require('playwright-core')
const bundle = await build({absWorkingDir:root,entryPoints:['tests/browser-entry.js'],bundle:true,write:false,format:'iife',target:'es2022',
  loader:{'.css':'text'},nodePaths:[join(root,'../workflow-studio/node_modules')]})
const browser = await chromium.launch({executablePath:process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true})
try {
  const page=await browser.newPage({viewport:{width:1440,height:950}}), errors=[]
  page.setDefaultTimeout(6000); page.on('pageerror',e=>errors.push(e.message))
  await page.route('http://127.0.0.1/cache',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><style>#root{width:100vw;height:100vh}</style><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div>'}))
  await page.addInitScript(()=>{
    localStorage.setItem('dsh.world.apps','["vscode","terminal"]')
    const files={'a.txt':'','b.txt':'','c.txt':'','view.srw':'window','other.srw':'window','util.sru':'nonvisualobject','demo.sra':'application'}
    window.__worldWorkspaceList=({path})=>({ok:true,value:{path,parent:'',entries:Object.keys(files).map(name=>({type:'file',name}))}})
    window.__worldSourceOpen=async({path})=>{const file=path.split('/').pop(), name=file.split('.')[0];if(file.endsWith('.txt')) return file===localStorage.getItem('missing') ? {ok:false,error:{message:'file not found'}}
      : {ok:true,value:{path,source:`${path}:disk-${localStorage.getItem('revision') || 1}`,version:'1',encoding:'UTF-8',eol:'LF'}}
      return {ok:true,value:{path,source:`global type ${name} from ${files[file]}\nend type\nevent open;\nreturn\nend event`,version:'1',encoding:'UTF-8',eol:'LF'}}}
  })
  const load=async()=>{await page.goto('http://127.0.0.1/cache');await page.addScriptTag({content:bundle.outputFiles[0].text})}
  const icon=id=>page.locator(`[data-world-icon-id="${id}"]`), task=id=>page.locator(`[data-world-taskbar="${id}"]`)
  const editor=page.locator('[data-world-vscode-key="win1"]'), panes=editor.locator('.world-srw-panes')
  const open=name=>editor.getByRole('button',{name,exact:true}).click(), tab=name=>panes.locator('.world-vscode-tab').filter({has:page.getByText(name,{exact:true})})
  const visible=view=>panes.locator(`[data-srw-view="${view}"]`).waitFor()
  const ratio=async()=>{const a=await panes.locator('.world-vscode-pane').first().boundingBox(),b=await panes.boundingBox();return a.width/b.width}
  await load(); await icon('vscode').dblclick()
  await open('view.srw');await visible('layout'); await panes.getByRole('separator').press('ArrowLeft');const split=await ratio()
  await tab('Properties').click(); await tab('Variables').click(); await visible('variables')
  await open('other.srw');await visible('layout');await tab('Event List').click()
  await open('util.sru');await visible('script');await tab('Function List').click()
  await open('demo.sra');await visible('script');await tab('Non-Visual Object List').click();await visible('nonvisual')
  await editor.getByRole('button',{name:/钉住/}).click()
  await editor.getByRole('button',{name:'最小化 Visual Studio Code'}).click()
  await icon('terminal').dblclick();const term=page.locator('.world-terminal-window');await term.getByRole('button',{name:'最大化',exact:true}).click()
  await load();await term.waitFor();assert.match(await term.getAttribute('class'),/is-max/)
  assert.match(await task('terminal').getAttribute('class'),/\bon\b/);assert.match(await task('vscode:win1').getAttribute('class'),/is-min/)
  await term.getByRole('button',{name:'关闭',exact:true}).click();await task('vscode:win1').click()
  assert.equal(await editor.locator('.world-pin-cap').getAttribute('aria-pressed'),'true');await visible('nonvisual') // active painter restored without clicking the file
  await open('view.srw');await visible('variables');assert.ok(Math.abs(split-await ratio())<.005)
  await open('other.srw');await visible('events');await open('util.sru');await visible('functions');await open('demo.sra');await visible('nonvisual')
  assert.equal(await panes.locator('.world-vscode-tab.active').innerText().then(s=>s.includes('Non-Visual Object List')),true)
  const shots=join(root,'tmp/srw-design');await mkdir(shots,{recursive:true});await editor.screenshot({path:join(shots,'cache-restore.png')})
  // Dock a terminal, reload the actual page and verify it did not reopen as a separate taskbar window.
  await editor.locator('.world-pin-cap').click(); await icon('terminal').dblclick()
  const title=term.locator('.world-vscode-titlebar'); await title.evaluate(n=>n.closest('section').getAnimations().forEach(a=>a.finish()))
  const src=await title.boundingBox(), dest=await editor.locator('.world-vscode-tabs').first().boundingBox()
  await page.mouse.move(src.x+100,src.y+src.height/2);await page.mouse.down();await page.mouse.move(dest.x+dest.width/2,dest.y+dest.height/2,{steps:15});await page.mouse.up()
  await editor.locator('.world-terminal-window').waitFor();await load();await editor.locator('.world-terminal-window').waitFor();assert.equal(await task('terminal').count(),0)
  await editor.getByRole('button',{name:'关闭标签 终端',exact:true}).click();await term.getByRole('button',{name:'关闭',exact:true}).click()
  await editor.getByRole('button',{name:'关闭 Visual Studio Code'}).click();await load();await icon('vscode').waitFor();assert.equal(await task('terminal').count()+await task('vscode:win1').count(),0)
  // No geometry/focus change to incidentally dirty the desktop after the initial write.
  await icon('vscode').dblclick(); await page.waitForTimeout(500)
  for (const name of ['a.txt','b.txt']) await editor.getByRole('button',{name,exact:true}).dblclick()
  const cacheKey = ['dsh.world','desktop-session','v1'].join('.')
  await page.waitForFunction(k => JSON.parse(localStorage.getItem(k)).windows.some(w=>w.fileSession?.files.length===2),cacheKey)
  await load(); await editor.getByRole('textbox',{name:'编辑 b.txt'}).waitFor()
  await editor.getByRole('button',{name:'关闭标签 b.txt',exact:true}).click()
  await load(); await editor.getByRole('textbox',{name:'编辑 a.txt'}).waitFor()
  assert.equal(await editor.getByRole('tab',{name:'b.txt'}).count(),0)
  await editor.getByRole('button',{name:'关闭 Visual Studio Code'}).click();await load()
  // Two independent editor sessions. A dragged order differs from creation order; a dirty
  // source must come from disk after reload, even when a second window was foreground.
  await icon('vscode').dblclick()
  const file = (win, name) => win.getByRole('button',{name,exact:true})
  const fileTab = (win, name) => win.locator('.world-vscode-tab').filter({has:page.getByText(name,{exact:true})})
  const text = (win, name) => win.getByRole('textbox',{name:`编辑 ${name}`,exact:true})
  const order = win => win.locator('.world-vscode-tabs .world-vscode-tab-name').allTextContents()
  for (const name of ['a.txt','b.txt','c.txt']) await file(editor,name).dblclick()
  await fileTab(editor,'c.txt').dragTo(fileTab(editor,'a.txt'),{targetPosition:{x:5,y:15}})
  await fileTab(editor,'a.txt').click();await text(editor,'a.txt').fill('private unsaved draft')
  assert.deepEqual(await order(editor),['c.txt','a.txt','b.txt'])
  await editor.locator('.world-vscode-title-btn[aria-label="打开文件夹"]').click()
  const picker=editor.locator('.world-vscode-picker');await picker.locator('input').fill('/other');await picker.locator('input').press('Enter')
  await picker.getByRole('button',{name:'在新窗口打开',exact:true}).click()
  const other=page.locator('[data-world-vscode-key="win2"]')
  await file(other,'a.txt').dblclick();await file(other,'b.txt').dblclick()
  await other.getByRole('button',{name:'关闭标签 a.txt',exact:true}).click()
  const key=['dsh.world','desktop-session','v1'].join('.')
  await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key))?.windows.some(w=>w.id==='vscode:win2' && w.fileSession?.files.length===1 && w.fileSession.active==='/other/b.txt'),key)
  const cache=await page.evaluate(key=>localStorage.getItem(key),key)
  assert.ok(!cache.includes('private unsaved draft') && !cache.includes(':disk-'))
  await page.evaluate(()=>localStorage.setItem('revision','2'));await load()
  await text(other,'b.txt').waitFor();assert.equal(await text(other,'b.txt').inputValue(),'/other/b.txt:disk-2')
  assert.deepEqual(await order(other),['b.txt'])
  assert.deepEqual(await order(editor),['c.txt','a.txt','b.txt'])
  assert.equal(await text(editor,'a.txt').inputValue(),'/workspace/a.txt:disk-2')
  // Closing the second window is final. If the selected file has since disappeared,
  // the remaining tabs keep their order and one of them becomes the active editor.
  await other.getByRole('button',{name:'关闭 Visual Studio Code'}).click()
  await page.evaluate(()=>localStorage.setItem('missing','a.txt'));await load()
  await fileTab(editor,'a.txt').waitFor({state:'detached'});await text(editor,'c.txt').or(text(editor,'b.txt')).waitFor()
  assert.deepEqual(await order(editor),['c.txt','b.txt']);assert.equal(await other.count(),0)
  console.log('Two editors restored independently: dragged order and active file preserved, fresh disk text, no draft or closed tabs; missing active file skipped.')
  assert.deepEqual(errors,[]);console.log('Reload restored per-file SRW/SRU/SRA views, split ratio',split.toFixed(3),'and the pinned/minimized editor and maximized foreground terminal; closed windows stayed closed.')
} finally {await browser.close()}
