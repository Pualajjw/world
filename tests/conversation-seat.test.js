import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversationSeat } from '../conversation-seat.js'

test('a stale surface cleanup cannot relinquish a newer conversation seat', () => {
  const seat = createConversationSeat(), updates = []
  const off = seat.subscribe(() => updates.push(seat.getSnapshot()))
  const first = seat.claim('fixed-brain')
  const replacement = seat.claim('fixed-brain')
  first()
  assert.equal(seat.getSnapshot(), 'fixed-brain')
  replacement()
  replacement()
  assert.deepEqual(updates, ['fixed-brain', null])
  off()
  seat.dispose()
})

test('unloading restores the ordinary Conversation surface and invalidates old claims', () => {
  const seat = createConversationSeat()
  const release = seat.claim('fixed-brain')
  seat.dispose()
  assert.equal(seat.getSnapshot(), null)
  release()
  assert.equal(seat.getSnapshot(), null)
})

test('the panel waits for the original editor to unmount and ignores a cancelled preparation', () => {
  const ready = [], resumed = []
  const seat = createConversationSeat({ suspend: callback => {
    const index = ready.push(callback) - 1
    return () => resumed.push(index)
  } })
  const first = seat.claim('fixed-brain')
  assert.equal(seat.getSnapshot(), null)
  first()
  ready[0]()
  assert.equal(seat.getSnapshot(), null, 'a late preparation cannot revive an abandoned panel')
  const second = seat.claim('fixed-brain')
  ready[1]()
  assert.equal(seat.getSnapshot(), 'fixed-brain')
  second()
  assert.deepEqual(resumed, [0, 1])
})

test('a failed main-view suspension leaves the original conversation available', () => {
  const seat = createConversationSeat({ suspend: () => { throw new Error('registration failed') } })
  assert.throws(() => seat.claim('fixed-brain'), /registration failed/)
  assert.equal(seat.getSnapshot(), null)
  seat.dispose()
})
