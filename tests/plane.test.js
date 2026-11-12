import test from 'node:test'
import assert from 'node:assert/strict'
import { groundOf, planDepthGrid, planFlatGrid, rowHeight, ICON_SIZE } from '../plane.js'

const TASKBAR = 48
const VIEWPORTS = [
  [1920, 1080], [1440, 900], [1280, 800], [1200, 760], [1024, 640],
  [900, 560], [800, 480], [700, 420], [640, 360], [560, 320],
]

test('flat grid always fits every icon inside the container', () => {
  for (const [width, height] of VIEWPORTS) {
    for (const count of [1, 3, 6, 11, 14]) {
      const plan = planFlatGrid(count, width - 12, height - TASKBAR - 50)
      assert.ok(plan.capacity >= count || plan.size === 72,
        `${width}x${height} × ${count}: capacity ${plan.capacity} must hold every icon`)
      // 列右边界不能超宽——超了就会被夹到边上压住邻列。
      const step = plan.size + plan.gap
      const lastColumnLeft = (Math.ceil(count / plan.rows) - 1) * step
      assert.ok(lastColumnLeft <= width - 12 - plan.size || plan.capacity < count,
        `${width}x${height} × ${count}: the last column stays inside`)
      assert.ok(step > plan.size, 'cells must not overlap horizontally')
    }
  }
})

test('flat grid steps the icon size down instead of piling columns up', () => {
  // 96px 在 560 宽里只能摆 5 列 2 行 = 10 个，11 个必须降档。
  const plan = planFlatGrid(11, 548, 212)
  assert.equal(plan.capacity >= 11, true)
  assert.ok(plan.size < 96, 'a small window must use a smaller icon size')
  assert.ok([84, 72].includes(plan.size))
})

test('depth grid never overlaps two rows vertically', () => {
  for (const [width, height] of VIEWPORTS) {
    const plan = planDepthGrid(11, width, height, TASKBAR)
    if (!plan) continue
    const { ground, scales } = plan
    let bottom = ground.near - 14
    const rows = []
    for (const scale of scales) {
      const visualHeight = ICON_SIZE * scale
      rows.push({ top: bottom - visualHeight, bottom })
      bottom -= rowHeight(scale)
    }
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i].bottom <= rows[i - 1].top + .5,
        `${width}x${height}: row ${i} (bottom ${rows[i].bottom.toFixed(1)}) must sit above row ${i - 1} (top ${rows[i - 1].top.toFixed(1)})`)
    }
    // 最远那行不能顶到地平线以上（那里是天空，图标会飘起来）。
    const farthest = rows[rows.length - 1]
    assert.ok(farthest.top >= ground.horizon - .5,
      `${width}x${height}: the farthest row stays below the horizon (${farthest.top.toFixed(1)} ≥ ${ground.horizon.toFixed(1)})`)
    // 所有行都在任务栏上方。
    assert.ok(rows[0].bottom <= ground.near + .5, `${width}x${height}: the nearest row clears the taskbar`)
  }
})

test('depth grid keeps its three rows on a normal desktop and shrinks on a small one', () => {
  const big = planDepthGrid(11, 1440, 900, TASKBAR)
  assert.equal(big.rows, 3)
  assert.deepEqual(big.scales.map(scale => Math.round(scale * 100) / 100), [.95, .78, .64])

  // 1024×640 以前三行会互相压住，现在三行仍在，只是行距按视觉高度给足。
  const mid = planDepthGrid(11, 1024, 640, TASKBAR)
  assert.equal(mid.rows, 3)
  const midHeight = mid.scales.reduce((sum, scale) => sum + rowHeight(scale), 0)
  assert.ok(midHeight <= mid.ground.near - 14 - mid.ground.horizon + .5)
})

test('depth grid drops a row instead of shrinking icons into illegible specks', () => {
  // 800×500 装不下三行大字：正确做法是排两行大图标，而不是把三行缩到 55%。
  const plan = planDepthGrid(11, 800, 500, TASKBAR)
  assert.equal(plan.rows, 2)
  assert.ok(plan.scales[0] >= .9, 'the nearest row keeps its size')
  // 任何一行缩小超过 10% 就说明应该少排一行了。
  const full = planDepthGrid(11, 1440, 900, TASKBAR)
  for (const scale of [...plan.scales, ...full.scales]) assert.ok(scale >= .64 * .9 - 1e-6)
})

test('depth grid gives up and lets the flat grid take over when there is no room', () => {
  // 极窄窗口：地面深度只剩几十像素，一行都摆不下——返回 null 交给平面兜底。
  assert.equal(planDepthGrid(11, 420, 300, TASKBAR), null)
})

test('depth grid counts columns by the nearest row width', () => {
  const plan = planDepthGrid(11, 1280, 800, TASKBAR)
  assert.ok(plan.pitch >= 96 * plan.scales[0] + 8 - .01, 'columns must be at least one icon wide')
  assert.ok(plan.rows * plan.cols >= 11)
})

test('rowHeight accounts for the label that is scaled back to 12px', () => {
  // 越远的一行整体越小，但名字被放大回 12px，所以行高不会同比缩小。
  assert.ok(rowHeight(.64) > ICON_SIZE * .64 + 6)
  assert.ok(rowHeight(.95) > rowHeight(.78))
  assert.ok(rowHeight(.78) > rowHeight(.64))
})

test('ground geometry stays consistent with the viewport', () => {
  const ground = groundOf(1280, 800, TASKBAR)
  assert.equal(ground.horizon, 800 * .46)
  assert.equal(ground.near, 800 - TASKBAR - 6)
  assert.equal(ground.scaleAt(ground.near), 1)
  assert.equal(ground.clampY(-100), ground.horizon)
  assert.equal(ground.clampY(9999), ground.near)
})
