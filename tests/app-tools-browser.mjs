/** Actual DSH registry/policy/dispatch -> World mailbox -> rendered app; no model credentials needed. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createDesktopBridge } from '../desktop-bridge.js'
import { createTerminalFixture } from './terminal-fixture.js'
import { createAppToolRouter } from '../app-tool-router.js'
const root = join(import.meta.dirname, '..'), dsh = process.env.DSH_SOURCE || 'E:/deepseek-harness'
const load = rel => import(pathToFileURL(join(dsh, rel, 'lib/index.js')))
const { Context } = await load('vendor/cordis'), { default: Tools } = await load('packages/core/tools')
const { default: Prompt } = await load('packages/core/system-prompt'), { createScope } = await load('packages/core/scope')
const { executeToolFixture, executeModelToolFixture } = await load('packages/test-support/tool-testkit')
const ctx = new Context(); await ctx.plugin(Prompt, {}); await ctx.plugin(Tools)
const id = 'session-1', brain = { get: async () => ({ sessionId:id }), peek: () => ({ sessionId:id }) }
const workspace = await mkdtemp(join(tmpdir(),'world-tools-')), file = join(workspace,'main.js')
await writeFile(file, 'const needle = 42\n')
const agent = { id, session:{ id, header:{id,cwd:workspace} } }
ctx.provide('workingDirectory', { defaultDirectory:workspace, get:s=>s.header.cwd, ensure:async a=>a.session.header.cwd })
await ctx.plugin((await load('packages/fs/fs-local')).default)
await ctx.plugin(await load('packages/fs/tool-fs'), { readImage:false })
await ctx.plugin((await load('packages/subprocess/subprocess-local')).default)
await ctx.plugin(await load('packages/fs/tool-fs-search'),{ sampleOverCapGlobResults:false })
await ctx.plugin(await load('packages/shell/shell-env'))
await ctx.plugin((await load('packages/shell/pwsh-local')).PwshLocalExecutor)
await ctx.plugin(await load('packages/shell/tool-pwsh'),{ enableRunInBackground:false, promoteOnTimeout:false })
await ctx.plugin(Object.assign(inner => { agent.ctx = createScope(inner, agent).ctx }, {inject:['tools','systemPrompt']}))
const bridge = createDesktopBridge(), agents = { get: x => x === id ? agent : undefined }
const router = createAppToolRouter({brain, bridge, tools:ctx.tools, agents})
let started, release, ran = [], held = false
for (const name of ['outside_plugin','never_bound','world_workbench']) ctx.tools.register({ name, description:name,
  parameters:{type:'object',properties:{pattern:{type:'string'},file_path:{type:'string'},command:{type:'string'}}},
  output:{schema:{type:'string'},render:(_a,x)=>[{type:'text',text:x}]},
  async execute(args) { ran.push(name); if (held && name === 'outside_plugin') { started(); await new Promise(r => { release = r }) }
    return `${name}: ${args.command || args.pattern || args.file_path} OK` } })
ctx.on('tools/pre-execute',router.prepare,true); ctx.tools.guard(router.guard); ctx.on('tools/execute',router.dispatch); ctx.on('tools/result',router.result)
const call = (name, args, who = agent) => executeToolFixture(ctx,{ agent:who, name, arguments:args, callId:crypto.randomUUID(),signal:new AbortController().signal })
const require = createRequire(join(root,'../workflow-studio/package.json'))
const { chromium } = require('playwright-core'), { build } = require('esbuild')
const bundle = await build({absWorkingDir:root,entryPoints:['tests/browser-entry.js'],bundle:true,format:'iife',platform:'browser',write:false,nodePaths:[join(root,'../workflow-studio/node_modules')],loader:{'.css':'text'}})
const browser = await chromium.launch({headless:true,executablePath:process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'})
const terminalBackend = createTerminalFixture()
try {
  const page = await browser.newPage({viewport:{width:1280,height:800}}), errors = []
  page.on('pageerror',e=>{ errors.push(e.message); console.error(e) }); page.setDefaultTimeout(9000)
  await page.exposeBinding('__worldDesktopCall',(_s,op,p)=>bridge.call(op,p)); await page.exposeBinding('__worldBrainCall',()=>({...brain.peek(),setupRequired:false}))
  await page.exposeBinding('__worldSourceOpen',async (_source,p)=>{
    // TEMP 在部分机器上是 8.3 短名（ADMINI~1），而 DSH 解析出长名；两边都取真实路径再比。
    assert.equal(realpathSync.native(dirname(resolve(p.path))), realpathSync.native(workspace))
    return {ok:true,value:{path:p.path,source:await readFile(p.path,'utf8'),version:'v1',eol:'LF',bom:false}}
  })
  await page.exposeBinding('__worldTerminalCall',async (_source,op,p)=>{
    const cwd = !p?.cwd || p.cwd === '/workspace' ? workspace : p.cwd
    return {ok:true,value:await terminalBackend.call(op,{...p,cwd})}
  })
  await page.exposeBinding('__worldToolCatalog',()=>router.catalog())
  await page.route('http://127.0.0.1/test', r=>r.fulfill({contentType:'text/html',body:'<!DOCTYPE html><html><body style="margin:0"><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>'})); await page.goto('http://127.0.0.1/test')
  await page.evaluate(()=>localStorage.setItem('dsh.world.apps',JSON.stringify(['vscode','terminal'])))
  await page.addStyleTag({content:await readFile(join(dsh,'packages/client/ui-theme/src/styles/design-platform.css'),'utf8')})
  await page.addScriptTag({content:bundle.outputFiles[0].text})
  await page.locator('[data-world-control-button]').waitFor()
  const settings = page.locator('[data-world-plugin="world-settings"]')
  const shot = async name => {
    const dir = process.env.WORLD_POINTER_SHOTS_DIR
    if (dir) { await mkdir(dir,{recursive:true}); await page.screenshot({path:join(dir,name+'.png'),animations:'disabled'}) }
  }
  const openSettings = async () => {
    await page.locator('.world-start-button').click()
    await page.locator('[data-world-app-card="world-settings"] button').click()
    await settings.waitFor({state:'visible'})
  }
  const wait = async predicate => { const until=Date.now()+6000; while (!predicate()) {if(Date.now()>until) throw Error('host state timed out'); await new Promise(r=>setTimeout(r,20))} }
  await openSettings()
  await shot('world-tool-settings')
  assert.equal(await page.locator('body').getAttribute('data-world-window'),'closed','World settings must not open the native window')
  assert.equal(await settings.getByLabel('world_workbench 所属应用').inputValue(),'')
  assert.equal(await settings.locator('select[aria-label$="所属应用"]').evaluateAll(nodes=>nodes.some(n=>n.value==='dsh')),false)
  // Explicit user bindings are still supported; DSH is not a default owner.
  await settings.getByLabel('world_workbench 所属应用').selectOption('dsh')
  await page.getByLabel('outside_plugin 所属应用').selectOption('terminal',{force:true})
  await page.getByLabel('切换到应用的动画').selectOption('none',{force:true})
  await page.getByLabel('outside_plugin 前台动画').selectOption('fade',{force:true})
  await settings.getByRole('button',{name:'关闭',exact:true}).click()
  await openSettings()
  await shot('world-tool-settings-custom')
  assert.equal(await settings.getByLabel('outside_plugin 所属应用').inputValue(),'terminal')
  assert.equal(await settings.getByLabel('outside_plugin 前台动画').inputValue(),'fade')
  await settings.getByRole('button',{name:'关闭',exact:true}).click()
  assert.equal((await call('outside_plugin',{command:'no grant'})).isError,true)
  await page.locator('[data-world-control-button]').click()
  const measureHome = async () => (await page.waitForFunction(()=>{
    const card=document.querySelector('.world-control-card')?.getBoundingClientRect(), svg=document.querySelector('[data-world-assistant-pointer] svg')?.getBoundingClientRect()
    if (!card || !svg?.width) return false
    const gap=card.top-svg.bottom, dx=card.x+card.width/2-svg.x-svg.width/2
    return Math.abs(gap-8)<.1 && Math.abs(dx)<.1 ? {gap,dx} : false
  })).jsonValue()
  const home = await measureHome(); await shot('world-pointer-home'); await page.locator('[data-world-assistant-toggle]').click()
  const collapsed = await measureHome(); await page.locator('[data-world-assistant-toggle]').click(); await measureHome()
  await wait(()=>ctx.tools.get('outside_plugin',agent))
  assert.equal(ctx.tools.get('never_bound',agent),undefined)
  // 绑定改动必须当场收紧/放开宿主的工具表，而不是等下一次会话或重开桌面。
  // 这里直接写存储再派发同一个事件：点开始菜单会先接管桌面，测不出授权状态下的链路。
  const setBinding = async owner => page.evaluate(owner => {
    const key = 'dsh.world.app-tools.v1', saved = JSON.parse(localStorage.getItem(key) || '{}')
    localStorage.setItem(key, JSON.stringify({ ...saved, bindings: { ...saved.bindings, outside_plugin: owner } }))
    window.dispatchEvent(new Event('world-app-tool-settings'))
  }, owner)
  await setBinding('')
  await wait(()=>!ctx.tools.get('outside_plugin',agent))
  await setBinding('terminal')
  await wait(()=>ctx.tools.get('outside_plugin',agent))
  assert.equal((await call('never_bound',{}, {id:'other',session:{id:'other'}})).isError,false)
  const records = page.locator('[data-world-app-receipt][open][data-animation]')
  const steps = []
  // Observe DOM commits, not host logs; capture the app window and whether chat actually covers it.
  await page.exposeBinding('__worldStep',(_s,step)=>steps.push(step))
  await page.evaluate(()=>{ let last; const scan=()=>{const el=document.querySelector('[data-world-app-receipt][data-animation][open]'); if (!el || last===el.dataset.worldAppReceipt) return
    last=el.dataset.worldAppReceipt; requestAnimationFrame(()=>{const box=el.getBoundingClientRect(), title=el.querySelector('summary').getBoundingClientRect(), arrow=document.querySelector('[data-world-assistant-pointer] svg').getScreenCTM(), label=document.querySelector('.world-assistant-pointer-label').getBoundingClientRect();window.__worldStep({ text:el.innerText,active:document.body.dataset.worldActiveId,dx:arrow.e-title.left,dy:arrow.f-title.top-title.height/2,labelClear:label.bottom<=title.top+.1,
      app:el.closest('section')?.getAttribute('aria-label'), animation:el.dataset.animation,chat:getComputedStyle(document.querySelector('.world-control-overlay')).visibility,
      hit:el.contains(document.elementFromPoint(box.x+Math.min(12,box.width/2),box.y+Math.min(10,box.height/2))) })})};new MutationObserver(scan).observe(document.body,{childList:true,subtree:true,attributes:true}) })
  const fastStart = Date.now()
  for (const [name,args] of [['grep',{pattern:'needle'}],['outside_plugin',{command:'first'}],['read',{file_path:file}]]) { const result = await call(name,args); assert.ok(!result.isError,JSON.stringify(result)) }
  await wait(()=>steps.length===3)
  const fastMs = Date.now() - fastStart
  // 节拍回退到「每步固定 850ms」会让这三个快速调用多等一秒以上；这里只做量级提示，不锁死机器差异。
  assert.ok(fastMs < 6000, `three fast replays took ${fastMs}ms`)
  assert.deepEqual(steps.map(s=>s.active.startsWith('vscode:')?'vscode':s.active),['vscode','terminal','vscode'])
  assert.ok(steps.every(s=>s.chat==='hidden' && s.hit),JSON.stringify(steps))
  assert.deepEqual(steps.map(s=>s.animation),['none','fade','none'])
  assert.ok(steps[0].text.includes('needle') && steps[1].text.includes('outside_plugin: first OK'),JSON.stringify(steps))
  await page.waitForFunction(()=>document.querySelector('.world-vscode-window [data-world-tool-output]')?.textContent.includes('const needle = 42') && !document.body.dataset.worldAppReplay)
  const returned = await measureHome()
  assert.ok(steps.every(s=>Math.abs(s.dx)<1 && Math.abs(s.dy)<1 && s.labelClear),JSON.stringify(steps))
  console.log('Pointer geometry (CSS px):',JSON.stringify({home,collapsed,returned,records:steps.map(({active,dx,dy})=>({active,dx,dy}))}),'three fast replays (ms):',fastMs)
  held=true; const begun = new Promise(r=>{started=r}); const long = call('outside_plugin',{command:'continue after takeover'}); await begun
  await wait(()=>steps.length===4); await shot('world-pointer-receipt'); assert.equal(steps[3].app,'终端'); assert.match(steps[3].text,/执行中/)
  await call('grep',{pattern:'queued behind long job'})
  await page.locator('[data-world-control-button]').click(); const foreground=await page.locator('body').getAttribute('data-world-active-id')
  release(); assert.ok(!(await long).isError)
  await wait(()=>!ctx.tools.get('grep',agent)); assert.equal((await call('outside_plugin',{command:'must not start'})).isError,true)
  await page.waitForFunction(()=>document.querySelector('.world-terminal-window [data-world-tool-output]')?.textContent.includes('continue after takeover OK'))
  assert.equal(await page.locator('body').getAttribute('data-world-active-id'),foreground); assert.equal(await records.count(),0); assert.equal(steps.length,4)
  assert.deepEqual(ran,['never_bound','outside_plugin','outside_plugin']); assert.deepEqual(errors,[])
  await page.locator('[data-world-control-button]').click(); await wait(()=>ctx.tools.get('pwsh',agent))
  const written = await call('write',{file_path:join(workspace,'output.txt'),content:'world-real-result'})
  assert.ok(!written.isError,JSON.stringify(written)); assert.equal(await readFile(join(workspace,'output.txt'),'utf8'),'world-real-result')
  const shell = await call('pwsh',{command:'Get-Content -Raw -LiteralPath ./output.txt',description:'Read integration test output'})
  assert.ok(!shell.isError,JSON.stringify(shell)); assert.match(shell.content[0].text,/world-real-result/)
  await page.waitForFunction(()=>document.querySelector('.world-terminal-window [data-world-tool-output]')?.textContent.includes('world-real-result'))
  await page.waitForFunction(()=>!document.body.dataset.worldAppReplay)
  // Use the actual PTC executor AND its Node worker; the fixture session only records SDK events.
  const nested = []; agent.session.append = (type, data) => { if (type === 'tool/ptc-dispatch-start') nested.push(data.name) }
  await ctx.plugin((await load('packages/sandbox/sandbox-local')).default, {})
  ctx.provide('sandboxPolicy', { defaultMode: 'workspace-write', resolve: () => ({ mode:'workspace-write', workspaceRoot:workspace, sessionId:id }) })
  await ctx.plugin((await load('packages/ptc-runtime/ptc-runtime-node')).NodePtcRuntime, { executionMode:'per-call' })
  await ctx.plugin(await load('packages/core/tool-executor-ptc'))
  const program = (code, description) => executeModelToolFixture(ctx, { name:'run_code', arguments:{ code, description },
    agent, callId:crypto.randomUUID(), signal:new AbortController().signal })
  const beforeProgram = steps.length
  const r = await program(`const data = await tools.read({file_path:'main.js'}); const cmd = await tools.pwsh({command:'Write-Output ptc-shell-result',description:'Print PTC test result'}); return cmd`, 'read then use PowerShell')
  assert.ok(!r.isError,JSON.stringify(r)); assert.deepEqual(nested,['read','pwsh'])
  await page.waitForFunction(()=>document.querySelector('.world-terminal-window [data-world-tool-output]')?.textContent.includes('ptc-shell-result') && !document.body.dataset.worldAppReplay)
  assert.deepEqual(steps.slice(beforeProgram).map(s=>s.active.startsWith('vscode:')?'vscode':s.active),['vscode','terminal'])
  const terminal = page.locator('.world-terminal-window details')
  assert.ok(await terminal.evaluate(n=>n.open)); assert.ok(await terminal.locator('pre').first().isVisible()); assert.ok(await terminal.locator('[data-world-tool-output]').isVisible())
  const pure = await program('return 6 * 7', 'pure program')
  assert.ok(!pure.isError, JSON.stringify(pure))
  await page.waitForFunction(()=>{const n=document.querySelector('.world-terminal-window details');return !document.body.dataset.worldAppReplay && n?.open && n.innerText.includes('return 6 * 7') && n.innerText.includes('42')})
  // Stall the real file body, not the replay. A later terminal body can finish while A owns the screen.
  let unblock, gateName
  ctx.on('tools/execute',async (exec,next)=>{
    if (exec.name === gateName) await new Promise(resolve => { unblock=resolve })
    return next()
  })
  const slowPath = join(workspace,'slow.js'); await writeFile(slowPath,'// original slow file\n')
  for (const [name, text] of [['read','// original slow file'],['write','// changed on disk']]) {
    gateName=name; const count=steps.length
    const args = { file_path:slowPath, ...(name==='write'?{content:text+'\n'}:{}) }
    const slow=call(name,args); await wait(()=>typeof unblock==='function' && steps.length===count+1)
    const later=await call('pwsh',{command:'Write-Output fast-second',description:'Print the second result'})
    assert.ok(!later.isError,JSON.stringify(later)); await page.waitForTimeout(1000)
    assert.equal(steps.length,count+1,'B finished but A must still own the foreground')
    assert.match(steps[count].text,/执行中/); unblock(); unblock=null; gateName=null
    const done=await slow; assert.ok(!done.isError,JSON.stringify(done))
    await page.waitForFunction(text=>document.body.dataset.worldActiveId.startsWith('vscode:') && document.querySelector('.world-vscode-textarea')?.value.trim()===text,text)
    await wait(()=>steps.length===count+2); assert.equal(steps[count+1].active,'terminal'); assert.match(steps[count+1].text,/fast-second/)
    await page.waitForFunction(()=>!document.body.dataset.worldAppReplay)
  }
  const dshCall = await call('world_workbench',{command:'check-native-log'})
  assert.ok(!dshCall.isError,JSON.stringify(dshCall))
  await page.waitForFunction(()=>document.body.dataset.worldActiveId==='dsh' && document.body.dataset.worldAppReplay && document.querySelector('.world-assistant-pointer-label')?.textContent.includes('world_workbench'))
  assert.ok(await page.locator('[data-world-assistant-pointer]').isVisible(),'pointer stays visible while conversation yields the screen')
  assert.ok(!await page.locator('.world-control-overlay').isVisible())
  assert.equal(await page.locator('.world-window-frame [data-world-app-receipt]').count(),0,'no duplicate history above native log')
  await page.waitForFunction(()=>!document.body.dataset.worldAppReplay)
  assert.equal(await page.locator('.world-window-frame [data-world-app-receipt]').count(),0)
  await page.locator('[data-world-control-button]').click()
  await page.locator('[data-world-assistant-pointer]').waitFor({state:'hidden'})
  // 设置页：搜索、单行恢复、全部恢复默认都在真实 DOM 上走一遍。
  await openSettings()
  await settings.getByLabel('搜索工具').fill('pwsh')
  assert.equal(await settings.locator('[data-world-tool-binding]').count(),1,'search keeps only the matching tool')
  assert.match(await settings.locator('[data-world-tool-binding]').innerText(),/pwsh/)
  await settings.getByLabel('搜索工具').fill('zzzz')
  await settings.getByText('没有匹配的工具。').waitFor()
  await settings.getByLabel('搜索工具').fill('')
  await settings.getByLabel('outside_plugin 恢复默认').click()
  assert.equal(await settings.getByLabel('outside_plugin 所属应用').inputValue(),'')
  await settings.getByLabel('world_workbench 恢复默认').click()
  assert.equal(await settings.getByLabel('world_workbench 所属应用').inputValue(),'')
  await settings.getByRole('button',{name:'全部恢复默认'}).click()
  assert.equal(await settings.getByLabel('read 所属应用').inputValue(),'vscode','built-in default owner returns after a full reset')
  // 刷新要有反馈：列表没变时，用户才知道是“没必要刷新”还是“刷新没生效”。
  await settings.getByRole('button',{name:'刷新 DSH 工具目录'}).click()
  await page.waitForFunction(()=>/共 \d+ 个 · 已刷新 \d\d:\d\d/.test(document.querySelector('.world-tool-settings-count')?.textContent||''))
  // 手机窄屏：四列收成两列，组件本身不能横向溢出。
  await page.setViewportSize({width:360,height:620})
  await page.waitForTimeout(250)
  const narrow = await settings.locator('.world-tool-settings').evaluate(n=>({scroll:n.scrollWidth,client:n.clientWidth}))
  assert.ok(narrow.scroll <= narrow.client + 1, `settings overflow at 360px: ${JSON.stringify(narrow)}`)
  await shot('world-tool-settings-phone')
  await page.setViewportSize({width:1280,height:800})
  await settings.getByRole('button',{name:'关闭',exact:true}).click()
  assert.deepEqual(errors,[])
  console.log('PASS: native + real PTC worker read/pwsh routing, pure code, expanded terminal I/O, slow file open/refresh, final FIFO and takeover.')
} finally {
  await browser.close(); router.dispose(); bridge.dispose(); await terminalBackend.dispose()
  assert.equal(dirname(workspace),tmpdir()); assert.ok(basename(workspace).startsWith('world-tools-'))
  await rm(workspace,{recursive:true,force:true})
}
