import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { createDesktopBrain } from '../desktop-brain.js'
import { DEFAULT_BACKGROUND, workbenchProfile } from '../workbench-profile.js'
import { atomic } from './journal-fixture.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'world-brain-'))
  t.after(async () => {
    assert.equal(dirname(directory), tmpdir())
    assert.ok(basename(directory).startsWith('world-brain-'))
    await rm(directory, { recursive: true, force: true })
  })
  const file = join(directory, 'brain.json')
  const ctx = { sessions: { get: id => ['a', 'b'].includes(id) ? {} : null } }
  return { file, ctx }
}

test('one persistent brain wins concurrent first bindings and survives Host recreation', async t => {
  const { file, ctx } = await fixture(t)
  const a = createDesktopBrain(ctx, { file }), b = createDesktopBrain(ctx, { file })
  assert.equal((await a.get()).sessionId, null)
  const [first, second] = await Promise.all([a.call('configure', { sessionId: 'a' }), b.call('configure', { sessionId: 'b' })])
  assert.deepEqual(first, second)
  const restarted = createDesktopBrain(ctx, { file })
  assert.deepEqual(await restarted.get(), first)
  assert.deepEqual(await restarted.call('bind', { sessionId: first.sessionId === 'a' ? 'b' : 'a' }), first)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).sessionId, first.sessionId)
})

test('a corrupt brain binding fails without replacing the assistant identity', async t => {
  const { file, ctx } = await fixture(t)
  await writeFile(file, '{broken')
  const brain = createDesktopBrain(ctx, { file })
  await assert.rejects(brain.call('bind', { sessionId: 'b' }), { code: 'WORLD_DESKTOP_BRAIN' })
  assert.equal(await readFile(file, 'utf8'), '{broken')
})

test('a deleted assistant session blocks handoff rather than binding the newly visible session', async t => {
  const { file, ctx } = await fixture(t)
  const original = createDesktopBrain(ctx, { file })
  await original.call('configure', { sessionId: 'a' })
  const restored = createDesktopBrain({ sessions: { get: id => id === 'b' ? {} : null },
    sessionController: { inspect: async () => { throw new Error('not found') } } }, { file })
  await assert.rejects(restored.call('bind', { sessionId: 'b' }), { code: 'WORLD_DESKTOP_BRAIN' })
  assert.equal((await restored.get()).sessionId, 'a')
})

test('legacy identity requires setup, stores background once, and retains that session', async t => {
  const { file, ctx } = await fixture(t)
  await writeFile(file, JSON.stringify({ sessionId: 'a' }))
  const brain = createDesktopBrain(ctx, { file })
  assert.equal((await brain.get()).setupRequired, true)
  await assert.rejects(brain.call('bind', { sessionId: 'b' }), { code: 'WORLD_DESKTOP_SETUP_REQUIRED' })
  const configured = await brain.call('configure', { sessionId: 'b', background: '认真打磨我的 world 工作台。' })
  assert.equal(configured.sessionId, 'a')
  assert.equal(configured.profile.background, '认真打磨我的 world 工作台。')
  assert.equal(configured.setupRequired, false)
  const later = await createDesktopBrain(ctx, { file }).call('configure', { sessionId: 'b', background: '不能替换' })
  assert.deepEqual(later, configured)
})

test('invalid profile does not bind a brain; omitted background uses the default', async t => {
  const { file, ctx } = await fixture(t)
  const brain = createDesktopBrain(ctx, { file })
  await assert.rejects(brain.call('configure', { sessionId: 'a', background: '' }), { code: 'WORLD_DESKTOP_PROFILE' })
  assert.equal((await brain.get()).sessionId, null)
  const configured = await brain.call('configure', { sessionId: 'a' })
  assert.equal(configured.profile.background, DEFAULT_BACKGROUND)
})

test('legacy profiles gain defaults in memory without rewriting their file or background', async t => {
  const { file, ctx } = await fixture(t)
  const original = JSON.stringify({ sessionId: 'a', profile: { version: 1, background: '保留我的背景。' }, extension: { keep: true } })
  await writeFile(file, original)
  const brain = createDesktopBrain(ctx, { file, atomic })
  const info = await brain.get()
  assert.deepEqual(info.profile, { version: 3, background: '保留我的背景。', name: '助手', userName: '', tone: 'natural',
    wakeTime: '09:00', reviewTime: '23:00', life: true }, '作息有默认值，旧配置不需要迁移')
  assert.equal(info.revision, 0)
  assert.equal(await readFile(file, 'utf8'), original)
})

test('preferences can precede first handoff, survive restart and attach to exactly one session', async t => {
  const { file, ctx } = await fixture(t)
  const brain = createDesktopBrain(ctx, { file, atomic })
  const saved = await brain.call('update_profile', { expectedRevision: 0, expectedSessionId: null,
    profile: { name: '小舟', userName: '朋友', tone: 'concise', background: '一起照料工作台。' } })
  assert.equal(saved.sessionId, null)
  assert.equal(saved.setupRequired, false)
  const restarted = createDesktopBrain(ctx, { file, atomic })
  assert.deepEqual(await restarted.get(), saved)
  const bound = await restarted.call('bind', { sessionId: 'a' })
  assert.equal(bound.sessionId, 'a')
  assert.equal(bound.revision, saved.revision + 1)
  assert.deepEqual(bound.profile, saved.profile)
  assert.deepEqual(await restarted.call('bind', { sessionId: 'b' }), bound)
  assert.equal(await restarted.call('configure', { sessionId: 'b', background: '不能替换' }).then(value => value.profile.name), '小舟')
})

