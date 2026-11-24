import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createPbActions } from '../pb-actions.js'

function fixture(writable = false, stderr = 'compile failed') {
  const root = join(tmpdir(), 'a.workspace'), target = join(tmpdir(),'a.pbt')
  let finish, args, policy = {mode:'workspace-write'}
  let markStarted
  const started = new Promise(r => { markStarted = r })
  const project = {root, pbtPath:target, kind:'pbt', pbVersion:90}
  const ctx = {sandboxPolicy:{resolve:() => policy},fs:{resolve:async p => p,contains:()=>writable},get:() => ({spawn(spec) {
    args = spec.argv; markStarted()
    return {done:new Promise(r => {finish = r}),collected:{stderr:{readFrom:()=>({text:stderr})}}}
  }})}
  const service = createPbActions(ctx, {roots:{project:async r => r === root ? project : null}, sessionOf:async () => ({}), writableRoots:()=>writable ? [tmpdir()] : [], python:()=> 'python.exe'})
  return {project,root,target,started,call:(op,p={})=>service.call(op,{sessionId:'s',root,...p}),finish:async code=>{finish({exitCode:code});await new Promise(setImmediate)},args:()=>args,policy:p=>{policy=p},service}
}
test('run uses the registered PBVM and PBT, never client-supplied exe or options; locks concurrent starts',async()=>{
  const f=fixture()
  const starts=await Promise.allSettled([f.call('run',{pbtPath:'bad.exe',pbVersion:123}),f.call('run')])
  assert.equal(starts.filter(x=>x.status==='fulfilled').length,1)
  assert.deepEqual(f.args().slice(-3),['run',f.target,'90'])
  assert.equal((await f.call('status')).running,true)
  assert.equal(await f.call('status',{sessionId:'other'}),null)
  await f.finish(1)
  assert.match((await f.call('status')).error,/compile failed/)
  await f.service.dispose()
})
test('reject wrong scope, read-only, binary build, and build outside writable roots',async()=>{
  const f=fixture()
  await assert.rejects(f.call('run',{root:tmpdir()}),/未登记/)
  f.policy({mode:'read-only'});await assert.rejects(f.call('run'),/只读/)
  f.policy({mode:'workspace-write'});f.project.kind='exe';await assert.rejects(f.call('build'),/还原/)
  f.project.kind='pbt';await assert.rejects(f.call('build',{mode:'embedded',directory:join(tmpdir(),'new-pb-build-test')}),/可写范围/)
  assert.equal(f.args(),undefined)
  await f.service.dispose()
})

test('the native exit reason survives diagnostic output', async () => {
  const f = fixture()
  await f.call('run')
  await f.finish(-1073740940) // STATUS_HEAP_CORRUPTION as signed int32
  const {running, error} = await f.call('status')
  assert.equal(running, false)
  assert.match(error, /0xC0000374（Windows 检测到堆损坏）\ncompile failed/)
  await f.service.dispose()
})

test('only the host can allow PB8 temporary run files in a writable PBT directory', async () => {
  for (const writable of [false, true]) {
    const f = fixture(writable)
    f.project.pbVersion = 80
    await f.call('run', { allowLocalRunFiles: !writable })
    assert.equal(f.args().includes('--allow-local-run-files'), writable)
    await f.finish(0)
    await f.service.dispose()
  }
})

test('temp fallback paths come from the sandbox policy, never from run payloads', async () => {
  for (const writable of [false,true]) {
    const f=fixture(writable); await f.call('run',{tempRoot:'untrusted',tempRoots:['untrusted']})
    await f.started
    const args = f.args(), roots = args.filter((_, i) => args[i-1] === '--temp-root')
    assert.equal(roots.includes(tmpdir()), writable)
    assert.ok(!args.includes('untrusted'))
    let scratch
    if (writable && process.platform === 'win32') {
      scratch = roots[0]
      assert.match(basename(scratch), /^world-pb-run-/)
      assert.equal(dirname(scratch), realpathSync.native(tmpdir()))
      assert.ok(existsSync(scratch))
    } else assert.deepEqual(roots, writable ? [tmpdir()] : [])
    await f.finish(1); await f.service.dispose()
    if (scratch) assert.ok(!existsSync(scratch), 'private temp root leaked after a failed run')
  }
})

test('Windows full-access PB9 runs offer LocalLow temp to the worker', {skip: process.platform !== 'win32'}, async () => {
  const f = fixture(); f.policy({mode:'danger-full-access'})
  await f.call('run'); await f.started
  const i = f.args().indexOf('--temp-root')
  assert.equal(f.args()[i+1], resolve(process.env.LOCALAPPDATA, '..', 'LocalLow', 'Temp'))
  await f.finish(0); await f.service.dispose()
})

test('PB diagnostics expose only the worker temp enum and exit facts; existing errors omit the preamble', async () => {
  const f=fixture(false, 'WORLD_PB_TEMP:unavailable\r\nprivate compiler output')
  const first=await f.call('run'); const id=first.diagnostics.id
  assert.equal(first.diagnostics.temp,'unavailable'); assert.ok(first.diagnostics.spawned)
  await f.finish(1); const last=await f.call('status')
  assert.equal(last.diagnostics.id,id); assert.equal(last.diagnostics.exitCode,1); assert.ok(last.diagnostics.elapsedMs>=0)
  assert.ok(!JSON.stringify(last.diagnostics).includes('compiler'));assert.match(last.error,/private compiler output/);assert.doesNotMatch(last.error,/WORLD_PB_TEMP/)
  await f.service.dispose()
})
