import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_BINDINGS, bindingFor } from '../app-bindings.js'
import { createAppToolRouter } from '../app-tool-router.js'
import { createAppPlayback } from '../app-playback.js'

test('DSH is never a default owner but explicit user bindings are preserved',()=>{
  assert.ok(!Object.values(DEFAULT_BINDINGS).includes('dsh'))
  for (const name of ['world_life','world_workbench']) {
    assert.equal(bindingFor(name,{}),''); assert.equal(bindingFor(name,{[name]:'dsh'}),'dsh')
  }
})

function fixture(t, { cwd, app = 'terminal' } = {}) {
  let notify, receipt
  const sent = [], agent = { id:'fixed', session:{id:'fixed', header: cwd ? { cwd } : undefined}, ctx:{tools:{restrict:()=>()=>{}}} }
  const brain = {get:async()=>brain.peek(),peek:()=>({sessionId:'fixed'})}
  const bridge = {subscribe:fn=>{notify=fn;return ()=>{}}, request:async (p,opts)=>{
    sent.push(p)
    if (p.action!=='app_invoke') return {}
    if (receipt) return receipt(p)
    opts?.invoke?.()
    return {started:true}
  }}
  const router = createAppToolRouter({brain,bridge,agents:{get:()=>agent},tools:{definitions:()=>[{name:'external'}]}})
  t.after(()=>router.dispose())
  const grant = (controlId,installed=true,desktopId='one') => notify({desktopId,connected:true,state:{
    control:{owner:controlId?'assistant':'human',sessionId:'fixed',controlId},apps:[{id:app,installed}],toolBindings:{external:app} }})
  const exec = (name = 'external', args = { command:'demo' }) => ({agent,name,token:Symbol(),arguments:args,signal:new AbortController().signal})
  return {router,sent,grant,exec,receipt:fn=>{receipt=fn}}
}
const allow = async()=>({kind:'allow'})

test('pending approval cannot cross takeover/regrant, uninstall, or an ambiguous desktop',async t=>{
  const {router,grant,exec}=fixture(t); grant('first'); const old=exec()
  assert.equal((await router.prepare(old,allow)).kind,'allow'); grant(null); grant('second')
  assert.ok(router.guard(old)); await assert.rejects(router.dispatch(old,()=>assert.fail('stale grant')))
  const fresh=exec(); await router.prepare(fresh,allow); assert.equal(router.guard(fresh),undefined)
  grant('second',false); assert.ok(router.guard(fresh)); assert.equal((await router.prepare(exec(),allow)).kind,'deny')
  grant('second'); grant('other',true,'two'); assert.ok(router.guard(fresh)); assert.equal((await router.prepare(exec(),allow)).kind,'deny')
})

test('a PTC subcall cannot borrow a fresh grant after its parent was revoked',async t=>{
  const {router,grant,exec}=fixture(t); grant('first')
  const outer={...exec(),name:'run_code'}; assert.equal((await router.prepare(outer,allow)).kind,'allow')
  const nested=()=>({...exec(),parent:outer.token})
  assert.equal((await router.prepare(nested(),allow)).kind,'allow')
  grant(null); grant('second'); assert.equal((await router.prepare(nested(),allow)).kind,'deny')
})

test('no application receipt means no dispatch; takeover during receipt also denies the body',async t=>{
  const {router,grant,exec,receipt}=fixture(t); grant('first')
  for (const respond of [()=>({invoke:'wrong'}),p=>{grant(null);return {invoke:p.receiptId}}]) {
    receipt(respond); const call=exec(); await router.prepare(call,allow)
    await assert.rejects(router.dispatch(call,()=>assert.fail('body must not start')),/授权/)
  }
})

test('reverse completions cannot reorder playback; revoke aborts only presentation',async()=>{
  const shown=[], signals=[], release=[]
  const inbox=createAppPlayback({canInvoke:()=>true,changed(){},onError:assert.fail,
    present(row,signal){shown.push(row.id);signals.push(signal);return new Promise(r=>release.push(r))} })
  const tick=()=>new Promise(r=>setImmediate(r))
  // B and C enter dispatch first; sequence 2 is a denied request that never reached the app.
  for (const [receiptId,sequence] of [['B',3],['C',4],['A',1]]) inbox.invoke({receiptId,sequence,controlId:'grant'},()=>{})
  inbox.finish({receiptId:'denied',sequence:2,controlId:'grant'},'grant')
  const finish=id=>inbox.finish({receiptId:id,controlId:'grant',output:id})
  finish('B'); finish('C'); await tick(); assert.deepEqual(shown,[])
  finish('A'); await tick(); assert.deepEqual(shown,['A']);release[0]();await tick();assert.deepEqual(shown,['A','B'])
  inbox.invoke({receiptId:'late',sequence:5,controlId:'grant'},()=>{});inbox.revoke();finish('late');release[1]();await tick()
  assert.equal(signals[1].aborted,true); assert.deepEqual(shown,['A','B']);assert.equal(inbox.history().at(-1).output,'late');inbox.dispose()
})

