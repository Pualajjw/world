import assert from 'node:assert/strict'
import test from 'node:test'
import { HOST_PANELS, openHostPanel } from '../host-panels.js'

test('a page that cannot be mirrored is opened where it lives: the DSH window', () => {
  const calls = []
  const layout = { selectPanel: id => calls.push(id) }
  assert.equal(openHostPanel(layout, 'plugins'), true)
  assert.deepEqual(calls, ['plugins'])
  assert.deepEqual(HOST_PANELS.map(page => page.id), ['plugins'], 'the plugin manager is the one page handled this way')
  assert.match(HOST_PANELS[0].note, /DSH 窗口/)
})

test('no layout service or no such panel is reported, never thrown', () => {
  assert.equal(openHostPanel(undefined, 'plugins'), false)
  assert.equal(openHostPanel({}, 'plugins'), false)
  assert.equal(openHostPanel(null, 'plugins'), false)
  assert.equal(openHostPanel({ selectPanel: () => {} }, ''), false, 'no id, nothing to open')
  const host = { selectPanel() { throw new Error('main panel "plugins" is not registered') } }
  assert.equal(openHostPanel(host, 'plugins'), false, 'a host without that panel is a false, not a crash')
})
