import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { publishWorldIndex } from '../package-index.mjs'
import { createWorldUpdates, WORLD_PACKAGE } from '../updates.js'
import { createCatalog } from '../../pbpkg/catalog.js'

const manifest = { name: WORLD_PACKAGE, version: '0.2.170', meta: { title: 'world' }, description: 'fixture', dsh: { bundle: { patch: './cordis.patch.yml' } } }
async function setup(t) {
  const folder = await mkdtemp(join(tmpdir(), 'world-index-')), root = join(folder, 'world')
  t.after(async () => {
    assert.equal(dirname(folder), tmpdir()); assert.ok(basename(folder).startsWith('world-index-'))
    await rm(folder, { recursive: true, force: true })
  })
  await mkdir(join(root, 'dist'), { recursive: true })
  const index = { schema: 1, packages: {
    world: { type: 'tgz', path: 'world/dist/world-0.2.168-universal.tgz', size: 100, sha256: 'a'.repeat(64), description: 'old' },
    other: { type: 'tgz', path: 'other/keep.tgz', size: 200, sha256: 'b'.repeat(64), description: 'keep' },
  } }
  const original = JSON.stringify(index, null, 2) + '\n'
  await writeFile(join(folder, 'index.json'), original)
  return { folder, root, index, original }
}
function archive(value) {
  const payload = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(512)
  header.write('package/package.json'); header.write(payload.length.toString(8).padStart(11, '0'), 124); header[156] = 48
  return gzipSync(Buffer.concat([header, payload, Buffer.alloc((512 - payload.length % 512) % 512), Buffer.alloc(1024)]))
}

test('packaging repairs a stale real pbpkg source and preserves every other index entry', async t => {
  const { folder, root, index } = await setup(t)
  const source = { id: 'local', name: '开发路径', type: 'local', location: folder, indexPath: 'index.json' }
  const cacheDir = join(folder, 'cache')
  const catalog = createCatalog({ cacheDir }, () => assert.fail('local source must not use the network'), {
    list: async () => ({ activeSourceId: source.id, sources: [source] }), get: async () => source, active: async () => source,
  })
  const service = createWorldUpdates({ currentVersion: '0.2.167', cacheDir, readVersion: async () => '0.2.2-rc.3',
    manager: { listBundles: async () => [{ name: WORLD_PACKAGE, installed: true, version: '0.2.167' }, { name: '@local/dsh-pbpkg', installed: true }] },
    pbpkg: (op, payload, signal) => op === 'list' ? catalog.listing(signal) : catalog.prepare(payload.path, signal, payload.sourceId),
    fetchJson: () => assert.fail('missing local packages must not switch to GitHub'),
  })
  t.after(() => { service.dispose(); catalog.dispose() })
  await assert.rejects(service.call('check'), { code: 'WORLD_UPDATE_SOURCE_INCOMPLETE' })
  const bytes = archive(manifest)
  await writeFile(join(root, 'dist/world-0.2.170-universal.tgz'), bytes)
  await publishWorldIndex(root, manifest)
  const updated = JSON.parse(await readFile(join(folder, 'index.json'), 'utf8'))
  assert.deepEqual(updated.packages.other, index.packages.other)
  assert.equal(updated.packages.world.path, 'world/dist/world-0.2.170-universal.tgz')
  assert.equal(updated.packages.world.size, bytes.length)
  assert.equal(updated.packages.world.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal((await readdir(folder)).some(name => name.endsWith('.tmp')), false)
  const checked = await service.call('check')
  assert.equal(checked.available, true)
  assert.equal(checked.latestVersion, manifest.version)
  assert.equal(checked.sourceName, 'pbpkg · 开发路径')
})

test('missing output or a foreign world index never overwrites the existing source', async t => {
  const { folder, root, index, original } = await setup(t)
  await assert.rejects(publishWorldIndex(root, manifest), { code: 'ENOENT' })
  assert.equal(await readFile(join(folder, 'index.json'), 'utf8'), original)
  index.packages.world.path = 'another-world/dist/world-0.2.168-universal.tgz'
  const foreign = JSON.stringify(index)
  await writeFile(join(folder, 'index.json'), foreign)
  await assert.rejects(publishWorldIndex(root, manifest), /不属于当前 dist/u)
  assert.equal(await readFile(join(folder, 'index.json'), 'utf8'), foreign)
})

test('a standalone checkout does not create or claim a parent catalog', async t => {
  const { folder, root } = await setup(t)
  await rm(join(folder, 'index.json'))
  assert.equal(await publishWorldIndex(root, manifest), null)
  await writeFile(join(folder, 'index.json'), '{"schema":1,"packages":{}}')
  assert.equal(await publishWorldIndex(root, manifest), null)
  assert.equal(await readFile(join(folder, 'index.json'), 'utf8'), '{"schema":1,"packages":{}}')
})
