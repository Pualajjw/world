import React from 'react'

const h = React.createElement
const caption = o => o.props.text || o.name
// PB uses & for a mnemonic and && for a literal ampersand.
const label = o => caption(o).replace(/&(&?)/g, '$1')
const marked = o => caption(o).split(/(&&|&.)/g).map((s, i) => s === '&&' ? '&' : s.startsWith('&') ? h('u', { key: i }, s.slice(1)) : s)
const separator = o => o.props.text === '-' || /^separator!?$/i.test(o.props.menuitemtype || '')

// The tree changes on disclosure, the preview on a change of open branch. Neither needs
// a new set of elements (or click closures) when switching between two visible leaves.
function treeRow(item, expanded, prefix) {
  const branch = Boolean(item.menuItems?.length), open = branch && expanded.has(item.id)
  return h('li', { key: item.id },
    h('div', { className: 'world-srm-tree-row' }, branch && h('button', { type: 'button', className: 'world-srm-toggle', 'data-srm-expand': item.id,
      'aria-label': `${open ? '折叠' : '展开'} ${label(item)}`, 'aria-expanded': open }, open ? '−' : '+'),
    h('button', { type: 'button', className: 'world-srm-label', title: item.name, id: prefix + item.id, 'aria-pressed': false }, label(item))),
    open && h('ul', null, item.menuItems.map(child => treeRow(child, expanded, prefix))))
}
function menuRow(item, path, prefix, top) {
  const branch = Boolean(item.menuItems?.length), open = branch && path.has(item.id), line = separator(item)
  return h('li', { key: item.id }, h('button', { type: 'button', title: item.name, id: prefix + item.id,
    className: `world-srm-entry${line ? ' is-separator' : ''}${open ? ' is-open' : ''}`,
    'aria-label': line ? '分隔线' : label(item), 'aria-pressed': false, 'aria-expanded': branch ? open : undefined },
    line ? h('hr') : h('span', null, marked(item)), !top && branch && h('span', { 'aria-hidden': true }, '▸')),
    open && h('ul', { className: 'world-srm-popup' }, item.menuItems.map(child => menuRow(child, path, prefix, false))))
}
export function SrmLayout({ model, obj, select, script, state }) {
  const { root, objects } = model, layout = React.useRef(null), id = React.useId()
  const treePrefix = `${id}-tree-`, menuPrefix = `${id}-menu-`
  const expanded = state.menuExpanded ||= new Set([root.id])
  const [, redraw] = React.useReducer(n => n + 1, 0)
  const tip = obj.menuItems?.length && state.closedMenu !== obj.id ? obj : objects.get(obj.menuParent)
  const tree = React.useMemo(() => treeRow(root, expanded, treePrefix), [root, expanded, treePrefix])
  const menu = React.useMemo(() => {
    const path = new Set()
    for (let o = tip; o && !path.has(o.id); o = objects.get(o.menuParent)) path.add(o.id)
    return root.menuItems?.map(item => menuRow(item, path, menuPrefix, true))
  }, [tip, objects, root, menuPrefix])

  // Reveal external selections, but allow a manual collapse until selection changes again.
  React.useLayoutEffect(() => {
    const original = state.menuExpanded, seen = new Set([obj.id]); let next = original
    for (let o = objects.get(obj.menuParent); o && !seen.has(o.id); o = objects.get(o.menuParent)) {
      seen.add(o.id)
      if (!next.has(o.id)) { if (next === original) next = new Set(original); next.add(o.id) }
    }
    if (next !== original) { state.menuExpanded = next; redraw() }
  }, [obj, objects, state])
  // Match SRD's paint layer: change only the two selected buttons by ID. Reapply if
  // a disclosure/remount exposes the same item. No item→DOM map survives a close.
  React.useLayoutEffect(() => {
    const scope = layout.current.getRootNode(), a = scope.getElementById(treePrefix + obj.id), b = scope.getElementById(menuPrefix + obj.id)
    a?.setAttribute('aria-pressed','true'); b?.setAttribute('aria-pressed','true')
    return () => { a?.setAttribute('aria-pressed','false'); b?.setAttribute('aria-pressed','false') }
  }, [obj, tree, menu, treePrefix, menuPrefix])

  const pick = (item, toggle = false) => {
    state.closedMenu = toggle && item === obj && state.closedMenu !== item.id ? item.id : null
    select(item)
  }
  const activate = (e, double = false) => {
    const button = e.target.closest('button')
    if (!button) return
    const key = button.dataset.srmExpand
    if (key !== undefined) {
      if (!double) {
        const next = new Set(expanded)
        if (next.has(key)) next.delete(key); else next.add(key)
        state.menuExpanded = next; redraw()
      }
      return
    }
    const preview = button.id.startsWith(menuPrefix), item = objects.get(button.id.slice((preview ? menuPrefix : treePrefix).length))
    if (item) { if (double) script(item); else pick(item, preview && item.menuItems?.length) }
  }
  return h('div', { ref: layout, className: 'world-srm-layout', onClick: e => activate(e), onDoubleClick: e => activate(e, true), onKeyDown: e => {
    if (e.key === 'Escape') { e.stopPropagation(); pick(root) }
  } }, h('section', { className: 'world-srm-tree', 'aria-label': '菜单树' },
    h('header', null, root.name), h('ul', null, tree)),
    h('section', { className: 'world-srm-preview', 'aria-label': '菜单预览', onClick: e => { if (e.target === e.currentTarget) pick(root) } },
      h('ul', { className: 'world-srm-bar' }, menu)))
}
