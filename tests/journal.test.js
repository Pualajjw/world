import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createJournalStore, registerJournalTools } from '../journal.js'
import { atomic } from './journal-fixture.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'world-journal-'))
  const file = join(directory, 'journal.json')
  const store = createJournalStore({ file, atomic })
  t.after(async () => {
    await store.dispose()
    assert.equal(dirname(directory), tmpdir()); assert.ok(basename(directory).startsWith('world-journal-'))
    await rm(directory, { recursive: true, force: true })
  })
  return { store, file }
}

test('diary persists edits, recoverable trash and explicit permanent removal', async t => {
  const { store, file } = await fixture(t)
  const empty = await store.call('list')
  assert.equal(empty.total, 0)
  const entry = await store.call('write', { id: 'stable-create-id', expectedRevision: 0, title: '第一天', body: '检查并修复工作台。' }, undefined, 'assistant')
  const repeated = await store.call('write', { id: entry.id, expectedRevision: 0, title: entry.title, body: entry.body })
  assert.equal(repeated.id, entry.id)
  assert.equal((await store.call('list')).total, 1, 'a repeated create receipt does not duplicate the entry')
  const edited = await store.call('write', { id: entry.id, expectedRevision: entry.revision, title: '共同编辑', body: '加入用户修改。' })
  assert.equal(edited.revision, 2)
  assert.equal(edited.createdBy, 'assistant'); assert.equal(edited.updatedBy, 'human')
  const trashed = await store.call('trash', { id: entry.id, expectedRevision: edited.revision })
  assert.equal((await store.call('list')).total, 0)
  assert.equal((await store.call('list', { trash: true })).total, 1)
  const resumed = createJournalStore({ file, atomic })
  t.after(() => resumed.dispose())
  assert.equal((await resumed.call('get', { id: entry.id })).body, edited.body)
  const restored = await resumed.call('restore', { id: entry.id, expectedRevision: trashed.revision })
  assert.equal(restored.deletedAt, null)
  const again = await store.call('trash', { id: entry.id, expectedRevision: restored.revision })
  await assert.rejects(store.call('purge', { id: entry.id, expectedRevision: again.revision }))
  await store.call('purge', { id: entry.id, expectedRevision: again.revision, confirmed: true })
  await assert.rejects(store.call('restore', { id: entry.id, expectedRevision: again.revision }), { code: 'WORLD_DIARY_NOT_FOUND' })
  assert.ok(!(await readFile(file, 'utf8')).includes('加入用户修改'))
})

