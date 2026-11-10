import assert from 'node:assert/strict'
import test from 'node:test'
import { createAssistantPointer } from '../assistant-pointer.js'

function fixture() {
  let control = { owner: 'human', controlId: null }
  let bounds = { left: 0, top: 40, right: 1280, bottom: 752 }
  const pointer = createAssistantPointer({ getControl: () => control, getBounds: () => bounds })
  return { pointer, grant: id => { control = { owner: 'assistant', controlId: id }; pointer.sync() },
    takeOver: () => { control = { owner: 'human', controlId: null }; pointer.sync() },
    resize: value => { bounds = value; pointer.resize() } }
}

test('the assistant pointer starts at the work-area center only after a grant', () => {
  const f = fixture()
  f.pointer.sync()
  assert.equal(f.pointer.getSnapshot().visible, false)
  f.grant('grant-1')
  assert.deepEqual(f.pointer.getSnapshot(), { visible: true, controlId: 'grant-1', x: 640, y: 396, pulse: null })
  f.pointer.move({ x: 111.125, y: 220.5 }, 'grant-1')
  f.pointer.sync()
  assert.equal(f.pointer.getSnapshot().x, 111.125, 'ordinary control updates must not reset the pointer')
})

test('takeover and a later handoff reject every stale movement from the old grant', () => {
  const f = fixture()
  f.grant('grant-1'); f.pointer.move({ x: 200, y: 300 }, 'grant-1')
  f.takeOver()
  assert.equal(f.pointer.getSnapshot().visible, false)
  assert.equal(f.pointer.move({ x: 500, y: 600 }, 'grant-1'), false)
  f.grant('grant-2')
  assert.equal(f.pointer.move({ x: 500, y: 600 }, 'grant-1'), false)
  assert.deepEqual(f.pointer.getSnapshot(), { visible: true, controlId: 'grant-2', x: 640, y: 396, pulse: null })
})

test('CSS coordinates retain subpixel precision while resize and out-of-range input remain within the work area', () => {
  const f = fixture()
  f.grant('grant-1')
  assert.equal(f.pointer.move({ x: 1279.5, y: 751.5 }, 'grant-1'), true)
  assert.equal(f.pointer.getSnapshot().x, 1279.5)
  f.resize({ left: 0, top: 40, right: 480, bottom: 592 })
  assert.equal(f.pointer.getSnapshot().x, 479)
  assert.equal(f.pointer.getSnapshot().y, 591)
  f.pointer.move({ x: -10, y: 0 }, 'grant-1')
  assert.equal(f.pointer.getSnapshot().x, 0)
  assert.equal(f.pointer.getSnapshot().y, 40)
  const before = f.pointer.getSnapshot()
  assert.equal(f.pointer.move({ x: NaN, y: 20 }, 'grant-1'), false)
  assert.equal(f.pointer.move({ x: 10, y: Infinity }, 'grant-1'), false)
  assert.equal(f.pointer.getSnapshot(), before)
})

test('clicks and typing leave a pulse at the landing point while hovering and dragging do not', () => {
  const f = fixture()
  f.grant('grant-1')
  assert.equal(f.pointer.move({ x: 200, y: 300 }, 'grant-1', 'hover'), true)
  assert.equal(f.pointer.getSnapshot().pulse, null, 'hovering is not an action')
  f.pointer.move({ x: 210, y: 310 }, 'grant-1', 'click')
  const click = f.pointer.getSnapshot().pulse
  assert.deepEqual({ x: click.x, y: click.y, kind: click.kind }, { x: 210, y: 310, kind: 'click' })
  f.pointer.move({ x: 220, y: 320 }, 'grant-1', 'double_click')
  const double = f.pointer.getSnapshot().pulse
  assert.equal(double.kind, 'double')
  assert.ok(double.id > click.id, 'every action gets a fresh pulse id the view can diff')
  f.pointer.move({ x: 230, y: 330 }, 'grant-1', 'drag')
  assert.equal(f.pointer.getSnapshot().pulse, double, 'dragging only moves the cursor')
  f.pointer.move({ x: 240, y: 340 }, 'grant-1', 'fill')
  assert.equal(f.pointer.getSnapshot().pulse.kind, 'type')
})

test('a stale grant cannot pulse the cursor and takeover clears any leftover pulse', () => {
  const f = fixture()
  f.grant('grant-1')
  f.pointer.move({ x: 200, y: 300 }, 'grant-1', 'click')
  assert.equal(f.pointer.move({ x: 400, y: 400 }, 'grant-1', 'click'), true)
  f.takeOver()
  assert.equal(f.pointer.getSnapshot().pulse, null)
  assert.equal(f.pointer.move({ x: 420, y: 420 }, 'grant-1', 'click'), false)
  assert.equal(f.pointer.getSnapshot().pulse, null, 'a rejected action must not paint')
})
