import assert from 'node:assert/strict'
import test from 'node:test'
import { validateUiCommand } from '../desktop-ui-protocol.js'
import { desktopToolDefinitions } from '../desktop-tools.js'

test('UI commands require current window/snapshot targets and reject invalid coordinates or modifiers', () => {
  const base = { action: 'click', windowId: 'plugin:workflow-studio', snapshotId: 'snapshot', targetId: 'ui-1' }
  assert.deepEqual(validateUiCommand(base), base)
  for (const patch of [{ snapshotId: '' }, { windowId: '' }, { targetId: undefined }, { x: Infinity, y: 1 },
    { x: 0 }, { modifiers: ['Super'] }, { action: 'drag' }, { action: 'fill', text: null }]) {
    assert.throws(() => validateUiCommand({ ...base, ...patch }), { code: 'WORLD_UI_INVALID' })
  }
  assert.equal(validateUiCommand({ ...base, action: 'select_option', value: '' }).value, '')
  assert.equal(validateUiCommand({ action: 'layout' }).maxElements, 400)
  assert.throws(() => validateUiCommand({ action: 'layout', maxElements: 1001 }))
})

test('layout and UI actions use the same fixed-brain grant and never accept actor or script injection', async () => {
  const sent = []
  const definitions = desktopToolDefinitions({ bridge: { request: async payload => { sent.push(payload); return {} } },
    brain: { get: async () => ({ sessionId: 'fixed' }) } })
  const layout = definitions.find(tool => tool.name === 'world_desktop_layout')
  const action = definitions.find(tool => tool.name === 'world_desktop_action')
  const exec = { agent: { session: { id: 'fixed' } } }
  await layout.execute({ controlId: 'grant', windowId: 'plugin:workflow-studio' }, exec)
  assert.equal(sent[0].action, 'layout')
  assert.equal(sent[0].maxElements, 400)
  await assert.rejects(layout.execute({ controlId: 'grant' }, { agent: { session: { id: 'other' } } }), { code: 'WORLD_DESKTOP_BRAIN' })
  await action.execute({ action: 'fill', controlId: 'grant', windowId: 'plugin:workflow-studio', snapshotId: 's', targetId: 'ui-1', text: '名称',
    actor: { sessionId: 'other' }, script: 'alert(1)' }, exec)
  assert.equal(sent[1].actor.sessionId, 'fixed')
  assert.equal(sent[1].script, undefined)
  assert.equal(sent[1].text, '名称')
})
