import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionTranscript } from '../session-transcript.js'

test('public transcript keeps eight entries, streams visible text, and excludes reasoning/tool payloads', () => {
  const transcript = createSessionTranscript()
  const user = text => ({ type: 'user/message', seq: 1, time: 1, data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  transcript.event(user('请修复界面'))
  transcript.event({ type: 'user/message', seq: 2, time: 2, data: { id: 'ctx', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'secret context' }] } })
  transcript.stream({ type: 'start', attemptId: 'a', turn: 1, step: 1 })
  transcript.stream({ type: 'chunk', attemptId: 'a', chunk: { type: 'reasoning-delta', index: 0, text: 'private reasoning' } })
  transcript.stream({ type: 'chunk', attemptId: 'a', chunk: { type: 'text-delta', index: 1, text: '正在修复' } })
  assert.deepEqual(transcript.snapshot().messages.map(row => row.text), ['请修复界面', '正在修复'])
  transcript.event({ type: 'tool/call', time: 3, data: { callId: 't', name: 'edit', arguments: 'private args' } })
  transcript.event({ type: 'tool/result', time: 4, data: { message: { toolCallId: 't', content: [{ type: 'text', text: 'private result' }] } } })
  assert.equal(transcript.snapshot().toolEvents[0].state, 'completed')
  transcript.stream({ type: 'end', attemptId: 'a', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 5 } })
  transcript.event({ type: 'assistant/message', time: 5, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '已完成' }] } } })
  assert.equal(transcript.snapshot().messages.at(-1).text, '已完成')
  assert.ok(!JSON.stringify(transcript.snapshot()).includes('private'))
  for (let index = 0; index < 12; index += 1) {
    const event = user(`m${index}`)
    event.data.id = `user-${index}`
    transcript.event(event)
  }
  assert.equal(transcript.snapshot().messages.length, 8)
  assert.equal(transcript.snapshot().messages[0].text, 'm4')
})

test('abandoned stream does not leave a phantom assistant reply', () => {
  const transcript = createSessionTranscript()
  transcript.stream({ type: 'start', attemptId: 'a', turn: 1, step: 1 })
  transcript.stream({ type: 'chunk', attemptId: 'a', chunk: { type: 'text-delta', index: 0, text: 'partial' } })
  assert.equal(transcript.snapshot().messages.length, 1)
  transcript.stream({ type: 'end', attemptId: 'a', outcome: { kind: 'abandoned' } })
  assert.equal(transcript.snapshot().messages.length, 0)
})

test('replayed stream frames are ignored and tool failures use DSH toolCallId', () => {
  const transcript = createSessionTranscript()
  transcript.stream({ type: 'start', attemptId: 'one', turn: 2, step: 3 })
  const frame = { type: 'chunk', attemptId: 'one', index: 0, chunk: { type: 'text-delta', index: 0, text: '公开回复' } }
  transcript.stream(frame)
  transcript.stream(frame)
  assert.equal(transcript.snapshot().messages[0].text, '公开回复')
  transcript.stream({ type: 'end', attemptId: 'one', outcome: { kind: 'committed' } })
  assert.equal(transcript.snapshot().messages[0].streaming, false)
  transcript.event({ type: 'tool/call', data: { callId: 'failed', name: 'build' } })
  transcript.event({ type: 'tool/result', data: { message: { toolCallId: 'failed', isError: true,
    content: [{ type: 'text', text: 'private output' }] } } })
  assert.equal(transcript.snapshot().toolEvents[0].state, 'error')
  assert.ok(!JSON.stringify(transcript.snapshot()).includes('private'))
})
