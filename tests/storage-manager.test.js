import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, utimes, link, symlink, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { createWorldStorage, storageRootCandidates } from '../storage-manager.js'

const OLD = new Date(Date.now() - 30 * 86400000)
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'world-storage-'))
  const roots = ['install', 'home', 'desktop'].map(kind => ({ id: kind, kind, group: kind === 'install' ? 'install' : 'user', label: kind, path: join(directory, kind) }))
  for (const root of roots) await mkdir(root.path)
  const service = createWorldStorage({ roots: () => roots, ...options })
  t.after(async () => { service.dispose(); assert.equal(dirname(directory), tmpdir()); assert.ok(basename(directory).startsWith('world-storage-')); await rm(directory, { recursive: true, force: true }) })
  const file = async (relative, source, old = true) => {
    const path = join(directory, relative); await mkdir(dirname(path), { recursive: true }); await writeFile(path, source)
    if (old) await utimes(path, OLD, OLD)
    return path
  }
  return { directory, roots, service, file }
}
async function finished(service, jobId) {
  for (let index = 0; index < 1000; index++) {
    const job = await service.call('status', { jobId })
    if (job.state !== 'running') { assert.notEqual(job.state, 'error', job.error); return job }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('storage job timed out')
}
const scan = async service => (await finished(service, (await service.call('start')).jobId)).result

test('platform roots honor DSH_HOME, XDG, AppImage and macOS bundles without scanning Node or the home directory', () => {
  const windows = storageRootCandidates({ platform: 'win32', home: 'C:\\Users\\a', env: { DSH_HOME: 'D:\\dsh-data', APPDATA: 'D:\\roaming' }, executable: 'C:\\DSH\\DeepSeek Harness.exe', electron: true })
  assert.equal(windows[0].path, 'C:\\DSH'); assert.equal(windows[1].path, 'D:\\dsh-data')
  assert.equal(windows[2].path, 'D:\\roaming\\@deepseek-ai\\dsh-desktop')
  const linux = storageRootCandidates({ platform: 'linux', home: '/home/a', executable: '/tmp/.mount/dsh', electron: true,
    env: { APPIMAGE: '/opt/DSH.AppImage', XDG_CONFIG_HOME: '/data/config' } })
  assert.equal(linux[0].file, true); assert.equal(linux[0].path, '/opt/DSH.AppImage'); assert.equal(linux[2].path, '/data/config/@deepseek-ai/dsh-desktop')
  const mac = storageRootCandidates({ platform: 'darwin', home: '/Users/a', env: {}, electron: true, executable: '/Applications/DSH.app/Contents/MacOS/DSH' })
  assert.equal(mac[0].path, '/Applications/DSH.app'); assert.equal(mac[2].path, '/Users/a/Library/Application Support/@deepseek-ai/dsh-desktop')
  const cli = storageRootCandidates({ platform: 'linux', home: '/home/a', env: { DSH_HOME: '/home/a' }, electron: false, executable: '/usr/bin/node' })
  assert.equal(cli.some(root => root.id === 'install' || root.id === 'home'), false)
})

test('inventory totals, directory details and cleanup preserve user data, recent files, hardlinks and symlink targets', async t => {
  const f = await fixture(t)
  await f.file('install/app.bin', '12345')
  await f.file('home/sessions/history.jsonl', 'keep-session')
  await f.file('home/attachments/v1/data/original', 'keep-original')
  await f.file('desktop/Local Storage/preferences', 'keep-settings')
  const cached = await f.file('home/cache/attachments/request-images/aa/image', '1234567890')
  const log = await f.file('home/logs/old.log', 'old-log')
  const recent = await f.file('home/logs/current.log', 'recent', false)
  const linked = await f.file('home/logs/linked.log', 'hardlink')
  await link(linked, join(f.directory, 'home/logs/linked-again.log'))
  await f.file('outside/secret.log', 'do not touch')
  await symlink(join(f.directory, 'outside'), join(f.directory, 'home/logs/junction'), process.platform === 'win32' ? 'junction' : 'dir')
  const data = await scan(f.service)
  assert.equal(data.totals.install, 5); assert.equal(data.totals.reclaimable, 17)
  assert.equal(data.totals.user, 12 + 13 + 13 + 10 + 7 + 6 + 8)
  const list = await f.service.call('list', { scanId: data.scanId, rootId: 'home', query: 'sessions' })
  assert.ok(list.items.some(item => item.name === 'history.jsonl'))
  assert.equal(list.items.some(item => item.name === 'secret.log'), false)
  const preview = await f.service.call('preview', { scanId: data.scanId, ruleIds: ['images', 'logs'] })
  assert.equal(preview.bytes, 17); assert.equal(preview.count, 2)
  await assert.rejects(f.service.call('start', { mode: 'cleanup', token: preview.token }), /确认/u)
  const result = await finished(f.service, (await f.service.call('start', { mode: 'cleanup', token: preview.token, confirmed: true })).jobId)
  assert.equal(result.result.bytes, 17); assert.equal(result.result.removed, 2)
  for (const path of [cached, log]) await assert.rejects(lstat(path), { code: 'ENOENT' })
  assert.equal(await readFile(recent, 'utf8'), 'recent')
  assert.equal(await readFile(linked, 'utf8'), 'hardlink')
  assert.equal(await readFile(join(f.directory, 'outside/secret.log'), 'utf8'), 'do not touch')
  assert.equal(await readFile(join(f.directory, 'home/sessions/history.jsonl'), 'utf8'), 'keep-session')
  await assert.rejects(f.service.call('start', { mode: 'cleanup', token: preview.token, confirmed: true }), /失效/u)
})

test('cleanup skips files changed after preview, rejects forged categories and expired plans', async t => {
  let time = Date.now()
  const f = await fixture(t, { now: () => time })
  const file = await f.file('home/logs/a.log', 'old')
  let data = await scan(f.service)
  await assert.rejects(f.service.call('preview', { scanId: data.scanId, ruleIds: ['../sessions'] }), /类别/u)
  let plan = await f.service.call('preview', { scanId: data.scanId, ruleIds: ['logs'] })
  await writeFile(file, 'new user data')
  const result = (await finished(f.service, (await f.service.call('start', { mode: 'cleanup', token: plan.token, confirmed: true })).jobId)).result
  assert.equal(result.removed, 0); assert.equal(result.skipped, 1)
  assert.equal(await readFile(file, 'utf8'), 'new user data')
  await utimes(file, OLD, OLD); data = await scan(f.service)
  plan = await f.service.call('preview', { scanId: data.scanId, ruleIds: ['logs'] })
  time += 6 * 60000
  await assert.rejects(f.service.call('start', { mode: 'cleanup', token: plan.token, confirmed: true }), /失效/u)
})

test('replaced ancestor junction cannot redirect cleanup outside the recorded root', async t => {
  const f = await fixture(t)
  await f.file('home/logs/a.log', 'old'); const outside = await f.file('outside/a.log', 'protected')
  const data = await scan(f.service), plan = await f.service.call('preview', { scanId: data.scanId, ruleIds: ['logs'] })
  const logs = join(f.directory, 'home/logs')
  assert.ok(logs.startsWith(f.directory + (process.platform === 'win32' ? '\\' : '/')))
  await rm(logs, { recursive: true }); await symlink(dirname(outside), logs, process.platform === 'win32' ? 'junction' : 'dir')
  const result = (await finished(f.service, (await f.service.call('start', { mode: 'cleanup', token: plan.token, confirmed: true })).jobId)).result
  assert.equal(result.removed, 0); assert.equal(result.skipped, 1); assert.equal(await readFile(outside, 'utf8'), 'protected')
})

test('scan cancellation, limits, missing roots and overlapping roots produce explicit partial results', async t => {
  const f = await fixture(t, { maxEntries: 3 })
  for (let i = 0; i < 10; i++) await f.file(`home/logs/${i}.log`, 'old')
  f.roots.push({ ...f.roots[1], id: 'duplicate' }, { ...f.roots[1], id: 'missing', path: join(f.directory, 'missing') })
  const data = await scan(f.service)
  assert.equal(data.partial, true); assert.ok(data.warnings.length)
  assert.equal(data.roots.find(root => root.id === 'duplicate').state, 'overlap')
  assert.equal(data.roots.find(root => root.id === 'missing').state, 'missing')
  const { jobId } = await f.service.call('start')
  await assert.rejects(f.service.call('start'), { code: 'WORLD_STORAGE_BUSY' })
  await f.service.call('cancel', { jobId }); assert.equal((await finished(f.service, jobId)).state, 'cancelled')
})

test('locked files are reported as skipped without claiming their bytes were released', async t => {
  const f = await fixture(t, { removeFile: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) } })
  await f.file('home/logs/a.log', 'old')
  const data = await scan(f.service), plan = await f.service.call('preview', { scanId: data.scanId, ruleIds: ['logs'] })
  const result = (await finished(f.service, (await f.service.call('start', { mode: 'cleanup', token: plan.token, confirmed: true })).jobId)).result
  assert.equal(result.bytes, 0); assert.equal(result.skipped, 1); assert.equal(result.failures[0].reason, 'EBUSY')
})

