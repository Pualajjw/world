import { Text } from '@codemirror/state'
import { physicalPatches, bySource } from './srw-declarations.js'

/** The parser's offsets are stable for this design session. Patches share immutable
 * text with the editor; only save / switching back to source needs a flat string. */
export function createEdits(inheritedDirty = false) {
  return { patches: new Map(), saved: new Map(), different: new Set(), inheritedDirty }
}
export const editsDirty = e => e.inheritedDirty || e.different.size !== 0
export function editBounds(range, source) {
  if (!range.complete || range.editStart === null) return null
  const start = range.editStart ?? range.start
  const ending = source.slice(Math.max(start, range.end - 2), range.end)
  const keep = range.inline ? 0 : ending.endsWith('\r\n') ? 2 : ending.endsWith('\n') ? 1 : 0
  return { prefix: range.insert ? (start && source[start-1] !== '\n' ? '\n' : '') + 'type variables\n' : '', suffix: range.insert ? 'end variables\n' : '',
    needBreak: !range.inline && start === range.end, key: range.id || `vars:${range.start}`, start, end: range.end - keep }
}
export function openBody(session, bounds) {
  const patch = session.edits.patches.get(bounds.key)
  let original = (patch ?? session.edits.saved.get(bounds.key))?.original ?? bounds.original
  if (!original) {
    const raw = session.text.slice(bounds.start, bounds.end)
    original = Text.of((raw.includes('\r') ? raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n') : raw).split('\n'))
  }
  return { original, doc: patch?.doc ?? original }
}
export function setBody(session, bounds, doc, original, changes) {
  const e = session.edits, saved = e.saved.get(bounds.key), unchanged = doc.eq(original)
  if (unchanged) e.patches.delete(bounds.key)
  else if (saved && doc.eq(saved.doc)) e.patches.set(bounds.key, saved)
  else {
    const previous = e.patches.get(bounds.key)?.mapping
    const mapping = bounds.parts?.length > 1 ? (previous ? previous.composeDesc(changes.desc) : changes.desc) : undefined
    e.patches.set(bounds.key, { ...bounds, original, doc, mapping })
  }
  if (saved ? doc.eq(saved.doc) : unchanged) e.different.delete(bounds.key)
  else e.different.add(bounds.key)
}
const trailingBreak = p => p.needBreak && p.doc.line(p.doc.lines).length ? '\n' : ''
const replacementLength = p => p.prefix.length + p.doc.length + trailingBreak(p).length + p.suffix.length
const samePatch = (a, b) => a === b || Boolean(a && b && a.prefix === b.prefix && a.suffix === b.suffix && a.doc.eq(b.doc))

// Offsets in the last acknowledged file and this save. The host can preserve even
// mixed CR/LF/CRLF bytes outside these edits, without duplicating the source in RPC.
export function designChanges(e) {
  if (e.inheritedDirty) return undefined
  const saved = physicalPatches(e.saved), pending = physicalPatches(e.patches)
  const spans = [], keys = new Map([...saved, ...pending]); let oldShift = 0, newShift = 0
  for (const [key, p] of [...keys].sort((a,b) => bySource(a[1], b[1]))) {
    const old = saved.get(key), next = pending.get(key), size = p.end - p.start
    const oldSize = old ? replacementLength(old) : size, newSize = next ? replacementLength(next) : size
    if (!samePatch(old, next)) spans.push([p.start + oldShift, p.start + oldShift + oldSize, p.start + newShift, p.start + newShift + newSize])
    oldShift += oldSize - size; newShift += newSize - size
  }
  return spans
}
export function designText(session, patches = session.edits.patches) {
  if (!patches.size) return session.text
  let at = 0; const parts = []
  for (const p of [...physicalPatches(patches).values()].sort(bySource)) {
    if (at > p.start || p.end < p.start || p.end > session.text.length) throw new Error('源码片段范围冲突，未保存。')
    parts.push(session.text.slice(at, p.start), p.prefix, p.doc.toString(), trailingBreak(p), p.suffix); at = p.end
  }
  parts.push(session.text.slice(at)); return parts.join('')
}
export function acknowledgeEdits(e, sent) {
  e.saved = sent; e.inheritedDirty = false; e.different.clear()
  for (const key of new Set([...sent.keys(), ...e.patches.keys()])) {
    if (!samePatch(sent.get(key), e.patches.get(key))) e.different.add(key)
  }
}
