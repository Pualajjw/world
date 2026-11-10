import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createTasksStore, registerTasksTools } from '../tasks.js'
import { atomic } from './journal-fixture.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'world-tasks-'))
  const file = join(directory, 'tasks.json')
  const store = createTasksStore({ file, atomic })
  t.after(async () => {
    await store.dispose()
    assert.equal(dirname(directory), tmpdir()); assert.ok(basename(directory).startsWith('world-tasks-'))
    await rm(directory, { recursive: true, force: true })
  })
  return { store, file }
}

test('tasks persist status changes, keep done items out of the default list and clear them on request', async t => {
  const { store, file } = await fixture(t)
  const first = await store.call('write', { expectedRevision: 0, title: '修好日记搜索', next: '补一条测试' }, undefined, 'assistant')
  assert.equal(first.status, 'pending')
  const second = await store.call('write', { expectedRevision: 0, title: '整理待办样式', status: 'doing' }, undefined, 'human')
  let listed = await store.call('list')
  assert.deepEqual(listed.items.map(item => item.id), [second.id, first.id], 'doing items sort before pending ones')
  assert.equal(listed.counts.active, 2)
  const done = await store.call('write', { id: first.id, expectedRevision: first.revision, status: 'done' })
  assert.equal(done.status, 'done')
  assert.ok(Number.isFinite(done.doneAt))
  listed = await store.call('list')
  assert.deepEqual(listed.items.map(item => item.id), [second.id], 'done items leave the default list')
  assert.equal(listed.counts.done, 1)
  assert.equal((await store.call('list', { status: 'done' })).total, 1)
  assert.equal((await store.call('list', { all: true })).total, 2)
  const reopened = createTasksStore({ file, atomic }); t.after(() => reopened.dispose())
  assert.equal((await reopened.call('get', { id: first.id })).title, '修好日记搜索')
  await store.call('write', { id: second.id, expectedRevision: second.revision, status: 'blocked' })
  await assert.rejects(store.call('clearDone', { confirmed: true, expectedRevision: listed.revision }), { code: 'WORLD_TASKS_STALE' })
  const fresh = await store.call('list')
  const cleared = await store.call('clearDone', { confirmed: true, expectedRevision: fresh.revision })
  assert.equal(cleared.removed, 1)
  assert.equal((await store.call('list', { all: true })).total, 1)
  assert.ok(!(await readFile(file, 'utf8')).includes('补一条测试'))
})

test('merged updates reject stale revisions and no-op writes do not bump revisions', async t => {
  const { store } = await fixture(t)
  const item = await store.call('write', { title: '下一步：看截图', note: '先验证再记录。' })
  const again = await store.call('write', { id: item.id, expectedRevision: item.revision, title: item.title, note: '先验证再记录。' })
  assert.equal(again.revision, item.revision)
  const updated = await store.call('write', { id: item.id, expectedRevision: item.revision, next: '打开待办窗口' })
  assert.equal(updated.revision, item.revision + 1)
  await assert.rejects(store.call('write', { id: item.id, expectedRevision: item.revision, status: 'done' }), { code: 'WORLD_TASKS_STALE' })
  await assert.rejects(store.call('write', { id: item.id, expectedRevision: updated.revision, status: 'finished' }))
  await assert.rejects(store.call('write', { title: '' }))
  await assert.rejects(store.call('remove', { id: item.id, expectedRevision: updated.revision }))
  const removed = await store.call('remove', { id: item.id, expectedRevision: updated.revision, confirmed: true })
  assert.equal(removed.removed, 1)
  assert.equal((await store.call('list', { all: true })).total, 0)
})

test('corrupt task storage is refused without overwriting the file', async t => {
  const { store, file } = await fixture(t)
  await writeFile(file, '{ broken')
  await assert.rejects(store.call('write', { title: '不应覆盖' }), { code: 'WORLD_TASKS_STATE' })
  assert.equal(await readFile(file, 'utf8'), '{ broken')
})

test('assistant task tools belong to the fixed brain and never expose deletion', async t => {
  const { store } = await fixture(t)
  let tool
  registerTasksTools({ inject(_services, body) { body({ effect(effect) { effect() }, tools: { register(value) { tool = value; return () => {} } } }) } },
    { tasks: store, brain: { get: async () => ({ sessionId: 'fixed' }) } })
  const exec = { agent: { session: { id: 'fixed' } } }
  const added = await tool.execute({ action: 'add', title: '补测试', next: '跑 node --test' }, exec)
  assert.equal(added.createdBy, 'assistant')
  const updated = await tool.execute({ action: 'update', id: added.id, expectedRevision: added.revision, status: 'doing' }, exec)
  assert.equal(updated.status, 'doing')
  await assert.rejects(tool.execute({ action: 'list' }, { agent: { session: { id: 'other' } } }), { code: 'WORLD_TASKS_SESSION' })
  await assert.rejects(tool.execute({ action: 'remove', id: added.id }, exec))
  assert.ok(!tool.parameters.properties.action.enum.includes('remove'))
  assert.ok(!tool.parameters.properties.action.enum.includes('clearDone'))
})
