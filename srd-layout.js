import React from 'react'

// Static design-mode equivalents of srd_preview.py's Units, css_font, bg_color and object_text.
const h = React.createElement
const literal = v => v?.split('\t', 1)[0].trim()
const num = (v, fallback = 0) => { const n = Number(literal(v)); return Number.isFinite(n) ? n : fallback }
const systemColors = { 553648127: '#d4d0c8', 268435456: '#000000', 33554432: '#808080' }
function rgb(value) {
  const s = literal(value)
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  return n >= 0x1000000 ? systemColors[n] : `rgb(${n & 255},${n >> 8 & 255},${n >> 16 & 255})`
}
const unitsLabel = ['PBU', 'px', '1/1000 inch', '1/1000 cm']
function axes(units) {
  const scale = units === 2 ? 96 / 1000 : units === 3 ? 96 / 2540 : 1
  return { x: n => n * (units === 0 ? 7/32 : scale), y: n => n * (units === 0 ? 1/4 : scale) }
}
function objectText({type, props: p, name}) {
  const text = literal(p.text)
  switch (type) {
    case 'text': case 'groupbox': return text || ''
    case 'compute': return text || (p.expression ? `=${literal(p.expression)}` : '')
    case 'bitmap': case 'picture': return `[图片] ${literal(p.file || p.filename) || ''}`
    case 'report': return `[嵌套报表] ${name}`
    case 'graph': return `[图形] ${name}`
    default: return text || name
  }
}
const shapeTypes = new Set(['rectangle', 'roundrectangle', 'oval', 'ellipse', 'arc', 'chord', 'pie'])
const borders = ['none', '1px solid #808080', '1px solid #000', '1px solid #808080', 'none', '2px groove #808080', '2px ridge #808080']
const pens = ['solid', 'dashed', 'dotted', 'dashed', 'dashed', 'none']
function paintObject(obj, { x, y }, prefix) {
  const { type, props: p, box } = obj
  const backgroundColor = literal(p['background.mode']) === '1' || literal(p['brush.mode']) === '1' ? 'transparent'
    : rgb(p['background.color']) || rgb(p['brush.color']) || 'transparent'
  const style = { left: x(box.x), top: y(box.y), width: x(box.width), height: y(box.height), backgroundColor,
    opacity: literal(p.visible) === '0' ? .3 : undefined }
  let content
  if (type === 'line' || shapeTypes.has(type)) {
    const pen = `${Math.max(1, x(num(p['pen.width'], 1)))}px ${pens[num(p['pen.style'])] || 'solid'} ${rgb(p['pen.color']) || '#000'}`
    if (type === 'line') {
      const dx = x(num(p.x2) - num(p.x1)), dy = y(num(p.y2) - num(p.y1))
      if (literal(p['pen.style']) === '5') return null
      Object.assign(style, { left: x(num(p.x1)), top: y(num(p.y1)), width: Math.hypot(dx, dy), height: 0,
        transformOrigin: '0 0', transform: `rotate(${Math.atan2(dy, dx)}rad)`, border: 'none', borderTop: pen })
    } else {
      style.border = pen
      if (type === 'oval' || type === 'ellipse') style.borderRadius = '50%'
      if (type === 'roundrectangle') style.borderRadius = `${x(num(p.ellipsewidth, num(p.rx, 8) * 2)) / 2}px / ${y(num(p.ellipseheight, num(p.rx, 8) * 2)) / 2}px`
    }
  } else {
    const size = num(p['font.height']), fontPx = size < 0 ? -size * 96 / 72 : size || 13, rotation = num(p['font.escapement']) / 10
    const text = objectText(obj), lineHeight = fontPx * 1.25
    const wrap = /[\r\n]/.test(text) || (style.height >= lineHeight * 1.65 &&
      (text.length - (text.match(/[\x00-\x7f]/g)?.length || 0) * .45) * fontPx > Math.max(fontPx * 2, style.width - fontPx * .6))
    Object.assign(style, { whiteSpace: wrap ? 'pre-wrap' : 'nowrap', textOverflow: wrap ? 'clip' : 'ellipsis', color: rgb(p.color), textAlign: ['left','right','center','justify'][num(p.alignment)],
      fontFamily: literal(p['font.face']), fontSize: fontPx,
      fontWeight: num(p['font.weight'], 400), fontStyle: literal(p['font.italic']) === '1' ? 'italic' : undefined,
      textDecoration: [literal(p['font.underline']) === '1' && 'underline', literal(p['font.strikethrough']) === '1' && 'line-through'].filter(Boolean).join(' '),
      border: type === 'groupbox' ? '1px solid #808080' : borders[num(p.border)],
      borderBottom: literal(p.border) === '4' ? '1px solid #000' : undefined,
      transform: rotation ? `rotate(${rotation}deg)` : undefined, transformOrigin: rotation ? '0 0' : undefined })
    content = type === 'groupbox' ? h('span', null, text) : text
  }
  return h('button', { key: obj.id, id: prefix + obj.id, type: 'button', className: 'world-srw-control world-srd-object', 'data-type': type,
    'aria-label': `${type} ${obj.name}`, 'aria-pressed': false, title: `${type} · ${obj.name}`, style }, content)
}
// A parsed band is immutable. Keep its button elements (including geometry, text and
// tab order) in one paint layer, not a component, callback or cached style per object.
const BandObjects = React.memo(function BandObjects({ band, scale, prefix }) {
  return band.children.map(obj => paintObject(obj, scale, prefix))
})
// The closest scroll offset that shows the whole interval (or, for an oversized
// object, as much as fits). An interval already spanning the viewport stays put.
function nearestDelta(start, end, low, high) {
  const a = start - low, b = end - high
  if (a < 0 && b < 0) return Math.floor(Math.max(a, b))
  if (a > 0 && b > 0) return Math.ceil(Math.min(a, b))
  return 0
}
function revealInLayout(node, toolbar) {
  const pane = node.closest('[data-srw-view="layout"]')
  if (!pane?.clientWidth || !pane.clientHeight) return
  let { left, right, top, bottom } = node.getBoundingClientRect()
  const clip = node.closest('.world-srd-band')?.getBoundingClientRect()
  if (clip) {
    left = Math.max(left, clip.left); right = Math.min(right, clip.right)
    top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom)
  }
  if (right <= left || bottom <= top) return // nothing painted; keep the overflow setting
  const view = pane.getBoundingClientRect(), x = view.left + pane.clientLeft, y = view.top + pane.clientTop
  const dx = nearestDelta(left, right, x, x + pane.clientWidth)
  const bar = toolbar.getBoundingClientRect()
  // The toolbar sticks vertically but scrolls with the object horizontally. Reserve
  // its height only where it will actually overlap the target after the horizontal move.
  const underBar = Math.max(left, bar.left, x + dx) < Math.min(right, bar.right, x + dx + pane.clientWidth)
  const dy = nearestDelta(top, bottom, underBar ? Math.max(y, bar.bottom) : y, y + pane.clientHeight)
  if (dx || dy) pane.scrollBy({left: dx, top: dy, behavior: 'instant'}) // never focus or scroll an ancestor
}
export function SrdLayout({ model, selected, select, overflow, onOverflow, revealRef }) {
  const { root, bands, foreground } = model, scale = React.useMemo(() => axes(model.units), [model.units])
  const sheet = React.useRef(null), toolbar = React.useRef(null), prefix = React.useId() + '-srd-'
  React.useImperativeHandle(revealRef, () => obj => {
    if (!obj.box || !sheet.current?.isConnected) return
    const node = sheet.current.getRootNode().getElementById(prefix + obj.id)
    if (node) revealInLayout(node, toolbar.current)
  }, [prefix])
  // React initializes each button to unpressed. Only this effect owns the live pressed
  // marker. A scoped DOM id avoids both a linear scan and a second object->node map.
  React.useLayoutEffect(() => {
    if (!selected.box) return // root / band markers are rendered by their own controls
    const node = sheet.current.getRootNode().getElementById(prefix + selected.id)
    if (!node) return // e.g. a line with pen.style=5 selected from Properties
    node.setAttribute('aria-pressed', 'true')
    return () => node.setAttribute('aria-pressed', 'false')
  }, [selected, prefix])
  const draw = band => h(BandObjects, { band, scale, prefix })
  const pick = event => {
    const button = event.target.closest('.world-srd-object')
    if (button) {
      const obj = model.objects.get(button.id.slice(prefix.length))
      if (obj) select(obj)
    }
  }
  return h(React.Fragment, null,
    h('div', { ref: toolbar, className: 'world-srw-zoom' }, h('button', { type: 'button', onClick: () => select(root), 'aria-pressed': selected === root }, `DataWindow · ${root.name}`),
      h('label', null, h('input', { type: 'checkbox', checked: Boolean(overflow), onChange: e => onOverflow(e.target.checked) }), '显示带区溢出内容')),
    h('div', { ref: sheet, onClick: pick, className: 'world-srw-window world-srd-sheet', style: { minWidth: Math.ceil(scale.x(model.width)), backgroundColor: rgb(root.props.color) } },
      bands.map(band => h('div', { key: band.id, className: 'world-srw-client world-srd-band', 'data-band': band.name, 'aria-label': band.name,
        'data-selected': selected === band, style: { height: scale.y(overflow ? Math.max(band.bottom, band.height) : band.height), backgroundColor: rgb(band.props.color) },
        onClick: e => { if (e.target === e.currentTarget) select(band) } }, h('span', { className: 'world-srd-band-label' }, `${band.name} (${band.height})`), draw(band))),
      foreground && h('div', { className: 'world-srd-foreground', 'aria-label': 'foreground' }, draw(foreground))))
}
// The model fixes the labels and ordering. Keep the native picker, but don't retain
// a React subtree per option or make a controlled <select> walk them on every click.
function PropertyObjectPicker({ objects, selectedId, select }) {
  const ref = React.useRef(null)
  React.useLayoutEffect(() => {
    const picker = ref.current, doc = picker.ownerDocument, options = doc.createDocumentFragment()
    for (const obj of objects.values()) {
      const option = doc.createElement('option')
      option.value = obj.id; option.textContent = `${obj.type} · ${obj.name}`
      options.appendChild(option)
    }
    picker.replaceChildren(options)
  }, [objects])
  React.useLayoutEffect(() => {
    const picker = ref.current
    if (picker.value !== selectedId) picker.value = selectedId
  }, [objects, selectedId])
  return h('select', { ref, 'aria-label': '属性对象', onChange: e => select(objects.get(e.currentTarget.value)) })
}
export function SrdProperties({ model, selected: obj, select, propList }) {
  const groups = new Map(), add = (section, key, value) => {
    if (!groups.has(section)) groups.set(section, [])
    groups.get(section).push([key, value])
  }
  for (const [key, value] of Object.entries(obj.props)) {
    const section = /^([xy][12]?|width|height)$/.test(key) ? '位置与尺寸' : key.startsWith('font.') ? '字体' : /^(brush|pen|background)\.|^(color|alignment|border)$/.test(key) ? '外观' : '属性'
    add(section, key, value)
  }
  if (obj.type === 'band') {
    add('带区信息', '控件数量', obj.children.length)
    add('带区信息', '内容高度', `${axes(model.units).y(obj.bottom)} px`)
  }
  if (obj === model.root) add('布局', '坐标单位', unitsLabel[model.units] || model.units)
  if (obj.column) for (const [key, val] of Object.entries(obj.column)) add('绑定列', key, val)
  return h(React.Fragment, null, h('nav', null, h(PropertyObjectPicker, { objects: model.objects, selectedId: obj.id, select })),
    [...groups].map(([label, rows]) => h('details', { key: `${obj.id}:${label}`, className: 'world-srw-group', open: true }, h('summary', null, label), propList(rows))))
}
