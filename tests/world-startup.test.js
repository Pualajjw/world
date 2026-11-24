import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorldStartup } from '../world-startup.js'
import { createWorldInternet, internetDefaults } from '../internet.js'
import { atomic } from './journal-fixture.mjs'

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'world-startup-')); t.after(()=>rm(dir,{recursive:true,force:true}))
  return {dir,registry:()=>createWorldStartup({dir,atomic})}
}
test('startup decisions survive restart; removing or disabling neither stops apps nor boots them on re-enable',async t=>{
  const {registry}=await fixture(t);const launches=[]
  const boot=async()=>{
    const r=registry()
    for (const [id,initial] of [['lanchat','enabled'],['life','enabled'],['mobile','removed']])
      r.register(id,{name:id,initial,start:()=>launches.push(id)})
    await Promise.all(['lanchat','life','mobile','life'].map(id=>r.run(id))); return r
  }
  const first=await boot();assert.deepEqual(launches.sort(),['lanchat','life'])
  const set=(r,id,state)=>r.call('set',{id,state})
  await Promise.all([set(first,'lanchat','removed'),set(first,'life','disabled'),set(first,'mobile','enabled')]);launches.length=0
  await first.run('mobile');assert.deepEqual(launches,[])
  const second=await boot();assert.deepEqual(launches,['mobile'])
  const list=await second.call('list');assert.deepEqual(list.map(x=>x.state),['removed','disabled','enabled'])
  await assert.rejects(set(second,'unknown','enabled')); await assert.rejects(set(second,'mobile','other'))
  await set(second,'lanchat','enabled');assert.deepEqual(launches,['mobile'])
})
test('EasyTier manager and application use one saved flag; removing it does not remove credentials or expose them',async t=>{
  const {dir,registry}=await fixture(t), r=registry(); const probes={read:async ()=>({connected:true,ipv4:'10.192.168.3'}),invalidate(){},dispose(){}}
  const config={...internetDefaults(),secret:'test-only-private',autoStart:true}
  await writeFile(join(dir,'internet.json'),JSON.stringify(config));const internet=createWorldInternet({dir,startup:r,connectionProbe:probes})
  try {
    await internet.call('clear'); assert.equal((await r.call('list'))[0].state,'enabled')
    for (const next of ['disabled','enabled','removed']) {
      await r.call('set',{id:'internet',state:next});assert.equal((await internet.call('info')).config.autoStart,next==='enabled')
    }
    await internet.call('save',{config:{...config,ipv4:'10.0.0.14'},expectedAutoStart:true})
    assert.equal((await r.call('get',{id:'internet'})).state,'removed')
    assert.equal(JSON.parse(await readFile(join(dir,'internet.json'),'utf8')).secret,config.secret)
  } finally { await internet.dispose() }
  const next=registry(), host=createWorldInternet({dir,startup:next,connectionProbe:probes})
  try {
    const list=await next.call('list');assert.equal(list[0].state,'removed');assert.ok(!JSON.stringify(list).includes(config.secret))
    await host.call('save',{config});assert.equal((await next.call('get',{id:'internet'})).state,'enabled')
  } finally { await host.dispose() }
})
