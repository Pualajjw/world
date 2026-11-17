import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { createWorldUpdates, verifiedWorldArtifact, readDshVersion, pbpkgCaller, compareVersions, WORLD_PACKAGE } from '../updates.js'

const manifest = version => ({ name: WORLD_PACKAGE, version, dsh: { bundle: { patch: './cordis.patch.yml' } } })
const tick = () => new Promise(resolve => setTimeout(resolve, 5))
async function settled(service) {
  for (let i = 0; i < 100; i++) { const state = await service.call('status'); if (state.state !== 'installing') return state; await tick() }
  assert.fail('update did not settle')
}
function fixture(t, options = {}) {
  const calls = [], bundles = [{ name: WORLD_PACKAGE, installed: true, version: '0.2.145' }]
  const manager = {
    listBundles: async () => bundles,
    inspect: async spec => { calls.push(['inspect', spec]); return { status: 'accepted' } },
    installBundle: async (spec, opts) => { calls.push(['install', spec, opts]); return { application: 'restart-required', version: opts.expected.version } },
  }
  const pbpkg = async (op, payload) => {
    calls.push([op, payload])
    if (op === 'list') return { rows: [{ filename: 'world-0.2.150-universal.tgz', path: 'world/world-0.2.150-universal.tgz', sha256: 'abc', sourceId: 'local' }],
      activeSourceId: 'local', sources: [{ id: 'local', name: '本地插件源' }] }
    return { spec: 'file:C:/cache/test.tgz', sha256: 'abc', size: 10 }
  }
  const service = createWorldUpdates({ currentVersion: '0.2.145', manager, readVersion: async () => '0.2.2-rc.3', pbpkg,
    fetchJson: async url => { calls.push(['github', url]); return url.includes('/commits/') ? { sha: 'a'.repeat(40) } : manifest('0.2.150') },
    verifyArtifact: async artifact => ({ manifest: manifest('0.2.150'), spec: artifact.spec }), ...options })
  t.after(() => service.dispose())
  return { service, calls, bundles, manager }
}

test('main version is read from the current DSH anchor, never Electron or an unrelated package', async () => {
  assert.equal(await readDshVersion({ installAnchor: '/runtime/package.json' }, { readText: async file => {
    assert.equal(file, '/runtime/package.json'); return JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' })
  } }), '0.2.2-rc.3')
  assert.equal(await readDshVersion(null), null)
  assert.equal(await readDshVersion({ installAnchor: 'x' }, { readText: async () => '{"name":"electron","version":"44.0.0"}' }), null)
  assert.equal(compareVersions('0.2.146', '0.2.145'), 1)
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.2'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.10'), 1)
  assert.equal(compareVersions('1.0.0+build', '1.0.0'), 0)
})

test('without installed pbpkg, GitHub version is pinned to one checked commit and install checks expected package', async t => {
  const f = fixture(t)
  const info = await f.service.call('info'); assert.equal(info.source, 'github'); assert.equal(info.dshVersion, '0.2.2-rc.3')
  const checked = await f.service.call('check')
  assert.equal(checked.available, true)
  assert.ok(f.calls[1][1].includes('/' + 'a'.repeat(40) + '/package.json'))
  await assert.rejects(f.service.call('install', { token: checked.token }), /失效/u)
  const result = await f.service.call('install', { token: checked.token, confirmed: true })
  assert.equal(result.state, 'installing'); assert.equal((await settled(f.service)).state, 'success')
  const installed = f.calls.find(call => call[0] === 'install')
  assert.equal(installed[1], 'git+https://github.com/Pualajjw/world.git#' + 'a'.repeat(40))
  assert.deepEqual(installed[2].expected, { name: WORLD_PACKAGE, version: '0.2.150' })
  await assert.rejects(f.service.call('install', { token: checked.token, confirmed: true }), /失效/u)
})

test('installed pbpkg selects its active source, and disabled/missing package failures never fall back to GitHub', async t => {
  const f = fixture(t)
  f.bundles.push({ name: '@local/dsh-pbpkg', installed: true, enabled: true })
  const result = await f.service.call('check')
  assert.equal(result.source, 'pbpkg'); assert.equal(result.sourceName, 'pbpkg · 本地插件源')
  assert.deepEqual(f.calls.map(call => call[0]), ['list', 'prepare'])
  assert.deepEqual(f.calls[1][1], { path: 'world/world-0.2.150-universal.tgz', sourceId: 'local' })
  f.bundles[1].enabled = false
  await assert.rejects(f.service.call('check'), /启用 pbpkg/u)
  assert.equal(f.calls.some(call => call[0] === 'github'), false)
  const missing = fixture(t, { pbpkg: async () => ({ rows: [] }) })
  missing.bundles.push({ name: '@local/dsh-pbpkg', installed: true })
  await assert.rejects(missing.service.call('check'), /没有 world/u)
  assert.equal(missing.calls.length, 0)
})

