import test from 'node:test'
import assert from 'node:assert/strict'
import { createSrwIndexLookup, indexSrwSiblings, srwPaintCandidates } from '../srw-canvas-index.js'

// Reference: the painter's inclusive per-control check, in absolute canvas coordinates.
function visible(s, v, x, y) {
  if (!s) return false
  const left = x + (s.left || 0), top = y + (s.top || 0)
  return !(left > v.right || top > v.bottom || (s.width != null && left + s.width < v.x) || (s.height != null && top + s.height < v.y))
}
function compare(styles, index, v, x = 0, y = 0) {
  const orders = srwPaintCandidates(index, v, x, y)
  assert.deepEqual(orders.filter(i => visible(styles[i], v, x, y)), styles.flatMap((s, i) => visible(s, v, x, y) ? [i] : []))
  return orders.length
}

test('750 siblings, shuffled declarations: scroll visits nearby batches in original paint order', () => {
  for (const horizontal of [false, true]) {
    const styles = Array.from({ length: 750 }, (_, i) => {
      const pos = (i * 313 % 750) * 29
      return { top: horizontal ? 0 : pos, left: horizontal ? pos : 0, width: 23, height: 23 }
    })
    const index = indexSrwSiblings(styles, s => s)
    for (let pos = -500; pos < 22500; pos += 101) {
      const v = horizontal ? { x: pos, y: -10, right: pos + 580, bottom: 25 } : { x: -10, y: pos, right: 25, bottom: pos + 580 }
      assert.ok(compare(styles, index, v) <= 64, 'bulk culling must not fall back to scanning all 750 controls')
    }
  }
})

test('parent offsets, touching edges, unknown sizes and non-paintable children match exhaustive culling', () => {
  const styles = Array.from({ length: 256 }, (_, i) => ({ left: (i % 17 - 8) * 10, top: (i % 19 - 9) * 12, width: i % 3 ? 13 : undefined, height: i % 5 ? 21 : undefined }))
  styles[0] = null; styles[1] = { width: 0, height: 0 }; styles[2] = { left: -2000, top: -2000, width: 4000, height: 4000 }
  const index = indexSrwSiblings(styles, s => s)
  for (const [x, y] of [[0, 0], [51, -73]]) for (const edge of [-2000, -80, -0.5, 0, 0.5, 2000, 10000]) {
    compare(styles, index, { x: edge + x, y: edge + y, right: edge + x, bottom: edge + y }, x, y)
    compare(styles, index, { x: x - 31, y: edge, right: x + 55, bottom: edge + 37 }, x, y)
  }
  assert.deepEqual(srwPaintCandidates(indexSrwSiblings(styles, () => null), {x: 0, y: 0, right: 1, bottom: 1}, 0, 0), [])
  assert.equal(indexSrwSiblings([{}], () => { throw Error('small groups need no index') }), null)
})

test('a designer reuses sibling trees across Layout mounts, without indexing unopened parents or sharing between models', () => {
  let reads = 0
  const makeLookup = () => createSrwIndexLookup(box => { reads++; return box })
  const parent = { children: Array.from({ length: 750 }, (_, i) => ({ top: i * 29, height: 23 })) }
  const nested = { children: parent.children.slice(0, 75) }
  const indexFor = makeLookup()
  assert.equal(reads, 0)
  const tree = indexFor(parent)
  for (let i = 0; i < 20; i++) assert.equal(indexFor(parent), tree)
  assert.equal(reads, 750)
  assert.ok(indexFor(nested)); assert.equal(reads, 825)
  assert.notEqual(makeLookup()(parent), tree)
  assert.equal(reads, 1575)
})