test('editing a bound profile keeps identity and extensions, without prompting any session', async t => {
  const { file, ctx } = await fixture(t)
  let prompts = 0
  ctx.sessionController = { prompt() { prompts++ }, inspect() { throw new Error('should not inspect on edit') } }
  await writeFile(file, JSON.stringify({ sessionId: 'a', profile: { version: 1, background: '旧背景' }, extension: { keep: true } }))
  const brain = createDesktopBrain(ctx, { file, atomic })
  const result = await brain.call('update_profile', { expectedRevision: 0, expectedSessionId: 'a',
    profile: { name: '归舟', userName: '阿林', tone: 'detailed', background: '新的自定义背景' } })
  assert.equal(result.sessionId, 'a')
  assert.equal(prompts, 0)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).extension, { keep: true })
  const profile = brain.peek().profile
  assert.equal(profile.name, '归舟')
  assert.equal(profile.userName, '阿林')
  assert.equal(profile.tone, 'detailed')
  assert.equal(profile.background, '新的自定义背景')
  assert.equal(profile.wakeTime, '09:00', '作息有默认值，旧配置不需要迁移')
  assert.equal(profile.life, true)
  ctx.sessions.get = () => null
  const renamed = await brain.call('update_profile', { expectedRevision: result.revision, expectedSessionId: 'a', profile: { name: '归来' } })
  assert.equal(renamed.sessionId, 'a', 'even an unavailable session is never silently replaced')
})

test('cross-host edits use the revision under a file lock so one stale draft cannot overwrite another', async t => {
  const { file, ctx } = await fixture(t)
  const first = createDesktopBrain(ctx, { file, atomic }), second = createDesktopBrain(ctx, { file, atomic })
  const initial = await first.call('configure', { sessionId: 'a' })
  const save = (brain, name) => brain.call('update_profile', { expectedRevision: initial.revision, expectedSessionId: 'a', profile: { name } })
  const results = await Promise.allSettled([save(first, '甲'), save(second, '乙')])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'WORLD_DESKTOP_PROFILE_STALE')
  const saved = await second.get()
  assert.equal(saved.revision, initial.revision + 1)
  assert.equal(saved.profile.name, results.find(result => result.status === 'fulfilled').value.profile.name)
})

test('invalid edits, stale identities and cancellation leave the stored profile intact', async t => {
  const { file, ctx } = await fixture(t)
  const brain = createDesktopBrain(ctx, { file, atomic })
  const initial = await brain.call('configure', { sessionId: 'a' })
  const before = await readFile(file, 'utf8')
  const payload = { expectedRevision: initial.revision, expectedSessionId: 'a', profile: { name: '小舟' } }
  for (const profile of [{ name: '' }, { name: '名'.repeat(17) }, { name: '换\n行' }, { userName: '称'.repeat(25) }, { userName: 'a\0b' }, { tone: 'unlisted' }, { background: ' ' }, { version: 9 }])
    await assert.rejects(brain.call('update_profile', { ...payload, profile }), { code: 'WORLD_DESKTOP_PROFILE' })
  await assert.rejects(brain.call('update_profile', { ...payload, expectedSessionId: 'b' }), { code: 'WORLD_DESKTOP_PROFILE_STALE' })
  await assert.rejects(brain.call('update_profile', { ...payload, sessionId: 'b' }), { code: 'WORLD_DESKTOP_BRAIN' })
  await assert.rejects(brain.call('update_profile', payload, AbortSignal.abort()), { name: 'AbortError' })
  assert.equal(await readFile(file, 'utf8'), before)
})

test('a canceled write waiting for the shared lock cannot change preferences later', async t => {
  const { file, ctx } = await fixture(t)
  let announce
  announce = () => {}
  const brain = createDesktopBrain(ctx, { file, atomic: { ...atomic,
    withFileLock: (...args) => { announce(); return atomic.withFileLock(...args) } } })
  const initial = await brain.call('configure', { sessionId: 'a' })
  const before = await readFile(file, 'utf8'), cancel = new AbortController()
  let pending
  const attempting = new Promise(resolve => { announce = resolve })
  await atomic.withFileLock(file, async () => {
    pending = brain.call('update_profile', { expectedRevision: initial.revision, expectedSessionId: 'a', profile: { name: '不应保存' } }, cancel.signal)
    await attempting
    cancel.abort()
  })
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(await readFile(file, 'utf8'), before)
})

test('malformed pending profiles cannot reset a fixed identity', async t => {
  const { file, ctx } = await fixture(t)
  for (const document of [{ sessionId: null, profile: { background: '无版本' } }, { formatVersion: 2, sessionId: null, profile: null }]) {
    const original = JSON.stringify(document)
    await writeFile(file, original)
    await assert.rejects(createDesktopBrain(ctx, { file, atomic }).call('bind', { sessionId: 'b' }))
    assert.equal(await readFile(file, 'utf8'), original)
  }
})
