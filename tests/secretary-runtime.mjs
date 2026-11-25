/** Offline DSH AgentLoop integration. Run with node tests/secretary-runtime.mjs.
 * Test prerequisites (not plugin dependencies): npm install --prefix tmp/secretary-host
 * @deepseek-ai/{dsh-agent-loop-testkit,dsh-fs-sandbox,dsh-sandbox-policy,dsh-tool-fs,dsh-user-approval,dsh-sandbox-local,dsh-subprocess-local,dsh-ptc-runtime-node}@0.2.2-rc.3 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerSecretary, SECRETARY } from '../secretary.js'
import { createAppToolRouter } from '../app-tool-router.js'
const root = process.env.WORLD_SECRETARY_TEST_MODULES || join(import.meta.dirname,'../tmp/secretary-host/node_modules/@deepseek-ai')
const lib = name => import(pathToFileURL(join(root,name,'lib/index.js')))
const { Context } = await lib('cordis'), ctx = new Context()
const { mountAgentLoopTestDependencies } = await lib('dsh-agent-loop-testkit')
const { createUserMessage, LlmAdapter } = await lib('dsh-llm')
const toolCallResponse = (id,name,args) => ({type:'tool-call',id,name,arguments:JSON.stringify(args)})
const textResponse = text => ({type:'text',text})
class MockAdapter extends LlmAdapter {
  constructor(script) { super(); this.script = script }
  async resolveModel(provider,id) { return {provider,id,name:id} }
  async *stream({signal}) {
    const b = this.script.shift(); assert.ok(b,'unexpected model call')
    if (typeof b === 'function') { await b(signal); return }
    yield {type:'block-start',index:0,blockType:b.type}
    yield b.type === 'text' ? {type:'text-delta',index:0,text:b.text} : {type:'tool-call-delta',index:0,id:b.id,name:b.name,argumentsDelta:b.arguments}
    yield {type:'block-end',index:0,block:b}
    yield {type:'usage',usage:{inputTokens:10,outputTokens:5}}
    yield {type:'finish',reason:{kind:b.type === 'text' ? 'stop' : 'tool-calls'}}
  }
}
const dir = await realpath(await mkdtemp(join(tmpdir(), 'world-secretary-'))), id = 'secretary-test-parent', target = join(dir,'proof.txt')
const brain = { peek:() => ({sessionId:id}), get:async () => brain.peek() }, events = [], receipts = []
try {
  const ptc = process.argv.includes('--ptc')
  await mountAgentLoopTestDependencies(ctx, ptc ? {tools:{mode:'ptc'}} : {})
  if (ptc) {
    await ctx.plugin((await lib('dsh-subprocess-local')).default)
    await ctx.plugin((await lib('dsh-sandbox-local')).default,{})
    await ctx.plugin((await lib('dsh-ptc-runtime-node')).NodePtcRuntime,{executionMode:'per-call'})
  }
  const call = (id,name,args) => ptc ? toolCallResponse(id,'run_code',{description:id,code:`return await tools.${name}(${JSON.stringify(args)});`}) : toolCallResponse(id,name,args)
  await ctx.plugin((await lib('dsh-sandbox-policy')).default, {mode:'workspace-write',workspaceRoot:dir})
  await ctx.plugin((await lib('dsh-fs-sandbox')).default, {cwd:dir}); await ctx.plugin((await lib('dsh-working-directory')).default); await ctx.plugin(await lib('dsh-tool-fs'),{readImage:false})
  await ctx.plugin((await lib('dsh-user-approval')).default)
  await ctx.plugin((await lib('dsh-agent-loop')).default)
  ctx.on('session/event',(session,event) => events.push({id:session.id,...event}))
  const canDelegate = registerSecretary(ctx,brain,createUserMessage)
  const router = createAppToolRouter({brain,tools:ctx.tools,agents:ctx.agents,canDelegate,bridge:{subscribe:()=>()=>{},request:async p=>receipts.push(p)}})
  ctx.effect(()=>()=>router.dispose()); ctx.on('agent/created',({agent})=>router.syncMask(agent)); ctx.on('tools/pre-execute',router.prepare,{prepend:true});ctx.tools.guard(router.guard); ctx.on('tools/execute',router.dispatch); ctx.on('tools/result',router.result)
  const adapter = new MockAdapter([
    call('dispatch',SECRETARY,{mode:'develop',task:'Write requested proof file and report.'}),
    call('write','write',{file_path:target,content:'done'}),textResponse('Secretary verified proof.txt.'),textResponse('Reported to the original conversation.'),
  ])
  ctx.llm.registerAdapter(['mock'],adapter)
  const parent = await ctx.agentLoop.create(id,{provider:'mock',model:'mock'},{cwd:dir})
  parent.followup(createUserMessage({source:{kind:'user',rpcId:'world-taskbar-fixture'},content:[{type:'text',text:'Create proof.txt'}]}))
  await parent.whenIdle()
  const report = events.find(e=>e.id===id && e.type==='tool/result')?.data.message
  assert.equal(report?.isError,false,JSON.stringify(report ?? events.filter(e=>e.type==='turn/end'))); assert.match(report.content[0].text,/Secretary verified/)
  const write = events.find(e=>e.id!==id && e.type==='tool/result')?.data.message
  assert.equal(write?.isError,false,JSON.stringify(write)); assert.equal(await readFile(target,'utf8'),'done'); assert.deepEqual(receipts,[])
  assert.equal(events.some(e=>e.type==='approval/asked'),false)
  assert.ok(events.some(e=>e.id!==id && e.type==='approval/policy' && e.data.policy==='never'))
  assert.equal(canDelegate(parent),false)
  const checked = events.length
  adapter.script.push(call('inspect',SECRETARY,{mode:'investigate',task:'Read proof.txt, do not edit.'}),
    call('read','read',{file_path:target}),call('forbidden','write',{file_path:target,content:'should not change'}),
    textResponse('Read proof.txt.'),textResponse('Investigation finished.'))
  parent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Inspect the file.'}]})); await parent.whenIdle()
  const results = events.slice(checked).filter(e=>e.id!==id && e.type==='tool/result').map(e=>e.data.message)
  assert.match(results[0].content[0].text,/done/); assert.equal(results[1].isError,true)
  assert.equal(await readFile(target,'utf8'),'done'); assert.equal(events.some(e=>e.type==='approval/asked'),false)
  const wake = events.length
  adapter.script.push(call('denied',SECRETARY,{mode:'develop',task:'Not a user request'}),textResponse('No delegation.'))
  parent.followup(createUserMessage({source:{kind:'user',rpcId:'world-workbench-timer'},content:[{type:'text',text:'Wake up.'}]})); await parent.whenIdle()
  assert.equal(events.slice(wake).some(e=>e.id!==id),false); assert.equal(events.slice(wake).find(e=>e.type==='tool/result').data.message.isError,true)
  const stopped = events.length, started = Promise.withResolvers()
  adapter.script.push(call('cancel',SECRETARY,{mode:'investigate',task:'A slow investigation'}), signal => new Promise(resolve => {
    started.resolve(); signal.addEventListener('abort',resolve,{once:true})
  }))
  parent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Start investigation.'}]}))
  await started.promise; parent.cancel({kind:'user'}); await parent.whenIdle()
  const child = events.slice(stopped).find(e=>e.id!==id && e.type==='turn/start')
  assert.ok(child); assert.ok(!ctx.agents.get(child.id),'cancelling the parent stops and releases the worker')
  console.log('PASS: real DSH parent → independent workspace write → original reply; read-only investigation, timer denial and cancellation; zero approvals')
} finally { await ctx.fiber.dispose(); await unlink(target).catch(e=>{ if (e.code!=='ENOENT') throw e }); await rmdir(dir) }