test('session cwd and resolved file reach the desktop in one real path form',async t=>{
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { realpathSync } = await import('node:fs')
  const workspace = await mkdtemp(join(tmpdir(),'world-path-'))
  t.after(()=>rm(workspace,{recursive:true,force:true}))
  await mkdir(join(workspace,'sub'))
  const main = join(workspace,'main.js'); await writeFile(main,'const needle = 42\n')
  // 同一文件写成 `sub\..` 形式；host 必须在下发前归一，否则桌面端会开出第二个同名标签。
  const indirect = join(workspace,'sub','..','main.js'), real = realpathSync.native(main)
  const {router,grant,exec,sent}=fixture(t,{cwd:join(workspace,'sub','..'),app:'vscode'}); grant('first')
  const call=exec('read',{file_path:indirect})
  assert.equal((await router.prepare(call,allow)).kind,'allow')
  await router.dispatch(call,async()=>({content:[{type:'text',text:'read ok'}],meta:{path:indirect}}))
  const invoke=sent.find(p=>p.action==='app_invoke')
  assert.equal(invoke.session.cwd,realpathSync.native(workspace)); assert.equal(invoke.path,real)
  router.result(call,{content:[{type:'text',text:'read ok'}],meta:{path:indirect}})
  while (!sent.some(p=>p.action==='app_result')) await new Promise(r=>setImmediate(r))
  assert.equal(sent.find(p=>p.action==='app_result').resolvedPath,real)
})

test('pending counts only the calls still waiting for the stage, per application',async()=>{
  const shown=[], releases=[]
  const inbox=createAppPlayback({canInvoke:()=>true,changed(){},onError:assert.fail,
    present(row){shown.push(row.id);return new Promise(r=>releases.push(r))} })
  const row=(receiptId,sequence,appId)=>({receiptId,sequence,appId,controlId:'grant',session:{id:'s'},input:'x'})
  const tick=()=>new Promise(r=>setImmediate(r))
  inbox.invoke(row('T1',1,'terminal'),()=>{})
  inbox.finish({receiptId:'T1',controlId:'grant',output:'ok'})
  await tick(); assert.deepEqual(shown,['T1'])
  // 台上那一条不算“后面还有”，排队两条才报 2。
  assert.equal(inbox.pending(),0)
  inbox.invoke(row('V1',2,'vscode'),()=>{})
  inbox.invoke(row('T2',3,'terminal'),()=>{})
  assert.equal(inbox.pending(),2); assert.equal(inbox.pending(r=>r.appId==='terminal'),1)
  inbox.finish({receiptId:'V1',controlId:'grant',output:'v'})
  inbox.finish({receiptId:'T2',controlId:'grant',output:'t'})
  inbox.finish({receiptId:'T1',controlId:'grant',output:'ok'}); releases[0](); await tick()
  assert.deepEqual(shown,['T1','V1']); assert.equal(inbox.pending(),1)
  assert.equal(inbox.pending(r=>r.appId==='terminal'),1)
  inbox.dispose()
})

test('mailbox invoke is authenticated, exact, and single-use; a normal reply alone does not run the capability',async t=>{  const {createDesktopBridge} = await import('../desktop-bridge.js')
  const bridge=createDesktopBridge(); t.after(()=>bridge.dispose())
  const state={apps:[],windows:[],control:{owner:'assistant',controlId:'g',sessionId:'fixed'}}
  const connection=await bridge.call('connect',{state}); let runs=0
  const capability={tool:'external',appId:'terminal',receiptId:'r'}
  const offer={action:'app_invoke',controlId:'g',actor:{sessionId:'fixed'},...capability}
  const send=()=>bridge.request(offer,{desktopId:connection.desktopId,invoke:()=>{runs++}})
  const reply=id=>bridge.call('reply',{...connection,commandId:id,result:{ok:true,value:{state}}})
  const first=send(), a=(await bridge.call('poll',connection)).command
  await reply(a.id); await first; assert.equal(runs,0)
  const second=send(), b=(await bridge.call('poll',connection)).command
  const payload={...connection,commandId:b.id,...capability}
  for (const change of [{token:'wrong'},{receiptId:'old'},{tool:'another'},{appId:'vscode'}])
    await assert.rejects(bridge.call('invoke',{...payload,...change}))
  assert.equal(runs,0); await bridge.call('invoke',payload); await assert.rejects(bridge.call('invoke',payload)); assert.equal(runs,1)
  await reply(b.id); await second
})
