// DataWindow exports are nested clauses, not PowerScript type declarations. Only top-level
// painter objects belong on the canvas (not table(column=(...)), retrieve SQL or HTML settings).
const controls = new Set('column text compute line rectangle roundrectangle oval ellipse arc chord pie bitmap picture groupbox button report graph chart crosstab ole oleobject'.split(' '))
const bandType = /^(header|detail|trailer|summary|footer)(?:\.\d+)?$/
const bandName = s => s.toLowerCase().replace(/\[(\d+)\]$/, '.$1')
const escapes = { r: '\r', n: '\n', t: '\t' }
const numeric = value => {
  const n = Number(String(value ?? '').split('\t', 1)[0]); return Number.isFinite(n) ? n : 0
}

// Called at an opening parenthesis or quote. Yield during large table/data clauses as well
// as between objects, so cancelling an open does not have to wait for the whole export.
function* afterValue(text, start) {
  let quote = '', depth = 0
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (quote) { if (c === '~') i++; else if (c === quote) quote = '' }
    else if (c === '"' || c === "'") quote = c
    else if (c === '(') depth++
    else if (c === ')') depth--
    if (!depth && !quote) return i + 1
    if ((i & 8191) === 0) yield
  }
  return text.length
}
function* propsOf(body, columns, flatten = true) {
  const props = Object.create(null), attr = /([\w.[\]-]+)\s*=\s*/gy
  for (let i = 0; i < body.length;) {
    attr.lastIndex = i
    const m = attr.exec(body)
    if (!m) { i++; continue }
    const start = attr.lastIndex, c = body[start], key = m[1].toLowerCase()
    i = start
    let value
    if (c === '"' || c === "'" || c === '(') {
      i = yield* afterValue(body, start)
      if (columns && key !== 'column') continue // skip e.g. retrieve SQL without copying/decoding it
      value = c === '(' ? body.slice(start, i) : body.slice(start + 1, i - 1).replace(/~(.)/gs, (_, ch) => escapes[ch] ?? ch)
    } else {
      while (i < body.length && !/[\s,]/.test(body[i])) i++
      value = body.slice(start, i)
    }
    if (columns) {
      if (key === 'column' && c === '(') { columns.push(yield* propsOf(value.slice(1, -1))); yield }
    } else if (flatten && c === '(' && /^(font|background|brush|pen)$/.test(key)) {
      for (const [k, v] of Object.entries(yield* propsOf(value.slice(1, -1), null, false))) props[`${key}.${k}`] = v
    } else props[key] = value
  }
  return props
}
function bounds(type, p) {
  if (type === 'line') {
    const x1 = numeric(p.x1), x2 = numeric(p.x2), y1 = numeric(p.y1), y2 = numeric(p.y2)
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
  }
  return { x: numeric(p.x), y: numeric(p.y), width: Math.max(0, numeric(p.width)), height: Math.max(0, numeric(p.height)) }
}
export function* scanSrd(text, path) {
  const objects = new Map(), bands = new Map(), columns = []
  const bandFor = name => {
    if (!bands.has(name)) {
      const band = { id: `band:${name}`, name, type: 'band', props: {}, children: [], bottom: 0 }
      bands.set(name, band); objects.set(band.id, band)
    }
    return bands.get(name)
  }
  let root = null, width = 0
  const clause = /(?:^|(?<=[;)]))[^\S\r\n]*([\w.[\]-]+)\s*\(/gmi
  for (let m; (m = clause.exec(text));) {
    const type = bandName(m[1]), start = clause.lastIndex
    const end = yield* afterValue(text, start - 1)
    clause.lastIndex = end
    yield
    if (type === 'table') { yield* propsOf(text.slice(start, end - 1), columns); continue }
    if (type !== 'datawindow' && type !== 'group' && !bandType.test(type) && !controls.has(type)) continue
    const p = yield* propsOf(text.slice(start, end - 1))
    if (type === 'datawindow') {
      root = { id: 'datawindow', name: path.split(/[\\/]/).pop().replace(/\.srd$/i, ''), type, props: p }
      objects.set(root.id, root)
    } else if (bandType.test(type)) Object.assign(bandFor(type).props, p)
    else if (type === 'group') {
      for (const part of ['header', 'trailer']) {
        const band = bandFor(`${part}.${numeric(p.level) || 1}`)
        for (const [key, val] of Object.entries(p)) {
          if (key.startsWith(`${part}.`)) band.props[key.slice(part.length + 1)] = val
          else if (!key.includes('.')) band.props[key] = val
        }
      }
    } else {
      const band = bandFor(bandName(p.band || 'detail')), box = bounds(type, p)
      const name = p.name || type, key = `${band.id}/${name}`
      const obj = { id: objects.has(key) ? `${key}:${start}` : key, name, type, props: p, box }
      objects.set(obj.id, obj); band.children.push(obj)
      band.bottom = Math.max(band.bottom, box.y + box.height); width = Math.max(width, box.x + box.width)
    }
  }
  const order = { header: 0, detail: 1, trailer: 2, summary: 3, footer: 4 }
  const foreground = bands.get('foreground')
  bands.delete('foreground')
  const byName = new Map(columns.map(col => [col.name?.toLowerCase(), col]))
  for (const obj of objects.values()) if (obj.type === 'column') obj.column = columns[numeric(obj.props.id) - 1] || byName.get(obj.name.toLowerCase())
  const sorted = [...bands.values()].sort((a, b) => {
    const [at, an] = a.name.split('.'), [bt, bn] = b.name.split('.')
    return (order[at] ?? 5) - (order[bt] ?? 5) || (at === 'trailer' ? -1 : 1) * (numeric(an) - numeric(bn))
  })
  for (const band of sorted) band.height = band.props.height == null ? band.bottom : Math.max(0, numeric(band.props.height))
  return { root, objects, bands: sorted, foreground, width, units: numeric(root?.props.units) }
}
