import { Text } from '@codemirror/state'

const newline = Text.of(['', ''])
const headers = { global: 'global variables', shared: 'shared variables', instance: 'type variables',
  globalExternal: 'type prototypes', localExternal: 'type prototypes' }
const textOf = raw => Text.of(raw.replace(/\r\n?/g, '\n').split('\n'))

// A Declare page is one document even if its source is interrupted by other
// scopes or directives. Its parts own their line endings, but never a neighbour's text.
export function declarationBounds(model, kind, source) {
  if (model.isApplication && kind === 'localExternal') return null
  const external = headers[kind] === 'type prototypes', key = `declare:${kind}`
  let ranges = model.declares[kind], wrapper = false
  if (!ranges.length) {
    const at = external && model.hasPrototypes ? model.prototypeInsertion : model.variableInsertion
    if (model.partial || at == null) return null
    wrapper = !external || !model.hasPrototypes
    ranges = [{ start: at, end: at, complete: true }]
  }
  let original = Text.empty
  const parts = ranges.map(({ start, end, inline, complete }, i) => {
    const raw = source.slice(start, end), eol = !inline && raw.match(/(\r?\n)$/)?.[0]
    const body = textOf(eol ? raw.slice(0, -eol.length) : raw)
    if (i) original = original.append(newline)
    const from = original.length
    original = original.append(body)
    return { key: `${key}:${start}`, start, end, from, body, inline, complete,
      prefix: wrapper ? (start && source[start - 1] !== '\n' ? '\n' : '') + headers[kind] + '\n' : '',
      suffix: wrapper ? `end ${external ? 'prototypes' : 'variables'}\n` : '',
      originalEol: eol || '', eol: inline ? '' : eol || '\n', sharedWrapper: external && wrapper }
  })
  return { key, parts, original, readOnly: parts.some(p => !p.complete) }
}

// Walk the change ranges and original seams together (linear for alternating
// global/local files). A paste replacing several runs keeps corresponding lines
// in their old slots, rather than moving the whole paste past the hidden scopes.
function mapSeams(patch) {
  const edits = []
  patch.mapping?.iterChangedRanges((a, b, c, d) => edits.push({ a, b, c, d }))
  let i = 0, shift = 0
  return pos => {
    while (i < edits.length && edits[i].a < pos && edits[i].b <= pos) {
      const edit = edits[i++]; shift = edit.d - edit.b
    }
    const r = edits[i]
    if (!r || pos <= r.a) return pos + shift
    const lines = patch.original.lineAt(pos).number - patch.original.lineAt(r.a).number
    const target = patch.doc.lineAt(r.c).number + lines
    return target <= patch.doc.lineAt(r.d).number ? patch.doc.line(target).from : r.d
  }
}

// Expand only at serialization, never on a click or keystroke. CM maps the
// original seams through edits so inserting lines before an interleaved global
// declaration doesn't push unrelated local declarations across it.
export function physicalPatches(patches) {
  const out = new Map(), wrappers = []
  for (const [key, patch] of patches) {
    if (!patch.parts) { out.set(key, patch); continue }
    const map = mapSeams(patch)
    let at = 0
    patch.parts.forEach((part, i) => {
      const next = patch.parts[i + 1]
      let cut = next ? map(next.from) : patch.doc.length
      if (next) {
        const line = patch.doc.lineAt(cut)
        if (cut !== line.from) cut = Math.min(line.to + 1, patch.doc.length)
      }
      const hasSeparator = next && cut > at && patch.doc.sliceString(cut - 1, cut) === '\n'
      let doc = patch.doc.slice(at, hasSeparator ? cut - 1 : cut); at = cut
      // An empty line between two declarations is not a deleted run. A terminal
      // newline typed in the editor is also distinct from the mandatory wrapper EOL.
      const keepLine = doc.length || hasSeparator || (!next && patch.doc.length && !patch.doc.line(patch.doc.lines).length)
      const ending = keepLine ? part.eol : ''
      if (doc.eq(part.body) && ending === part.originalEol) return
      if (part.inline && doc.lines > 1) {
        const directive = key === 'declare:global' ? '//:global_variables:' : '//:type_variables:'
        doc = Text.of(doc.toJSON().map((s, i) => i ? directive + s : s))
      }
      const p = { ...part, doc, suffix: ending + part.suffix }
      if (part.sharedWrapper) wrappers.push(p)
      else out.set(p.key, p)
    })
  }
  // Both empty external pages create the same missing type prototypes section.
  if (wrappers.length) {
    wrappers.sort(bySource)
    const [first, second] = wrappers
    out.set('insert:prototypes', { ...first, key: 'insert:prototypes', doc: second ? first.doc.append(newline).append(second.doc) : first.doc })
  }
  return out
}
export const bySource = (a, b) => a.start - b.start || a.end - b.end || a.key.localeCompare(b.key)
