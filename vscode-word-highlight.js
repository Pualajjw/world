/** Clicked words are local to a single text surface. Never change the selection or edit history. */
import React from 'react'
import { StateEffect } from '@codemirror/state'
import { Decoration, ViewPlugin } from '@codemirror/view'

const wordChar = /[\p{ID_Continue}$]/u, pbWordChar = /[\p{ID_Continue}$#-]/u, probe = 1024
const startOfPoint = (s, i) => i > 0 && /[\uDC00-\uDFFF]/.test(s[i]) ? i - 1 : i
// PB compiled/source suffixes are filenames in Script literals, not member access.
const objectSuffix = /^(?:apl|dwo|fun|men|str|udo|win|wnd|sr[adfmqsuwpjx])$/i
// A bounded probe avoids flattening an enormous logical line to inspect a clicked glyph.
export function clickedWord(text, at, chars = wordChar) {
  if (at < 0 || at >= text.length) return ''
  let a = startOfPoint(text, at), b = a
  const point = i => String.fromCodePoint(text.codePointAt(i))
  if (!chars.test(point(a))) return ''
  while (b < text.length && chars.test(point(b))) { b += point(b).length; if (b - a > probe) return '' }
  while (a > 0) {
    const prev = startOfPoint(text, a - 1)
    if (!chars.test(point(prev))) break
    a = prev; if (b - a > probe) return ''
  }
  const word = text.slice(a, b)
  if (chars === pbWordChar) {
    if (text[b] === '.') {
      const suffix = /^[a-z]{3}(?![\p{ID_Continue}$#-])/iu.exec(text.slice(b + 1, b + 6))?.[0]
      if (suffix && objectSuffix.test(suffix)) return `${word}.${suffix}`
    }
    if (text[a - 1] === '.' && objectSuffix.test(word)) {
      const stem = /[\p{ID_Continue}$#-]+$/u.exec(text.slice(0, a - 1))?.[0]
      if (stem && stem.length <= probe) return `${stem}.${word}`
    }
  }
  return word
}
export function lineOfOffset(starts, pos) {
  let lo = 0, hi = starts.length
  while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (starts[mid] <= pos) lo = mid; else hi = mid }
  return lo
}
export function matchWord(word, pb) {
  if (!word) return null
  const literal = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{ID_Continue}$])${literal}(?![\\p{ID_Continue}$])`, pb ? 'giu' : 'gu')
}
const inside = (r, e) => r && e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom
const singleClick = e => e.button === 0 && e.detail === 1 && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
// Pointer positions are between characters. Check the glyph box so punctuation and
// blank space past the end of a line do not resolve to the preceding identifier.
export function viewWordHit(view, e, pbIdentifier = false, keyboard = false) {
  const doc = view.state.doc, pos = keyboard ? view.state.selection.main.head : view.posAtCoords({x:e.clientX, y:e.clientY})
  if (pos == null) return null
  for (const i of [pos, pos - 1]) {
    if (i < 0 || i >= doc.length || (!keyboard && !inside(view.coordsForChar(i), e))) continue
    const a = Math.max(0, i - probe - 2), b = Math.min(doc.length, i + probe + 3)
    const text = doc.sliceString(a, b), word = clickedWord(text, i - a, pbIdentifier ? pbWordChar : wordChar)
    if (word) return { word, pos:i, member:pbIdentifier && !word.includes('.') && /\.[ \t]*[\p{ID_Continue}$#-]*$/u.test(text.slice(0, i - a)) }
    if (!keyboard) break
  }
  return null
}
const pick = StateEffect.define(), mark = Decoration.mark({ class: 'world-vscode-word-hit' })
const cmWords = pb => ViewPlugin.fromClass(class {
  constructor() { this.word = ''; this.pattern = null; this.decorations = Decoration.none }
  update(u) {
    let word = u.docChanged || (u.focusChanged && !u.view.hasFocus) ? '' : this.word
    for (const tr of u.transactions) for (const fx of tr.effects) if (fx.is(pick)) word = fx.value
    if (word === this.word && !(word && u.viewportChanged)) return
    if (word !== this.word) { this.word = word; this.pattern = matchWord(word, pb) }
    if (!this.pattern) { this.decorations = Decoration.none; return }
    const doc = u.state.doc, spans = []
    for (const {from, to} of u.view.visibleRanges) {
      // Include neighbouring characters so clipped identifiers cannot become false whole words.
      const start = Math.max(0, from - word.length - 2), text = doc.sliceString(start, Math.min(doc.length, to + word.length + 2))
      this.pattern.lastIndex = Math.max(0, from - start - word.length + 1)
      let m
      while ((m = this.pattern.exec(text))) {
        const a = start + m.index, b = a + m[0].length
        if (a >= to) break
        if (b > from) spans.push(mark.range(Math.max(a, from), Math.min(b, to)))
      }
    }
    this.decorations = Decoration.set(spans)
  }
}, { decorations: p => p.decorations, eventHandlers: { mouseup(e, view) {
  if (!singleClick(e) || !view.state.selection.main.empty) return false
  const word = viewWordHit(view, e)?.word || ''
  if (word !== this.word) view.dispatch({effects: pick.of(word)})
  return false
} } })
const sensitive = cmWords(false), insensitive = cmWords(true)
export const clickWordHighlight = language => language === 'powerbuilder' ? insensitive : sensitive

// Native textarea clicks give a caret *between* characters. Test the two glyph boxes in
// its existing mirror to disambiguate e.g. the last half of a word vs the following space.
function mirrorWord(node, text, starts, e) {
  if (!singleClick(e) || node.selectionStart !== node.selectionEnd || !starts) return ''
  const pos = node.selectionStart
  const line = lineOfOffset(starts, pos)
  const row = node.parentElement.querySelector(`[data-word-row="${line}"]`)
  if (!row) return ''
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT), range = document.createRange()
  let base = starts[line], leaf
  while ((leaf = walker.nextNode()) && base <= pos) {
    const end = base + leaf.length
    for (const i of [pos, pos - 1]) if (i >= base && i < end && i < text.length) {
      const a = startOfPoint(leaf.data, i - base), b = a + (leaf.data.codePointAt(a) > 0xffff ? 2 : 1)
      range.setStart(leaf, a); range.setEnd(leaf, b)
      if (inside(range.getBoundingClientRect(), e)) return clickedWord(text, base + a)
    }
    base = end
  }
  return ''
}
export function useNativeWord(id, language) {
  const [picked, set] = React.useState(null)
  const word = picked?.id === id ? picked?.word : ''
  const pattern = React.useMemo(() => matchWord(word, language === 'powerbuilder'), [word, language])
  return { pattern, clear: () => set(null), click: (e, text, starts) => {
    const next = mirrorWord(e.currentTarget, text, starts, e)
    if (next !== word) set(next ? {id, word:next} : null)
  } }
}
// Only the virtual row window calls this. Match across syntax-token boundaries; leave
// token colours and the textarea itself untouched. No matches => original token text.
export function wordRow(tokens, text, pattern) {
  const h = React.createElement
  if (pattern) pattern.lastIndex = 0
  let m = pattern?.exec(text), at = 0
  const paint = value => {
    const end = at + value.length, start = at, parts = []
    while (m && m.index < end) {
      if (at < m.index) parts.push(value.slice(at - start, m.index - start))
      const a = Math.max(at, m.index), b = Math.min(end, m.index + m[0].length)
      parts.push(h('span', {key:a, className:'world-vscode-word-hit'}, value.slice(a - start, b - start)))
      at = b
      if (at === m.index + m[0].length) m = pattern.exec(text); else break
    }
    const rest = value.slice(at - start); at = end
    if (!parts.length) return value
    if (rest) parts.push(rest)
    return parts
  }
  if (!tokens) return text ? paint(text) : '\u200b'
  return tokens.length ? tokens.map((t, i) => t.type === 'punc' ? (m ? paint(t.text) : t.text)
    : h('span', {key:i, className:`world-vscode-tok-${t.type}`}, m ? paint(t.text) : t.text)) : '\u200b'
}
