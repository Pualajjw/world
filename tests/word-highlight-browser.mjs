import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(resolve(root, '../workflow-studio/package.json'))
const { build } = require('esbuild'), { chromium } = require('playwright-core')
const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser-entry.js'], bundle: true, format: 'iife',
  platform: 'browser', target: 'es2022', write: false, define: { 'process.env.NODE_ENV': '"production"' },
  nodePaths: [resolve(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' } })
const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
const errors = [], out = resolve(root,'tmp/word-highlight'), total = 100000
try {
  await mkdir(out, {recursive:true})
  const page = await browser.newPage({viewport:{width:1440,height:960}})
  page.on('pageerror', e => { console.error(e); errors.push(e.message) })
  await page.route('http://127.0.0.1/click-word', r => r.fulfill({contentType:'text/html',body:'<!doctype html><style>body{margin:0}#root,.app-frame{height:100vh}</style><div id="root"><div class="app-frame"><main></main><div data-shell-overlay id="overlay-root"></div></div></div>'}))
  await page.goto('http://127.0.0.1/click-word')
  await page.evaluate(total => {
    localStorage.setItem('dsh.world.apps','["vscode"]')
    window.__worldDesktopCall = op => op === 'poll' ? new Promise(() => {}) : {}
    const files = {'demo.js':'let count = count + counter + COUNT; // count', 'notes.txt':'count count 计数 计数 count2',
      'long.js': Array.from({length:total}, (_,i)=>`count = count + counter; // row ${i}`).join('\n'),
      'n_test.sru':'global type n_test from nonvisualobject\nend type\ntype variables\nlong Counts\nlong COUNT\n// count\nend variables\npublic function long of_sum ();\nCount = count + COUNT + counter\nreturn Count\nend function'}
    window.__worldWorkspaceList = ({path}) => ({ok:true,value:{path,entries:Object.keys(files).map(name=>({name,type:'file'}))}})
    window.__worldSourceOpen = async ({path})=>({ok:true,value:{path,source:files[path.split('/').pop()],encoding:'UTF-8',version:'1'}})
  }, total)
  await page.addScriptTag({content:bundle.outputFiles[0].text}); await page.locator('[data-world-icon-id="vscode"]').dblclick()
  const editor=page.locator('[data-world-vscode-key]'), open=name=>editor.getByRole('button',{name,exact:true}).dblclick()
  const marks=box=>box.locator('.world-vscode-word-hit'), settle=()=>page.evaluate(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok))))
  const point=(row,offset,fraction=.5)=>row.evaluate((row,[pos,fraction])=>{
    const w=document.createTreeWalker(row,NodeFilter.SHOW_TEXT), r=document.createRange(); let n
    while ((n=w.nextNode())) { if(pos>=n.length){pos-=n.length;continue} r.setStart(n,pos);r.setEnd(n,pos+1);const b=r.getBoundingClientRect();return {x:b.x+b.width*fraction,y:b.y+b.height/2} }
    throw Error('missing glyph '+row.textContent)
  },[offset,fraction]); const click=async(row,pos,side)=>{const p=await point(row,pos,side);await page.mouse.click(p.x,p.y);await settle()}
  await open('demo.js');const source=editor.locator('.world-vscode-editor-content:visible'), row=source.locator('.world-vscode-hl-line').first()
  await click(row,8,.8) // right half of last 't', caret is now at the following space
  assert.deepEqual(await marks(source).allTextContents(),['count','count','count'])
  const caret=()=>source.locator('textarea').evaluate(n=>[n.selectionStart,n.selectionEnd]); assert.deepEqual(await caret(),[9,9])
  assert.ok(await editor.getByRole('button',{name:'保存',exact:true}).isDisabled()); await click(row,9);assert.equal(await marks(source).count(),0)
  await click(row,5); await click(row,10); assert.equal(await marks(source).count(),0)
  const wrapped=editor.locator('.world-vscode-status-wrap');const originalWrap=await wrapped.getAttribute('aria-pressed')
  await wrapped.click();await click(row,6);assert.equal(await marks(source).count(),3)
  await wrapped.click();assert.equal(await wrapped.getAttribute('aria-pressed'),originalWrap)
  await open('notes.txt'); await click(row,13);assert.deepEqual(await marks(source).allTextContents(),['计数','计数'])
  await editor.getByRole('tab',{name:'demo.js'}).click()
  const pane=editor.locator('.world-vscode-pane:not(.is-hidden)').filter({has:page.locator('textarea[aria-label$="demo.js"]')});const box=await pane.boundingBox()
  await editor.getByRole('tab',{name:'notes.txt'}).dragTo(pane,{targetPosition:{x:box.width*.92,y:box.height*.5}})
  const nativePane=file=>editor.locator('.world-vscode-editor-content:visible').filter({has:page.locator(`textarea[aria-label$="${file}"]`)})
  const js=nativePane('demo.js'), txt=nativePane('notes.txt');await txt.waitFor();await click(js.locator('.world-vscode-hl-line').first(),5)
  assert.equal(await marks(js).count(),3);assert.equal(await marks(txt).count(),0)
  await js.locator('textarea').press('x');assert.equal(await marks(js).count(),0)
  await open('n_test.sru');const script=editor.locator('[data-srw-view=script]:visible');await click(script.locator('.cm-line').first(),1)
  assert.deepEqual(await marks(script).allTextContents(),['Count','count','COUNT','Count']);await script.screenshot({path:resolve(out,'pb-script.png')})
  await editor.getByRole('tab',{name:'Variables'}).click();const vars=editor.locator('[data-srw-view=variables]:visible');await click(vars.locator('.cm-line').nth(1),6)
  assert.deepEqual(await marks(vars).allTextContents(),['COUNT','count']);await click(vars.locator('.cm-line').nth(1),4,.1);assert.equal(await marks(vars).count(),0)
  await open('long.js');const cm=editor.locator('.world-vscode-large:visible'), first=cm.locator('.cm-line').first();await first.waitFor()
  const p=await point(first,2);await page.mouse.click(p.x,p.y);await settle();assert.ok(await marks(cm).count()>1)
  // Measure synchronous click processing (clear/select alternating). The matcher must never
  // even receive the full 100k-line string. No instrumentation is shipped in the editor.
  const stats=await cm.evaluate((el,p)=>{
    const input=el.querySelector('.cm-content'), orig=RegExp.prototype.exec, samples=[]; let maxChars=0
    RegExp.prototype.exec=function(text){if(this.source.includes('ID_Continue') && this.global)maxChars=Math.max(maxChars,text.length);return orig.call(this,text)}
    try { for(let i=0;i<24;i++){const t=performance.now(); input.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,detail:1,clientX:i%2?p.x:p.x+200,clientY:p.y}));samples.push(performance.now()-t)} }
    finally{RegExp.prototype.exec=orig} return {maxChars,medianMs:samples.sort((a,b)=>a-b)[12],marks:el.querySelectorAll('.world-vscode-word-hit').length}
  },p)
  assert.ok(stats.maxChars>0 && stats.maxChars<20000,JSON.stringify(stats));assert.ok(stats.marks>0 && stats.marks<500)
  await cm.locator('.cm-scroller').evaluate(n=>n.scrollTop=n.scrollHeight); await page.waitForFunction(()=>[...document.querySelectorAll('.world-vscode-large .cm-line')].some(n=>n.textContent.endsWith('row 99999')&&n.querySelectorAll('.world-vscode-word-hit').length===2))
  assert.deepEqual(errors,[]);console.log('Word highlight: native, split, PB script + declarations and large editor passed.',{lines:total,...stats})
  await writeFile(resolve(out,'performance.json'),JSON.stringify({lines:total,...stats},null,2))
} finally { await browser.close() }
