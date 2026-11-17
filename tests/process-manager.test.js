import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createProcessCollector, createWorldProcesses, dshProcessTree } from '../process-manager.js'

const row = (pid, parentPid, startedAt = '100', cpuMs = 0) => ({ pid, parentPid, startedAt, cpuMs,
  name: `${pid}.exe`, workingSet: 1048576, privateBytes: 524288, handles: 10, threads: 2 })
const sample = (rows, timestamp = 1000) => ({ rows, timestamp, cores: 4 })
function fixture(collect) {
  return createWorldProcesses({ platform: 'win32', rootPid: 10, collector: { collect, dispose() {} },
    resolveFile: async path => path, inspectFile: async () => ({ isFile: () => true }) })
}

test('process tree excludes other roots, name matches and recycled parent PIDs', () => {
  const rows = [row(10, 1), row(11, 10, '110'), row(12, 11, '120'), row(99, 1), row(15, 10, '090')]
  assert.deepEqual(dshProcessTree(rows, 10).map(item => item.pid), [10, 11, 12])
  assert.deepEqual(dshProcessTree(rows, 10, '099'), [])
})

test('CPU uses deltas, logical cores and process creation time; only DSH contributes totals', async () => {
  let calls = 0
  const manager = fixture(async () => ++calls === 1
    ? sample([row(10, 1, '100', 1000), row(11, 10, '110', 200), row(99, 1, '090', 900000)])
    : sample([row(10, 1, '100', 2000), row(11, 10, '120', 9000)], 2000))
  try {
    const first = await manager.call('snapshot')
    assert.equal(first.totals.cpu, null); assert.equal(first.totals.count, 2)
    assert.equal(first.totals.workingSet, 2097152)
    const second = await manager.call('snapshot')
    assert.equal(second.rows[0].cpu, 25)
    assert.equal(second.rows[1].cpu, null, 'a reused PID starts a fresh CPU sample')
    assert.equal(second.totals.cpu, 25)
  } finally { manager.dispose() }
})

test('concurrent snapshots share one collector and a failed read permits retry', async () => {
  let release, count = 0
  const manager = fixture(() => { count++; return new Promise(resolve => { release = resolve }) })
  try {
    const a = manager.call('snapshot'), b = manager.call('snapshot')
    assert.equal(count, 1)
    release(sample([row(10, 1)])); assert.deepEqual(await a, await b)
  } finally { manager.dispose() }
  let attempt = 0
  const retry = fixture(async () => { if (!attempt++) throw new Error('unavailable'); return sample([row(10, 1)]) })
  try {
    await assert.rejects(retry.call('snapshot'), /unavailable/)
    assert.equal((await retry.call('snapshot')).rootPid, 10)
  } finally { retry.dispose() }
})

test('file lookup returns only current DSH owners and rejects relative paths and write operations', async () => {
  const manager = fixture(async () => ({ ...sample([row(10, 1), row(11, 10, '110'), row(99, 1)]),
    owners: [{ pid: 11, startedAt: '110' }, { pid: 10, startedAt: '090' }, { pid: 99, startedAt: '100' }] }))
  try {
    assert.deepEqual((await manager.call('files', { path: 'C:\\数据\\locked.txt' })).owners,
      [{ pid: 11, startedAt: '110', name: '11.exe' }])
    for (const path of ['', '../file', 'C:\\bad\u0000.txt'])
      await assert.rejects(manager.call('files', { path }), { code: 'WORLD_PROCESSES_PATH' })
    await assert.rejects(manager.call('terminate', { pid: 11 }), /不支持/)
  } finally { manager.dispose() }
})

test('a recycled DSH root fails closed instead of showing unrelated processes', async () => {
  let count = 0
  const manager = fixture(async () => sample([row(10, 1, ++count === 1 ? '100' : '200')]))
  try {
    await manager.call('snapshot')
    await assert.rejects(manager.call('snapshot'), /已退出/)
  } finally { manager.dispose() }
})

test('unsupported platforms refuse before invoking Windows', async () => {
  const manager = createWorldProcesses({ platform: 'freebsd', collector: { collect() { assert.fail('must not spawn') }, dispose() {} } })
  try { await assert.rejects(manager.call('snapshot'), { code: 'WORLD_PROCESSES_UNSUPPORTED' }) }
  finally { manager.dispose() }
})

test('collector passes quoted file paths as base64 data and kills a stalled helper', async () => {
  let spec, killed = 0
  const collector = createProcessCollector({ timeoutMs: 30, spawnProcess(command, args, options) {
    spec = { command, args, options }
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.kill = () => { killed++ }; return child
  } })
  try {
    const path = 'C:\\中文\\a\';&$().txt'
    await assert.rejects(collector.collect('files', { rootPid: 10, path }), /超时/)
    assert.equal(Buffer.from(spec.args.at(-1), 'base64').toString('utf8'), path)
    assert.equal(spec.options.windowsHide, true)
    assert.equal(killed, 1)
  } finally { collector.dispose() }
})

test('real Windows sampling and file ownership stay within an isolated DSH-like process tree', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'world-processes-'))
  const file = join(directory, '占用测试.txt'), ready = join(directory, 'ready')
  await writeFile(file, 'locked')
  // A deliberately isolated root stands in for DSH. A separate process outside that root owns a second file.
  const script = "const fs=require('node:fs');const f=fs.openSync(process.argv[1],'r');fs.writeFileSync(process.argv[2],'ready');setInterval(()=>{},1000)"
  const child = spawn(process.execPath, ['-e', script, file, ready], { windowsHide: true, stdio: 'ignore' })
  const manager = createWorldProcesses({ rootPid: child.pid })
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { const handle = await open(ready); await handle.close(); break }
      catch { await new Promise(resolve => setTimeout(resolve, 30)) }
    }
    const first = await manager.call('snapshot')
    assert.equal(first.rows[0].pid, child.pid)
    assert.equal(first.rows.some(item => item.pid === process.pid), false)
    assert.ok(first.rows.every(item => item.pid === child.pid || item.parentPid === child.pid), 'console helpers must also belong to the isolated root')
    assert.ok(first.rows[0].workingSet > 0)
    const second = await manager.call('snapshot')
    assert.ok(second.rows[0].cpu >= 0)
    const owners = await manager.call('files', { path: file })
    assert.deepEqual(owners.owners.map(item => item.pid), [child.pid])
    const other = join(directory, 'other.txt'); await writeFile(other, 'outside')
    const outsideHandle = await open(other, 'r')
    try { assert.deepEqual((await manager.call('files', { path: other })).owners, []) }
    finally { await outsideHandle.close() }
  } finally {
    manager.dispose()
    const exited = new Promise(resolve => child.once('close', resolve)); child.kill(); await exited
    assert.equal(join(tmpdir(), directory.split(/[\\/]/u).at(-1)), directory)
    await rm(directory, { recursive: true, force: true })
  }
})