test('concurrent instances reject stale edits and stale trash clearing without losing newer data', async t => {
  const { store, file } = await fixture(t)
  const other = createJournalStore({ file, atomic }); t.after(() => other.dispose())
  const entry = await store.call('write', { title: '共享日记', body: '原稿' })
  const updates = await Promise.allSettled([
    store.call('write', { id: entry.id, expectedRevision: 1, title: '手工编辑', body: '用户内容' }),
    other.call('write', { id: entry.id, expectedRevision: 1, title: '助手编辑', body: '助手内容' }, undefined, 'assistant'),
  ])
  assert.equal(updates.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(updates.find(result => result.status === 'rejected').reason.code, 'WORLD_DIARY_STALE')
  const current = await store.call('get', { id: entry.id })
  await store.call('trash', { id: entry.id, expectedRevision: current.revision })
  const snapshot = await store.call('list', { trash: true })
  const second = await other.call('write', { title: '新日记', body: '不应被旧确认清除' })
  await other.call('trash', { id: second.id, expectedRevision: second.revision })
  await assert.rejects(store.call('clear', { confirmed: true, expectedRevision: snapshot.revision }), { code: 'WORLD_DIARY_STALE' })
  assert.equal((await store.call('list', { trash: true })).total, 2)
  const fresh = await store.call('list', { trash: true })
  const cleared = await store.call('clear', { confirmed: true, expectedRevision: fresh.revision })
  assert.equal(cleared.removed, 2)
  assert.deepEqual(new Set(cleared.removedIds), new Set([entry.id, second.id]))
})

test('progress receipts are deduplicated even after editing or permanently removing their diary entry', async t => {
  const { store } = await fixture(t)
  const progress = { key: 'fixed:turn-1', title: '工作台进展', body: '修复已验证。' }
  await store.recordProgress(progress)
  await store.recordProgress(progress)
  assert.equal((await store.call('list')).total, 1)
  const entry = (await store.call('list')).entries[0]
  const modified = await store.call('write', { id: entry.id, expectedRevision: entry.revision, title: '用户注释', body: '保留人工修改' })
  await store.recordProgress(progress)
  assert.equal((await store.call('get', { id: entry.id })).body, modified.body)
  const deleted = await store.call('trash', { id: entry.id, expectedRevision: modified.revision })
  await store.call('purge', { id: entry.id, expectedRevision: deleted.revision, confirmed: true })
  await store.recordProgress(progress)
  assert.equal((await store.call('list')).total, 0, 'a late receipt cannot recreate a purged note')
})

test('pinned notes and keyword search keep long-term agreements findable', async t => {
  const { store } = await fixture(t)
  const agreement = await store.call('write', { title: '约定：先问再做', body: '几何参数必须先确认。' }, undefined, 'assistant')
  const routine = await store.call('write', { title: '普通记录', body: '今天修了按钮间距。' }, undefined, 'assistant')
  const pinned = await store.call('pin', { id: agreement.id, expectedRevision: agreement.revision, pinned: true }, undefined, 'human')
  assert.equal(pinned.pinned, true)
  assert.equal(pinned.updatedAt, agreement.updatedAt, 'pinning does not rewrite the update time')
  assert.equal((await store.call('list')).entries[0].id, agreement.id, 'pinned notes sort first')
  const found = await store.call('list', { query: '几何' })
  assert.deepEqual(found.entries.map(entry => entry.id), [agreement.id])
  assert.equal(found.total, 1)
  assert.equal((await store.call('list', { query: '按钮' })).entries[0].id, routine.id)
  assert.equal((await store.call('list', { pinned: true })).total, 1)
  assert.equal((await store.call('list')).entries.find(entry => entry.id === routine.id).auto, false)
  await assert.rejects(store.call('list', { query: 'x'.repeat(201) }))
})

test('automatic progress is marked and becomes a curated note once explicitly written', async t => {
  const { store } = await fixture(t)
  await store.recordProgress({ key: 'turn-progress', title: '工作台进展', body: '验证完成。' })
  const row = (await store.call('list')).entries[0]
  assert.equal(row.auto, true)
  assert.equal(row.pinned, false)
  const entry = await store.call('get', { id: row.id })
  const edited = await store.call('write', { id: entry.id, expectedRevision: entry.revision, title: entry.title, body: entry.body })
  assert.equal(edited.auto, false, 'an explicit write marks the entry as hand-written')
})

test('invalid, cancelled and corrupt-state writes leave stored data untouched', async t => {
  const { store, file } = await fixture(t)
  await assert.rejects(store.call('write', { title: '', body: '' }))
  await assert.rejects(store.call('write', { id: '../outside', title: '无效编号', body: '' }))
  const abort = new AbortController(); abort.abort(new Error('cancelled'))
  await assert.rejects(store.call('write', { title: '取消写入', body: '' }, abort.signal), /cancelled/)
  await writeFile(file, '{ invalid json')
  await assert.rejects(store.call('write', { title: '不能覆盖损坏数据', body: '' }), { code: 'WORLD_DIARY_STATE' })
  assert.equal(await readFile(file, 'utf8'), '{ invalid json')
})

test('assistant diary tools belong to the fixed brain and expose no purge or clear action', async t => {
  const { store } = await fixture(t)
  let tool
  registerJournalTools({ inject(_services, body) { body({ effect(effect) { effect() }, tools: { register(value) { tool = value; return () => {} } } }) } },
    { journal: store, brain: { get: async () => ({ sessionId: 'fixed' }) } })
  const exec = { agent: { session: { id: 'fixed' } } }
  const created = await tool.execute({ action: 'write', title: '助手补充记录', body: '公开结果' }, exec)
  assert.equal(created.createdBy, 'assistant')
  await assert.rejects(tool.execute({ action: 'list' }, { agent: { session: { id: 'other' } } }), { code: 'WORLD_DIARY_SESSION' })
  await assert.rejects(tool.execute({ action: 'purge', id: created.id }, exec))
  assert.ok(!tool.parameters.properties.action.enum.includes('purge'))
})

test('a diary survives recreation, reads the latest human edit and keeps trashed entries out of the list', async t => {
  const { store, file } = await fixture(t)
  const entry = await store.call('write', { title: '留给下次的事', body: '先前的计划。' }, undefined, 'assistant')
  await store.call('write', { id: entry.id, expectedRevision: entry.revision, title: '用户修正后的约定', body: '先核实当前情况，不重复上次的修复。' })
  const removed = await store.call('write', { title: '已放下的事项', body: '不应该再读回来。' })
  await store.call('trash', { id: removed.id, expectedRevision: removed.revision })
  const restarted = createJournalStore({ file, atomic }); t.after(() => restarted.dispose())
  const before = await readFile(file, 'utf8')
  const listed = await restarted.call('list', { trash: false, offset: 0, limit: 10 })
  assert.deepEqual(listed.entries.map(item => item.id), [entry.id])
  const latest = await restarted.call('get', { id: entry.id })
  assert.equal(latest.body, '先核实当前情况，不重复上次的修复。')
  assert.equal(latest.updatedBy, 'human')
  assert.equal(await readFile(file, 'utf8'), before, 'reading a record neither edits it nor manufactures an entry')
})
