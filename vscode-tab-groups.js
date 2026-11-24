/** Layout metadata only. Documents and editor instances never belong to a parent tab. */
import { addTab, groupsOf, groupById, makeGroup, removeTab, replaceGroup, setGroupActive, tabGroupOf } from './vscode-layout.js'

export const emptyDeck = () => ({ root: makeGroup('main', []), parents: {} })
export const memberIds = layout => groupsOf(layout).flatMap(group => group.tabs)
export function ownership(parents) {
  const result = new Map()
  for (const parent of Object.values(parents)) for (const id of memberIds(parent.layout)) result.set(id, parent.id)
  return result
}
export function editLayout(deck, scope, change) {
  if (!scope) return { ...deck, root: change(deck.root) }
  const parent = deck.parents[scope]
  if (!parent) return deck
  return { ...deck, parents: { ...deck.parents, [scope]: { ...parent, layout: change(parent.layout) } } }
}
export function replaceId(layout, from, to) {
  const gid = tabGroupOf(layout, from), pane = groupById(layout, gid)
  return pane ? replaceGroup(layout, gid, makeGroup(gid, pane.tabs.map(id => id === from ? to : id), pane.active === from ? to : pane.active)) : layout
}
export function wrapTab(deck, id, key, label, gid) {
  if (!tabGroupOf(deck.root, id) || deck.parents[id] || deck.parents[key]) return deck
  return { root: replaceId(deck.root, id, key), parents: { ...deck.parents,
    [key]: { id: key, kind: 'tab-group', pinned: true, path: label, active: id, layout: makeGroup(gid, [id]) } } }
}
/** 把成员摘出父组但保留组本身（组里最后一个文件被设计视图接管时，组不能跟着消失）。 */
export function detachMember(deck, id) {
  const src = ownership(deck.parents).get(id)
  if (!src) return deck
  const parent = deck.parents[src], layout = removeTab(parent.layout, id)
  const parents = { ...deck.parents }
  if (layout) parents[src] = { ...parent, layout, active: parent.active === id ? groupsOf(layout)[0]?.active : parent.active }
  // 空组沿用原来的组 id，留着标签栏上的「标签组 N」；keepEmpty 让 reconcile 不要把它扫掉。
  else parents[src] = { ...parent, layout: makeGroup(groupsOf(parent.layout)[0].gid, []), active: undefined, keepEmpty: true }
  return { ...deck, parents }
}
export function moveMember(deck, id, dest) {
  const src = ownership(deck.parents).get(id)
  if (src === dest || deck.parents[id] || (dest && !deck.parents[dest]) || (!src && !tabGroupOf(deck.root, id))) return deck
  let root = deck.root
  const parents = { ...deck.parents }
  const oldGid = tabGroupOf(root, src || id)
  if (src) {
    const from = parents[src], layout = removeTab(from.layout, id)
    if (layout) parents[src] = { ...from, layout, active: from.active === id ? groupsOf(layout)[0].active : from.active }
    else { root = dest ? removeTab(root, src) : replaceId(root, src, id); delete parents[src] }
  } else root = removeTab(root, id)
  if (dest) {
    const to = parents[dest]
    parents[dest] = { ...to, active: id, layout: addTab(to.layout, tabGroupOf(to.layout, to.active), id) }
  } else if (!tabGroupOf(root, id)) root = addTab(root, oldGid, id)
  return { root, parents }
}
/** Reflect real opens/closes/focus without rebuilding unchanged trees. */
export function reconcileDeck(deck, ids, active, focus) {
  const known = new Set(ids)
  let { parents, root } = deck
  for (const parent of Object.values(parents)) {
    let layout = parent.layout
    for (const id of memberIds(layout)) if (!known.has(id)) layout = removeTab(layout, id)
    const gid = tabGroupOf(layout, active), selected = gid ? active : tabGroupOf(layout, parent.active) ? parent.active : groupsOf(layout)[0]?.active
    if (gid && groupById(layout, gid).active !== active) layout = setGroupActive(layout, gid, active)
    if (layout === parent.layout && selected === parent.active) continue
    if (parents === deck.parents) parents = { ...parents }
    if (!layout) delete parents[parent.id]
    else parents[parent.id] = { ...parent, layout, active: selected }
  }
  const owners = ownership(parents), wanted = new Set(ids.map(id => owners.get(id) || id))
  // 被设计视图接管后留下的空组：没有成员，但用户建的分组还在，保留到显式关闭。
  for (const parent of Object.values(parents)) if (parent.keepEmpty && !memberIds(parent.layout).length) wanted.add(parent.id)
  const present = new Set(memberIds(root))
  for (const id of present) if (!wanted.has(id)) root = removeTab(root, id)
  if (!root) root = makeGroup('main', [])
  const target = groupById(root, focus)?.group || groupsOf(root)[0].gid
  for (const id of wanted) if (!present.has(id)) root = addTab(root, target, id, { activate: false })
  const outer = owners.get(active) || active, gid = tabGroupOf(root, outer)
  if (gid && groupById(root, gid).active !== outer) root = setGroupActive(root, gid, outer)
  return root === deck.root && parents === deck.parents ? deck : { root, parents }
}
