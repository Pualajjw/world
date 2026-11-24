import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addTab, closestPaneEdge, groupById, groupsOf, makeGroup, moveTabToGroup, paneBounds, paneIds,
  paneRatioLimit, removeGroup, removeTab, setGroupActive, setPaneRatio, splitBounds, splitWithTab, tabGroupOf,
  visibleTabs,
} from '../vscode-layout.js'

const tree = () => ({
  axis: 'row',
  ratio: 0.25,
  children: [
    makeGroup('g1', ['a']),
    { axis: 'column', children: [makeGroup('g2', ['b']), makeGroup('g3', ['c'])] },
  ],
})

test('a leaf is a group of tabs with one active', () => {
  const group = makeGroup('g1', ['a', 'b'])
  assert.deepEqual(group, { group: 'g1', tabs: ['a', 'b'], active: 'a' })
  assert.equal(makeGroup('g1', ['a', 'b'], 'b').active, 'b')
  // active 不在 tabs 里就退回第一个
  assert.equal(makeGroup('g1', ['a'], 'zzz').active, 'a')
})

test('groups, bounds and the tabs actually on screen', () => {
  const layout = tree()
  assert.deepEqual(paneIds(layout), ['g1', 'g2', 'g3'])
  assert.deepEqual(groupsOf(layout).map(entry => entry.active), ['a', 'b', 'c'])
  assert.deepEqual(visibleTabs(layout), ['a', 'b', 'c'])
  assert.equal(tabGroupOf(layout, 'c'), 'g3')
  assert.equal(tabGroupOf(layout, 'nope'), null)
  assert.equal(groupById(layout, 'g2').group, 'g2')
  assert.deepEqual([...paneBounds(layout)], [
    ['g1', { x: 0, y: 0, w: 25, h: 100 }],
    ['g2', { x: 25, y: 0, w: 75, h: 50 }],
    ['g3', { x: 25, y: 50, w: 75, h: 50 }],
  ])
})

test('a group keeps several tabs and only shows the active one', () => {
  let layout = makeGroup('g1', ['a', 'b', 'c'], 'b')
  assert.deepEqual(visibleTabs(layout), ['b'])
  layout = setGroupActive(layout, 'g1', 'c')
  assert.deepEqual(visibleTabs(layout), ['c'])
  // 不在组里的标签切换无效
  assert.equal(setGroupActive(layout, 'g1', 'zzz').active, 'c')
  assert.equal(setGroupActive(layout, 'other', 'a'), layout)
})

test('adding and removing tabs collapses empty groups', () => {
  let layout = makeGroup('g1', ['a'])
  layout = addTab(layout, 'g1', 'b')
  assert.deepEqual(layout, { group: 'g1', tabs: ['a', 'b'], active: 'b' })
  layout = addTab(layout, 'g1', 'c', { index: 1, activate: false })
  assert.deepEqual(layout, { group: 'g1', tabs: ['a', 'c', 'b'], active: 'b' })
  // 关掉 active：接管它原来的位置
  layout = removeTab(layout, 'b')
  assert.deepEqual(layout, { group: 'g1', tabs: ['a', 'c'], active: 'c' })
  layout = removeTab(layout, 'c') || layout
  layout = removeTab(layout, 'a')
  assert.equal(layout, null, '最后一个标签关掉后组也没了')
  // 多组时只塌缩那一组
  const two = { axis: 'row', children: [makeGroup('g1', ['a']), makeGroup('g2', ['b', 'c'])] }
  assert.deepEqual(paneIds(removeTab(two, 'a')), ['g2'])
  assert.deepEqual(removeGroup(two, 'g2'), { group: 'g1', tabs: ['a'], active: 'a' })
})

test('moving a tab inside its group keeps the order it drops at', () => {
  const layout = makeGroup('g1', ['a', 'b', 'c'], 'a')
  assert.deepEqual(moveTabToGroup(layout, 'c', 'g1', 0), { group: 'g1', tabs: ['c', 'a', 'b'], active: 'c' })
  assert.deepEqual(moveTabToGroup(layout, 'a', 'g1', 2), { group: 'g1', tabs: ['b', 'c', 'a'], active: 'a' })
})