test('simultaneous installs share the synchronous guard, failed installs retain an error and a new check allows retry', async t => {
  const f = fixture(t)
  let release
  f.manager.installBundle = async (spec, options) => { f.calls.push(['install', spec, options]); return new Promise(resolve => { release = resolve }) }
  const checked = await f.service.call('check')
  const a = f.service.call('install', { token: checked.token, confirmed: true })
  const b = f.service.call('install', { token: checked.token, confirmed: true })
  await assert.rejects(b, { code: 'WORLD_UPDATE_BUSY' }); await a
  while (!release) await tick()
  await assert.rejects(f.service.call('check'), { code: 'WORLD_UPDATE_BUSY' })
  release({ application: 'failed', error: { diagnostic: 'download failed' } })
  assert.match((await settled(f.service)).message, /download failed/u)
  assert.equal(f.calls.filter(call => call[0] === 'install').length, 1)
  assert.equal((await f.service.call('check')).available, true)
})

test('older/equal versions, changed sources, expired candidates and wrong GitHub package cannot install', async t => {
  let now = Date.now()
  const f = fixture(t, { now: () => now })
  const checked = await f.service.call('check')
  now += 11 * 60000
  await assert.rejects(f.service.call('install', { token: checked.token, confirmed: true }), /失效/u)
  const again = await f.service.call('check')
  f.bundles.push({ name: '@local/dsh-pbpkg', installed: true })
  await assert.rejects(f.service.call('install', { token: again.token, confirmed: true }), /来源已变化/u)
  const old = fixture(t, { fetchJson: async url => url.includes('/commits/') ? { sha: 'a'.repeat(40) } : manifest('0.2.144') })
  assert.equal((await old.service.call('check')).available, false)
  const bad = fixture(t, { fetchJson: async url => url.includes('/commits/') ? { sha: 'a'.repeat(40) } : { ...manifest('0.2.150'), name: '@evil/other' } })
  await assert.rejects(bad.service.call('check'), /更新包/u)
  assert.equal(bad.calls.length, 0)
})

test('pbpkg bridge uses only existing list/prepare endpoints and a trusted owner, with structured response validation', async () => {
  const peer = { principal: { kind: 'owner' } }
  const call = pbpkgCaller({ browserPeer: peer, createSharedFetchHandler(channel) {
    assert.equal(channel, '/api')
    return { async fetch(request, owner) {
      assert.equal(owner, peer); assert.equal(new URL(request.url).pathname, '/api/pbpkg/list')
      const body = await request.json()
      return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { rows: [] } } })
    } }
  } })
  assert.deepEqual(await call('list', {}), { rows: [] })
})

test('TGZ verification rejects tampering and foreign packages; pbpkg installation receives only the verified file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'world-updates-'))
  t.after(async () => { assert.equal(dirname(directory), tmpdir()); assert.ok(basename(directory).startsWith('world-updates-')); await rm(directory, { recursive: true, force: true }) })
  const make = async value => {
    const payload = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(512)
    header.write('package/package.json'); header.write(payload.length.toString(8).padStart(11, '0'), 124); header[156] = 48
    const tgz = gzipSync(Buffer.concat([header, payload, Buffer.alloc((512 - payload.length % 512) % 512), Buffer.alloc(1024)]))
    const sha256 = createHash('sha256').update(tgz).digest('hex'), file = join(directory, sha256 + '.tgz')
    await writeFile(file, tgz)
    return { spec: `file:${file.replaceAll('\\', '/')}`, sha256, size: tgz.length }
  }
  const artifact = await make(manifest('0.2.150'))
  assert.equal((await verifiedWorldArtifact(artifact, directory)).manifest.version, '0.2.150')
  const bad = await make({ ...manifest('0.2.151'), name: 'other' })
  await assert.rejects(verifiedWorldArtifact(bad, directory), /更新包/u)
  await writeFile(artifact.spec.slice(5), 'broken')
  await assert.rejects(verifiedWorldArtifact(artifact, directory), /校验/u)
  const good = await make(manifest('0.2.150'))
  const f = fixture(t, { cacheDir: directory, verifyArtifact: verifiedWorldArtifact, pbpkg: async op => op === 'list'
    ? { rows: [{ ...good, filename: 'world-0.2.150-universal.tgz', path: 'world.tgz' }], activeSourceId: 'local' } : good })
  f.bundles.push({ name: '@local/dsh-pbpkg', installed: true, enabled: true })
  const checked = await f.service.call('check')
  await f.service.call('install', { token: checked.token, confirmed: true })
  assert.equal((await settled(f.service)).state, 'success')
  assert.equal(f.calls.find(call => call[0] === 'install')[1], good.spec)
})

test('development links refuse self-upgrade before the native installer can change their source', async t => {
  const f = fixture(t)
  f.bundles[0].source = 'link:E:/source/world'
  const info = await f.service.call('info')
  assert.equal(info.canInstall, false); assert.match(info.blockReason, /开发目录链接/u)
  const checked = await f.service.call('check')
  await assert.rejects(f.service.call('install', { token: checked.token, confirmed: true }), /开发目录链接/u)
  assert.equal(f.calls.some(call => call[0] === 'install'), false)
})
