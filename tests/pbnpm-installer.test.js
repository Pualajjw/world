import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { createCatalog } from '../../pbpkg/catalog.js'
import { createPbnpmInstaller } from '../pbnpm-installer.js'

async function fixture(t, { name = '@local/dsh-pbnpm', dev = true, inspect = () => ({ status: 'accepted' }) } = {}) {
  const parent = await realpath(tmpdir()), home = await mkdtemp(join(parent, 'pbnpm-catalog-'))
  t.after(async () => { assert.equal(dirname(home), parent); assert.match(basename(home), /^pbnpm-catalog-/); await rm(home, { recursive: true, force: true }) })
  const version = '0.8.4', payload = Buffer.from(JSON.stringify({ name, version, dsh: { bundle: { patch: './patch.yml' } } }))
  const header = Buffer.alloc(512); header.write('package/package.json'); header.write(payload.length.toString(8).padStart(11, '0'), 124); header[156] = 48
  const bytes = gzipSync(Buffer.concat([header, payload, Buffer.alloc(1536 - payload.length)]))
  const row = { type: 'tgz', path: `p/pbnpm/pbnpm-${version}-win32-x86.tgz`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  const index = { schema: 1, packages: { pbd: { ...row, path: `p/pbnpm-pbd/pbnpm-pbd-9.9.9-win32-x86.tgz` }, pbnpm: row } }
  const bytesIndex = Buffer.from(JSON.stringify(index)), cache = join(home, 'pbpkg/tarballs'), calls = [], bundles = dev ? [{ name: '@local/dsh-pbpkg', installed: true }] : []
  await mkdir(join(home, 'p/pbnpm'), { recursive: true }); await writeFile(join(home, row.path), bytes); await writeFile(join(home, 'index.json'), bytesIndex)
  const devSource = { id: 'dev', name: '开发源', type: 'local', location: home, indexPath: 'index.json' }
  const catalog = createCatalog({ cacheDir: cache }, assert.fail, { get: async id => id === 'dev' && devSource })
  t.after(() => catalog.dispose())
  const service = createPbnpmInstaller({ home, profile: () => null, manager: () => ({ listBundles: () => bundles,
    inspect, installBundle: async (spec, opts) => {
      calls.push({ op: 'install', spec, opts }); const installed = bundles.find(b => b.name === name)
      if (installed) installed.source = spec; else bundles.push({ name, installed: true, source: spec, version }); return { application: 'restart-required' }
    } }), pbpkg: async (op, args, signal) => { calls.push({ op, args }); return op === 'sources'
      ? { activeSourceId: 'official', sources: [{ id: 'official', type: 'git' }, devSource] }
      : catalog.prepare(args.path, signal, args.sourceId) },
    download: async path => { calls.push({ op: 'gitee', path }); return path === 'index.json' ? bytesIndex : bytes },
  }); t.after(() => service.dispose()); return { service, calls, bundles, home, row }
}

test('prefers even an inactive local pbpkg source, confirms the version and actually resubmits a same-version reinstall', async t => {
  const { service, calls, row } = await fixture(t)
  const plan = await service.call('prepare'); assert.equal(plan.source, '开发 pbpkg · 开发源'); assert.equal(plan.version, '0.8.4')
  assert.deepEqual(calls.find(c => c.op === 'prepare').args, { path: row.path, sourceId: 'dev' })
  await assert.rejects(service.call('install', { token: plan.token }), /过期/)
  const confirm = { confirmed: true, token: plan.token }; await service.call('install', confirm)
  await assert.rejects(service.call('install', confirm), /过期/)
  const reinstall = await service.call('prepare'); assert.equal(reinstall.installedVersion, plan.version)
  await service.call('install', { ...confirm, token: reinstall.token }); const applied = calls.filter(c => c.op === 'install')
  assert.deepEqual(applied.map(c => c.opts.enabled), [true, true]); assert.notEqual(applied[0].spec, applied[1].spec)
  assert.deepEqual(applied[1].opts.expected, { name: '@local/dsh-pbnpm', version: plan.version })
  assert.equal(calls.some(c => c.op === 'gitee'), false)
})
test('missing development TGZ uses the Gitee index, then downloads only the exact pbnpm archive after confirmation', async t => {
  const { service, calls, home, row } = await fixture(t); await rm(join(home, row.path))
  const plan = await service.call('prepare'); assert.equal(plan.source, 'Gitee 直连'); assert.equal(calls.at(-1).path, 'index.json')
  await service.call('install', { token: plan.token, confirmed: true })
  assert.deepEqual(calls.filter(c => c.op === 'gitee').map(c => c.path), ['index.json', row.path])
})
test('an archive for a different plugin fails verification without installing or silently changing source', async t => {
  const { service, calls } = await fixture(t, { name: '@local/dsh-pbnpm-pbd' }); const plan = await service.call('prepare')
  await assert.rejects(service.call('install', { token: plan.token, confirmed: true }), /更新包的名称/)
  assert.equal(calls.some(c => c.op === 'install' || c.op === 'gitee'), false)
})

test('reinstall preserves a disabled bundle; changing its state invalidates confirmation', async t => {
  const { service, calls, bundles } = await fixture(t)
  const bundle = { name: '@local/dsh-pbnpm', installed: true, enabled: false, version: '0.8.4' }; bundles.push(bundle)
  assert.equal((await service.call('info')).enabled, false)
  const plan = await service.call('prepare'); assert.equal(plan.enabled, false)
  const result = await service.call('install', { confirmed: true, token: plan.token })
  assert.equal(result.enabled, false); assert.equal(calls.find(c => c.op === 'install').opts.enabled, false)
  const stale = await service.call('prepare'); bundle.enabled = true
  await assert.rejects(service.call('install', { confirmed: true, token: stale.token }), /状态已变化/)
  assert.equal(calls.filter(c => c.op === 'install').length, 1)
})
test('disabling pbnpm during inspection cannot be undone by the pending reinstall', async t => {
  const bundle = { name: '@local/dsh-pbnpm', installed: true, enabled: true, version: '0.8.4' }
  const { service, bundles, calls } = await fixture(t, { inspect: () => { bundle.enabled = false; return { status: 'accepted' } } })
  bundles.push(bundle)
  const plan = await service.call('prepare')
  await assert.rejects(service.call('install', { confirmed: true, token: plan.token }), /状态已变化/)
  assert.equal(calls.some(c => c.op === 'install'), false)
})
test('malformed development rows neither poison a valid sibling nor block Gitee fallback', async t => {
  const { service, calls, home, row } = await fixture(t)
  const writeIndex = packages => writeFile(join(home, 'index.json'), JSON.stringify({ schema: 1, packages }))
  const broken = { pathType: { ...row, path: 42 }, badHash: { ...row, path: row.path.replace('0.8.4','9.1.0'), sha256: '' },
    badSize: { ...row, path: row.path.replace('0.8.4','9.2.0'), size: 0 } }
  await writeIndex({ ...broken, pbnpm: row })
  const dev = await service.call('prepare'); assert.equal(dev.source, '开发 pbpkg · 开发源'); assert.equal(dev.version, '0.8.4')
  await service.call('install', { confirmed: true, token: dev.token }); assert.equal(calls.some(c => c.op === 'gitee'), false)
  await writeIndex(broken)
  const fallback = await service.call('prepare'); assert.equal(fallback.source, 'Gitee 直连')
  await service.call('install', { confirmed: true, token: fallback.token })
  assert.deepEqual(calls.filter(c => c.op === 'gitee').map(c => c.path), ['index.json', row.path])
})
test('conflicting aliases for the selected archive still fail closed', async t => {
  const { service, calls, home, row } = await fixture(t)
  await writeFile(join(home, 'index.json'), JSON.stringify({ schema: 1, packages: { pbnpm: row, alias: { ...row, size: row.size + 1 } } }))
  await assert.rejects(service.call('prepare'), /索引存在冲突/)
  assert.equal(calls.some(c => c.op === 'gitee' || c.op === 'install'), false)
})