test('moving a tab to another group leaves the source group alive when it still has tabs', () => {
  const layout = { axis: 'row', children: [makeGroup('g1', ['a', 'b'], 'a'), makeGroup('g2', ['c'])] }
  const moved = moveTabToGroup(layout, 'a', 'g2')
  assert.deepEqual(paneIds(moved), ['g1', 'g2'])
  assert.deepEqual(groupById(moved, 'g1'), { group: 'g1', tabs: ['b'], active: 'b' })
  assert.deepEqual(groupById(moved, 'g2'), { group: 'g2', tabs: ['c', 'a'], active: 'a' })
  // 源组只剩一个标签时被搬走 → 整组消失
  const single = { axis: 'row', children: [makeGroup('g1', ['a']), makeGroup('g2', ['b'])] }
  const collapsed = moveTabToGroup(single, 'a', 'g2')
  assert.deepEqual(paneIds(collapsed), ['g2'])
  assert.deepEqual(groupById(collapsed, 'g2').tabs, ['b', 'a'])
})

test('moving a file into an empty welcome group keeps two panes and the terminal', () => {
  const layout = { axis: 'column', children: [makeGroup('top', ['app:terminal', 'file'], 'file'), makeGroup('bottom', [])] }
  const moved = moveTabToGroup(layout, 'file', 'bottom')
  assert.deepEqual(paneIds(moved), ['top', 'bottom'])
  assert.deepEqual(groupById(moved, 'top').tabs, ['app:terminal'])
  assert.deepEqual(groupById(moved, 'bottom').tabs, ['file'])
  assert.equal(groupById(moved, 'bottom').active, 'file')
})

test('dragging a tab to an edge opens a new group beside that pane', () => {
  const layout = makeGroup('g1', ['a', 'b'], 'a')
  const right = splitWithTab(layout, 'g1', 'b', 'right', 'g2')
  assert.deepEqual(right, {
    axis: 'row',
    children: [
      { group: 'g1', tabs: ['a'], active: 'a' },
      { group: 'g2', tabs: ['b'], active: 'b' },
    ],
  })
  const top = splitWithTab(layout, 'g1', 'b', 'top', 'g2')
  assert.equal(top.axis, 'column')
  assert.equal(top.children[0].group, 'g2', 'top 在上')
  // 拖的是某一格唯一的标签、目标又是那一格自己：什么都不做（不能把整格搬走）
  const only = makeGroup('g1', ['a'])
  assert.equal(splitWithTab(only, 'g1', 'a', 'right', 'g2'), only)
  // 拖到另一个格的边缘
  const three = splitWithTab(tree(), 'g2', 'a', 'bottom', 'g9')
  assert.deepEqual(paneIds(three), ['g2', 'g9', 'g3'])
})

test('split bounds describe where each divider sits', () => {
  assert.deepEqual(splitBounds(tree()), [
    { path: [], axis: 'row', rect: { x: 0, y: 0, w: 100, h: 100 }, ratio: 0.25 },
    { path: [1], axis: 'column', rect: { x: 25, y: 0, w: 75, h: 100 }, ratio: 0.5 },
  ])
  assert.deepEqual(splitBounds(makeGroup('g1', ['a'])), [])
  assert.deepEqual(splitBounds(null), [])
})

test('a split ratio moves the divider without touching the tree', () => {
  let layout = splitWithTab(makeGroup('g1', ['a', 'b'], 'a'), 'g1', 'b', 'right', 'g2')
  assert.deepEqual([...paneBounds(layout).values()], [{ x: 0, y: 0, w: 50, h: 100 }, { x: 50, y: 0, w: 50, h: 100 }])
  layout = setPaneRatio(layout, [], 0.25)
  assert.deepEqual([...paneBounds(layout)], [['g1', { x: 0, y: 0, w: 25, h: 100 }], ['g2', { x: 25, y: 0, w: 75, h: 100 }]])
  assert.equal(setPaneRatio(layout, [], 1.4).ratio, 0.95)
  assert.equal(setPaneRatio(layout, [], -3).ratio, 0.05)
})

test('divider limits keep both sides readable', () => {
  assert.equal(paneRatioLimit(900), 0.2)
  assert.equal(paneRatioLimit(300), 0.45)
  assert.equal(paneRatioLimit(4000), 0.1)
  assert.equal(paneRatioLimit(0), 0.5)
  assert.equal(paneRatioLimit(Number.NaN), 0.5)
})

test('drop direction follows the nearest normalized edge', () => {
  const rect = { left: 100, right: 900, top: 200, bottom: 600, width: 800, height: 400 }
  for (const [x, y, expected] of [[110, 400, 'left'], [890, 400, 'right'], [500, 205, 'top'], [500, 595, 'bottom']]) {
    assert.equal(closestPaneEdge(rect, x, y), expected)
  }
})
