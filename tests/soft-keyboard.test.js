/** 软键盘高度只认「安静下来的那一帧」，中间帧不许提交：否则界面会一帧一个高度地跳。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createKeyboardSettle, normalizeOverlap, KEYBOARD_MIN, KEYBOARD_RELEASE_MIN, KEYBOARD_MAX_MS,
} from '../soft-keyboard.js'

/** 手动时钟：看清「什么时候才真的落地」。 */
function fakeClock() {
  let time = 0
  let queue = []
  return {
    now: () => time,
    set(fn, ms) { queue.push({ at: time + ms, fn, id: queue.length + 1 }); return queue.at(-1).id },
    clear(id) { queue = queue.filter(item => item.id !== id) },
    advance(ms) {
      const until = time + ms
      for (;;) {
        const next = queue.filter(item => item.at <= until).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        queue = queue.filter(item => item !== next)
        time = next.at
        next.fn()
      }
      time = until
    },
  }
}

test('a short overlap (address bar, bounce) is not a keyboard', () => {
  assert.equal(normalizeOverlap(0, 0), 0)
  assert.equal(normalizeOverlap(-12, 0), 0)
  assert.equal(normalizeOverlap(KEYBOARD_MIN - 1, 0), 0)
  assert.equal(normalizeOverlap(KEYBOARD_MIN, 0), KEYBOARD_MIN)
  assert.equal(normalizeOverlap(312.4, 0), 312)
})

test('once a keyboard was seen, the release floor drops so it does not flicker', () => {
  // 已经开过一次：60px 也算「还开着」，不然在 120 上下会 0 / 120 反复横跳
  assert.equal(normalizeOverlap(KEYBOARD_RELEASE_MIN, 300), KEYBOARD_RELEASE_MIN)
  assert.equal(normalizeOverlap(KEYBOARD_RELEASE_MIN - 1, 300), 0)
  // 收起之后又回到高门槛
  assert.equal(normalizeOverlap(100, 0), 0)
})

test('the keyboard animation never reaches the layout until it is over', () => {
  const clock = fakeClock()
  const seen = []
  const settle = createKeyboardSettle({ commit: height => seen.push(height), clock })

  // 一帧一帧长高的键盘（iPhone 约 250ms）：每帧都在 push，一帧都不许提交
  for (const height of [180, 240, 290, 315, 322]) {
    settle.push(height)
    clock.advance(16)
  }
  assert.deepEqual(seen, [], '动画中间一帧都没有落地')
  clock.advance(130)
  assert.deepEqual(seen, [322], '静下来之后只落一次，而且落的是最终高度')
  assert.equal(settle.settled, true)
})

test('repeated pushes keep delaying the settle, but the max wait still lands once', () => {
  const clock = fakeClock()
  const seen = []
  const settle = createKeyboardSettle({ commit: height => seen.push(height), clock })
  // 每 100ms 来一个事件（比 quiet 短）：安静阈值一直被打断
  for (let step = 0; step < 6; step += 1) {
    settle.push(200 + step * 10)
    clock.advance(100)
  }
  assert.ok(seen.length >= 1, '一直有事件也不能永远不落地')
  assert.ok(clock.now() >= KEYBOARD_MAX_MS)
  assert.equal(seen.at(-1), 250)
})

test('closing the keyboard goes back to zero exactly once', () => {
  const clock = fakeClock()
  const seen = []
  const settle = createKeyboardSettle({ commit: height => seen.push(height), clock })
  settle.push(300)
  clock.advance(200)
  assert.deepEqual(seen, [300])
  // 收起动画：高度一路退回 0
  for (const height of [240, 120, 40]) {
    settle.push(height)
    clock.advance(16)
  }
  settle.push(0)
  clock.advance(200)
  // 收到 40 那帧就已经低于「收起线」，最终落一个 0，不再抖回中间值
  assert.deepEqual(seen, [300, 0])
})

test('identical consecutive values do not commit twice', () => {
  const clock = fakeClock()
  const seen = []
  const settle = createKeyboardSettle({ commit: height => seen.push(height), clock })
  settle.push(280)
  clock.advance(200)
  settle.push(280)
  clock.advance(200)
  settle.push(281)
  clock.advance(200)
  assert.deepEqual(seen, [280, 281])
})

test('flush lands a pending value immediately (unmount / blur)', () => {
  const clock = fakeClock()
  const seen = []
  const settle = createKeyboardSettle({ commit: height => seen.push(height), clock })
  settle.push(260)
  settle.flush()
  assert.deepEqual(seen, [260])
  assert.equal(settle.settled, true)
})
