import assert from 'node:assert/strict'
import test from 'node:test'
import { createJournalClient } from '../journal-client.js'

const result = (revision, offset = 0) => ({ ok: true, value: { revision, offset, entries: [{ id: `entry-${revision}` }], total: 1, hasMore: false } })
const flush = async () => { for (let index = 0; index < 5; index++) await Promise.resolve() }
function fixture() {
  const calls = []
  const client = createJournalClient({ call(_base, method, payload) {
    return new Promise((resolve, reject) => calls.push({ method, payload, resolve, reject }))
  } })
  return { client, calls }
}

test('overlapping polls share the pending page read so a slow response can still populate the list', async () => {
  const { client, calls } = fixture()
  const first = client.refresh(), second = client.refresh(), third = client.refresh()
  assert.equal(calls.length, 1, 'polling must not repeatedly invalidate its own slow response')
  calls[0].resolve(result(1))
  await Promise.all([first, second, third])
  assert.equal(client.getSnapshot().active.revision, 1)
  assert.equal(client.getSnapshot().active.entries[0].id, 'entry-1')
})

test('a late page response cannot replace a newer page or clear its pending request', async () => {
  const { client, calls } = fixture()
  const first = client.refresh(false, 100, 0), next = client.refresh(false, 100, 100)
  calls[0].resolve(result(1, 0)); await first
  const repeated = client.refresh(false, 100, 100)
  assert.equal(calls.length, 2)
  calls[1].resolve(result(2, 100)); await Promise.all([next, repeated])
  assert.equal(client.getSnapshot().active.offset, 100)
  assert.equal(client.getSnapshot().active.revision, 2)
})

test('a successful mutation reads fresh lists instead of joining a poll that predates the write', async () => {
  const { client, calls } = fixture()
  const oldPoll = client.refresh()
  const change = client.change('write', { id: 'entry', title: 'saved', body: '' })
  calls[1].resolve({ ok: true, value: { id: 'entry', revision: 2 } })
  await flush()
  assert.equal(calls.length, 4, 'both active and trash lists must be refreshed after the write')
  calls[2].resolve(result(2)); calls[3].resolve(result(2)); await change
  calls[0].resolve(result(1)); await oldPoll
  assert.equal(client.getSnapshot().active.revision, 2)
})

test('a delayed save can clear only the draft it saved, preserving newer edits and unload protection', () => {
  const { client } = fixture()
  const savedDraft = { id: 'entry', title: 'first', body: 'A', dirty: true }
  const newerDraft = { ...savedDraft, body: 'B' }
  client.setDraft(savedDraft); client.setDraft(newerDraft)
  assert.equal(client.clearDraft('entry', savedDraft), false)
  assert.equal(client.draft('entry'), newerDraft)
  assert.equal(client.hasDirty(), true)
  assert.equal(client.clearDraft('entry', newerDraft), true)
  assert.equal(client.hasDirty(), false)
})

test('a delayed purge or clear receipt cannot discard edits made after the operation began', async () => {
  for (const operation of ['purge', 'clear']) {
    const { client, calls } = fixture()
    const change = client.change(operation, { id: 'entry' })
    const newer = { id: 'entry', title: 'newer draft', body: 'retain this', dirty: true }
    client.setDraft(newer)
    calls[0].resolve({ ok: true, value: { removed: 1, removedIds: ['entry'] } })
    await flush()
    calls[1].resolve(result(2)); calls[2].resolve(result(2)); await change
    assert.equal(client.draft('entry'), newer)
    assert.equal(client.clearDraft('entry', undefined), false)
    assert.equal(client.hasDirty(), true)
  }
})

test('closing the desktop during an admitted save does not start more list requests afterward', async () => {
  const { client, calls } = fixture()
  const change = client.change('write', { title: 'saved', body: '' })
  client.dispose()
  calls[0].resolve({ ok: true, value: { id: 'entry', revision: 1 } })
  assert.equal((await change).id, 'entry')
  assert.equal(calls.length, 1)
  await assert.rejects(client.refresh(), { code: 'WORLD_DIARY_CLOSED' })
})
