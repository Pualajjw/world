import assert from 'node:assert/strict'
import test from 'node:test'
import { createDesktopControl, observeDesktopInput } from '../desktop-control.js'

test('desktop ownership starts with the human and only the granted session can operate', async () => {
  let revision = 0
  const control = createDesktopControl({ makeId: () => `grant-${++revision}` })
  const command = { action: 'explain', actor: { sessionId: 'session-a' }, controlId: 'grant-1', message: '正在检查代码' }
  const initialRevision = control.getSnapshot().revision
  await assert.rejects(control.run(command), { code: 'WORLD_DESKTOP_TAKEN_OVER' })
  control.grant('session-a')
  const grantedRevision = control.getSnapshot().revision
  assert.ok(grantedRevision > initialRevision)
  await assert.rejects(control.run({ ...command, actor: { sessionId: 'session-b' } }), { code: 'WORLD_DESKTOP_SESSION' })
  await control.run(command)
  assert.equal(control.getSnapshot().message, '正在检查代码')
  control.takeOver()
  assert.ok(control.getSnapshot().revision > grantedRevision)
  assert.equal(control.getSnapshot().owner, 'human')
  control.grant('session-a')
  await assert.rejects(control.run(command), { code: 'WORLD_DESKTOP_TAKEN_OVER' })
  assert.equal(control.getSnapshot().controlId, 'grant-2')
  control.dispose()
})

test('human takeover aborts the active desktop operation and its late result cannot regain control', async () => {
  const control = createDesktopControl({ makeId: () => 'grant' })
  control.grant('session-a')
  let operationSignal, finish
  const pending = control.run({ action: 'open_file', actor: { sessionId: 'session-a' }, controlId: 'grant', path: '/work/main.js' },
    undefined, signal => { operationSignal = signal; return new Promise(resolve => { finish = resolve }) })
  assert.equal(control.getSnapshot().phase, 'working')
  control.takeOver()
  assert.equal(operationSignal.aborted, true)
  assert.equal(control.getSnapshot().owner, 'human')
  finish({ windowId: 'vscode:win1' })
  await assert.rejects(pending, { code: 'WORLD_DESKTOP_TAKEN_OVER' })
  assert.equal(control.getSnapshot().owner, 'human')
  control.dispose()
})

test('user input during the brain lookup cancels handoff before the late response can grant control', async () => {
  const control = createDesktopControl()
  let finish
  const pending = control.handoff(() => new Promise(resolve => { finish = resolve }))
  assert.equal(control.getSnapshot().phase, 'granting')
  control.takeOver()
  finish({ sessionId: 'fixed-brain' })
  assert.equal(await pending, false)
  assert.equal(control.getSnapshot().owner, 'human')
  control.dispose()
})

test('window focus loss preserves the grant and active work; iframe input can still take over', async () => {
  const document = new EventTarget(), window = new EventTarget()
  document.defaultView = window
  document.activeElement = { tagName: 'IFRAME' }
  let focused = false
  document.hasFocus = () => focused
  const control = createDesktopControl({ makeId: () => 'grant' })
  const off = observeDesktopInput(control, document)
  control.grant('fixed')
  let signal, finish
  const task = control.run({ action: 'open_file', controlId: 'grant', actor: { sessionId: 'fixed' } }, undefined,
    active => { signal = active; return new Promise(resolve => { finish = resolve }) })
  window.dispatchEvent(new Event('blur'))
  assert.equal(control.getSnapshot().controlId, 'grant')
  assert.equal(control.getSnapshot().owner, 'assistant')
  assert.equal(signal.aborted, false)
  focused = true
  window.dispatchEvent(new Event('blur'))
  assert.equal(control.getSnapshot().owner, 'human')
  assert.equal(signal.aborted, true)
  finish({})
  await assert.rejects(task, { code: 'WORLD_DESKTOP_TAKEN_OVER' })
  off()
  control.dispose()
})
