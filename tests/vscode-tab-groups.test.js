import test from 'node:test'
import assert from 'node:assert/strict'
import { editLayout, emptyDeck, memberIds, moveMember, ownership, reconcileDeck, wrapTab } from '../vscode-tab-groups.js'
import { moveTabToGroup, setPaneRatio, splitWithTab, visibleTabs } from '../vscode-layout.js'

const ids = ['a', 'b', 'c', 'd']
const start = () => reconcileDeck(emptyDeck(), ids, 'a')

test('wrapping replaces a tab in place, keeping the outer split and independent inner splits', () => {
  let deck = editLayout(start(), '', layout => splitWithTab(layout, 'main', 'd', 'bottom', 'outer'))
  deck = wrapTab(deck, 'a', 'p', 'group', 'inner')
  assert.deepEqual(memberIds(deck.root), ['p', 'b', 'c', 'd'])
  deck = moveMember(deck, 'b', 'p')
  deck = editLayout(deck, 'p', layout => splitWithTab(layout, 'inner', 'b', 'right', 'right'))
  deck = editLayout(deck, 'p', layout => setPaneRatio(layout, [], .64))
  const { layout } = deck.parents.p
  deck = reconcileDeck(deck, ids, 'c')
  assert.equal(deck.parents.p.layout, layout)
  assert.deepEqual(visibleTabs(deck.root), ['c', 'd'])
  deck = reconcileDeck(deck, ids, 'b')
  assert.deepEqual(visibleTabs(deck.root), ['p', 'd'])
  assert.deepEqual(visibleTabs(deck.parents.p.layout), ['a', 'b'])
  assert.equal(deck.parents.p.layout.ratio, .64)
  assert.equal(reconcileDeck(deck, ids, 'b'), deck, 'unchanged documents/focus do not allocate new layout state')
  deck = editLayout(deck, 'p', layout => moveTabToGroup(layout, 'b', 'inner', 0))
  assert.deepEqual(deck.parents.p.layout.tabs, ['b', 'a'])
})

test('move between parents and back out without duplicating children; remove empty parents', () => {
  let deck = wrapTab(wrapTab(start(), 'b', 'p', 'first', 'one'), 'c', 'q', 'second', 'two')
  deck = moveMember(deck, 'b', 'q')
  assert.deepEqual(Object.keys(deck.parents), ['q'])
  assert.deepEqual(memberIds(deck.root), ['a', 'q', 'd'])
  assert.deepEqual(memberIds(deck.parents.q.layout), ['c', 'b'])
  deck = moveMember(deck, 'c', undefined)
  deck = moveMember(deck, 'b', undefined)
  assert.deepEqual(Object.keys(deck.parents), [])
  assert.deepEqual(memberIds(deck.root), ['a', 'b', 'd', 'c'])
})

test('closing or losing a child during a background read leaves no orphan ids', () => {
  let deck = moveMember(wrapTab(start(), 'a', 'p', 'group', 'inner'), 'b', 'p')
  deck = reconcileDeck(deck, ['a','c','d'], 'c')
  assert.equal(deck.parents.p.active, 'a')
  deck = reconcileDeck(deck, ['c','d'], 'c')
  assert.equal(ownership(deck.parents).size, 0)
  assert.deepEqual(memberIds(deck.root), ['c','d'])
  assert.deepEqual(reconcileDeck(deck, [], ''), emptyDeck())
})
