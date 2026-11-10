import test from 'node:test'
import assert from 'node:assert/strict'
import { groundOf } from '../plane.js'
import { iconObstacles, routeAroundIcons } from '../walker-path.js'

const ground = groundOf(1280, 800, 48)
const rects = [{ left: 500, right: 596, top: 490, bottom: 586 },
  { left: 610, right: 680, top: 520, bottom: 590 }]
const obstacles = iconObstacles(rects, ground, 84)

function checkPath(start, path) {
  assert.ok(path.length)
  let a = start
  for (const b of path) {
    assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y))
    for (let t = 0; t <= 1; t += 0.02) {
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      for (const r of obstacles) {
        assert.ok(!(p.x > r.left && p.x < r.right && p.y > r.top && p.y < r.bottom), 'must walk around the icon body, not through it')
      }
    }
    a = b
  }
}

test('routes around the whole icon body in both directions', () => {
  for (const [start, goal] of [[{ x: 550, y: 450 }, { x: 550, y: 700 }],
    [{ x: 550, y: 700 }, { x: 550, y: 450 }]]) {
    const path = routeAroundIcons(start, goal, obstacles, ground, 84)
    assert.ok(path.length > 1)
    assert.deepEqual(path.at(-1), goal)
    checkPath(start, path)
  }
})

test('a pointer inside or behind an icon stops at a reachable boundary', () => {
  for (const goal of [{ x: 550, y: 540 }, { x: 550, y: 500 }]) {
    const start = { x: 850, y: 600 }
    const path = routeAroundIcons(start, goal, obstacles, ground, 84)
    checkPath(start, path)
    assert.notDeepEqual(path.at(-1), goal)
    assert.ok(!obstacles.some(r => path.at(-1).x > r.left && path.at(-1).x < r.right
      && path.at(-1).y > r.top && path.at(-1).y < r.bottom))
  }
})

test('an unobstructed goal keeps a direct route', () => {
  const goal = { x: 1000, y: 430 }
  assert.deepEqual(routeAroundIcons({ x: 850, y: 700 }, goal, obstacles, ground, 84), [goal])
})

test('icons far above the horizon do not block the walkable floor', () => {
  assert.equal(iconObstacles([{ left: 10, right: 100, top: 40, bottom: 120 }], ground, 84).length, 0)
})
