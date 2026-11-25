import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppToolRouter } from '../app-tool-router.js'
import { SECRETARY, secretaryEnvelope, updateSecretaryReport } from '../secretary.js'

const code = 'return await tools.world_secretary({"mode":"investigate","task":"Look up the caller."});'
test('only a literal secretary call, without wider sandbox options, qualifies for no-handoff PTC', () => {
  assert.equal(secretaryEnvelope({code,description:'查调用',timeoutMs:30000}),true)
  for (const args of [{code:code + '\nreturn 1'}, {code:'return 1; ' + code}, {code:code.replace('"investigate"','pickMode()')},
    {code:code.replace('"task"','"cwd":"/other","task"')}, {code:code.replace('investigate','any')}, {code:code.replace('Look up the caller.','')},
    {code,sandboxMode:'danger-full-access'}, {code,justification:'Please approve'}]) assert.equal(secretaryEnvelope(args),false)
})

test('only a later nonblank assistant text replaces the secretary report', () => {
  const text = text => ({type:'text',text}), tool = {type:'tool-call'}
  let report = updateSecretaryReport('', [tool]); assert.equal(report, '')
  for (const content of [[text('draft')], [text('  Final'), tool, text('evidence.  ')], [tool], [text(' \n')], []]) {
    report = updateSecretaryReport(report, content)
  }
  assert.equal(report, '  Final\nevidence.  ')
})

test('the secretary ticket neither grants other tools nor survives the user turn',async t=>{
  let user = true
  const agent = { id:'fixed', session:{id:'fixed'}, ctx:{tools:{restrict:()=>()=>{}}} }
  const brain = {get:async()=>brain.peek(),peek:()=>({sessionId:'fixed'})}
  const router = createAppToolRouter({brain, agents:{get:()=>agent}, tools:{definitions:()=>[{name:SECRETARY},{name:'read'}]},
    bridge:{subscribe:()=>()=>{},request:assert.fail}, canDelegate:candidate=>user && candidate===agent})
  t.after(()=>router.dispose())
  const call = (name,args,parent,signal = new AbortController().signal)=>({agent, token:Symbol(), name, arguments:args, parent, signal}), next = async()=>({kind:'allow'})
  const outer = call('run_code',{code}), child = call(SECRETARY,{},outer.token)
  assert.equal((await router.prepare(outer,next)).kind,'allow'); assert.equal((await router.prepare(child,next)).kind,'allow')
  for (const forbidden of [call('write',{},outer.token),call('read',{}),call('run_code',{code:'return 1'}),call(SECRETARY,{},Symbol())]) {
    assert.equal((await router.prepare(forbidden,next)).kind,'deny'); assert.ok(router.guard(forbidden))
  }
  assert.equal(router.guard(child),undefined); assert.equal((await router.dispatch(child,next)).kind,'allow')
  user = false; assert.ok(router.guard(child)); await assert.rejects(router.dispatch(child,next)); router.result(child,{}); router.result(outer,{})
  user = true; assert.equal((await router.prepare(call(SECRETARY,{},outer.token),next)).kind,'deny')

  // No tools/result: a call abandoned before dispatch, or settled by dispatch itself.
  const controller = new AbortController(), abandoned = call('run_code',{code},undefined,controller.signal)
  await router.prepare(abandoned,next); controller.abort()
  assert.ok(router.guard(abandoned)); assert.equal((await router.prepare(call(SECRETARY,{},abandoned.token),next)).kind,'deny')
  for (const fails of [false, true]) {
    const program = call('run_code',{code}); await router.prepare(program,next)
    const run = router.dispatch(program,async()=>{
      assert.equal((await router.prepare(call(SECRETARY,{},program.token),next)).kind,'allow')
      if (fails) throw new Error('interrupted')
    })
    if (fails) await assert.rejects(run,/interrupted/); else await run
    assert.equal((await router.prepare(call(SECRETARY,{},program.token),next)).kind,'deny')
  }
})