test('AppImage inventory exposes its one file and cleanup cancellation retains partial results without replay', async t => {
  let release, entered
  const pending = new Promise(resolve => { entered = resolve })
  const f = await fixture(t, { removeFile: async file => {
    entered(); await new Promise(resolve => { release = resolve }); await rm(file)
  } })
  const image = await f.file('DSH.AppImage', 'appimage')
  f.roots[0] = { ...f.roots[0], path: image, file: true }
  await f.file('home/logs/a.log', 'aaa'); await f.file('home/logs/b.log', 'bbbb')
  const data = await scan(f.service)
  assert.equal(data.totals.install, 8)
  const listing = await f.service.call('list', { scanId: data.scanId, rootId: 'install' })
  assert.equal(listing.items.length, 1); assert.equal(listing.items[0].type, 'file')
  const plan = await f.service.call('preview', { scanId: data.scanId, ruleIds: ['logs'] })
  const { jobId } = await f.service.call('start', { mode: 'cleanup', token: plan.token, confirmed: true })
  await pending
  await assert.rejects(f.service.call('start', { mode: 'cleanup', token: plan.token, confirmed: true }), { code: 'WORLD_STORAGE_BUSY' })
  await f.service.call('cancel', { jobId }); release()
  const result = await finished(f.service, jobId)
  assert.equal(result.state, 'cancelled'); assert.equal(result.result.removed, 1)
  const after = await scan(f.service)
  assert.equal(after.rules.find(rule => rule.id === 'logs').count, 1)
})
