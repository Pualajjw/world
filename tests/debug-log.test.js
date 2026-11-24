import assert from 'node:assert/strict'
import test from 'node:test'
import { createDebugLog, LOG_LIMIT, traceText } from '../debug-log.js'

test('one million events: constant retained capacity and chronological wrap; desktop sessions are isolated', t => {
  const log = createDebugLog(), then = performance.now()
  for (let i=0; i<1_000_000; ++i) log.add(log.trace(), 'VSCode', 'World', 'request')
  t.diagnostic(`1,000,000 metadata writes: ${(performance.now()-then).toFixed(1)} ms`)
  const {rows,count} = log.snapshot(); assert.equal(count,1_000_000); assert.equal(rows.length,LOG_LIMIT)
  assert.deepEqual(rows.map(r=>r.n), Array.from({length:LOG_LIMIT},(_,i)=>count-i))
  assert.equal(createDebugLog().snapshot().rows.length,0)
})

test('poll storms cost no rows; application and transport failures survive without touching request contents', async () => {
  const log = createDebugLog(), payload = { get source() { throw Error('never inspect source') } }
  const reply = {ok:true, get value(){ throw Error('do not inspect results') }}
  let fail=false
  const rpc = log.wrap({async call(_base, _method, p) {assert.equal(p,payload); if(fail) throw Error('SECRET_TOKEN');return reply}})
  for (let i=0;i<10000;i++) assert.equal(await rpc.call('/api','world-desktop/poll',payload),reply)
  assert.deepEqual(log.snapshot(),{count:0,skipped:10000,rows:[]})
  fail=true;await assert.rejects(rpc.call('/api','world-desktop/poll',payload),/SECRET_TOKEN/)
  await log.wrap({async call(){return {ok:false,error:{message:'SECRET_TOKEN',code:'WORLD_TEST'}}}}).call('/api','world-ssh/poll',{})
  const {rows}=log.snapshot();assert.deepEqual(rows.map(r=>r.level),['error','error']);assert.match(rows[0].event,/WORLD_TEST/)
  assert.ok(!JSON.stringify(rows).includes('SECRET_TOKEN'))
})

test('PB run and completion share a trace; repeated polls, paths, output and backend ID never enter it',async()=>{
  const log=createDebugLog(),d={id:'private-id',spawned:true,temp:'private'},payload={root:'SECRET',sessionId:'SECRET'}
  const job={diagnostics:d,running:true,output:'SECRET',error:''}
  const rpc=log.wrap({async call(){return {ok:true,value:job}}},'VSCode')
  await rpc.call('/api','world-vscode-pb/run',payload)
  for(let i=0;i<8;i++)await rpc.call('/api','world-vscode-pb/status',payload)
  Object.assign(job,{running:false,error:'SECRET'});Object.assign(d,{elapsedMs:12,exitCode:7})
  await rpc.call('/api','world-vscode-pb/status',payload);await rpc.call('/api','world-vscode-pb/status',payload)
  const rows=log.snapshot().rows;assert.equal(rows.length,5);assert.equal(rows[0].level,'error');assert.equal(new Set(rows.map(r=>r.id)).size,1)
  const text=traceText(rows,rows[0].id);assert.match(text,/运行项目（F5）[\s\S]+启动 PB worker[\s\S]+使用任务专用临时目录[\s\S]+退出码 7/);assert.doesNotMatch(text,/SECRET|private-id/)
})

for (const op of ['run','pbtest']) test(`VSCode → terminal/${op} logs the actual process exit`, async()=>{
  const log=createDebugLog(), rpc=log.wrap({async call(_base,method){return {ok:true,value:method.endsWith('/'+op) ? {jobId:'abc'} : {running:false,exitCode:3,durationMs:10,chunk:'SECRET'}}}},'VSCode')
  await rpc.call('/api','world-terminal/'+op,{line:'SECRET'});await rpc.call('/api','world-terminal/poll',{jobId:'abc'})
  const [end,start]=log.snapshot().rows;assert.equal(end.id,start.id);assert.equal(end.level,'error');assert.equal(end.ms,10);assert.match(end.event,/退出码 3/)
  assert.doesNotMatch(traceText([end,start],end.id),/SECRET/)
})
