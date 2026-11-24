import { StateEffect } from '@codemirror/state'
import { Decoration, ViewPlugin } from '@codemirror/view'
import { syntaxLine, powerScriptPass } from './highlight.js'

const STEP = 128, repaint = StateEffect.define(), marks = new Map()
const mark = type => {
  if (!marks.has(type)) marks.set(type, Decoration.mark({ class: `world-vscode-tok-${type}` }))
  return marks.get(type)
}
// These are ordered, non-overlapping marks; compare their exact spans before allocating a new set.
function sameMarks(current, ranges) {
  if (current.size !== ranges.length) return false
  const cursor = current.iter()
  for (const r of ranges) {
    if (cursor.from !== r.from || cursor.to !== r.to || cursor.value !== r.value) return false
    cursor.next()
  }
  return true
}
const modes = new Map()
/** Keep marks only for visible text. A far scroll resumes lexical state from sparse
 * checkpoints in time slices; neither document length nor long lines disable colour. */
export function viewportHighlight(language) {
  if (!language) return []
  if (modes.has(language)) return modes.get(language)
  const extension = ViewPlugin.fromClass(class {
    constructor(view) {
      this.checkpoints = [{}]; this.decorations = Decoration.none
      this.view = view; this.schedule()
    }
    update(update) {
      for (const tx of update.transactions) for (const effect of tx.effects) {
        if (effect.is(repaint)) this.decorations = effect.value
      }
      if (update.docChanged) {
        let first = update.startState.doc.length
        update.changes.iterChangedRanges(from => { first = Math.min(first, from) })
        this.checkpoints.length = Math.min(this.checkpoints.length, 1 + Math.floor((update.startState.doc.lineAt(first).number - 1) / STEP))
        this.decorations = this.decorations.map(update.changes)
      }
      if (update.docChanged || update.viewportChanged) this.schedule()
    }
    schedule() {
      clearTimeout(this.timer)
      const view = this.view, doc = view.state.doc, ranges = view.visibleRanges
      if (!ranges.length) return
      const first = doc.lineAt(ranges[0].from).number, last = doc.lineAt(ranges.at(-1).to).number
      const slot = Math.min(this.checkpoints.length - 1, Math.floor((first - 1) / STEP))
      const state = { ...this.checkpoints[slot] }, result = []
      // Keep one viewport plus its checkpoint prefix, not every line crossed on a far scroll.
      const pass = language === 'powerbuilder' ? powerScriptPass(this.pbRows) : null
      const cacheFrom = first - STEP
      let n = slot * STEP + 1, idx = 0
      const paint = () => {
        const until = performance.now() + 6
        for (; n <= last; n++) {
          if ((n - 1) % STEP === 0) this.checkpoints[(n - 1) / STEP] = { ...state }
          const line = doc.line(n), tokens = pass && n >= cacheFrom ? pass.scan(line.text, state) : syntaxLine(line.text, language, state)
          while (idx < ranges.length && ranges[idx].to < line.from) idx++
          if (idx < ranges.length && ranges[idx].from <= line.to) {
            let pos = line.from, r = idx
            for (const token of tokens) {
              const end = pos + token.text.length
              while (r < ranges.length && ranges[r].to <= pos) r++
              if (r === ranges.length || ranges[r].from >= line.to) break
              if (token.type !== 'punc') for (let j = r; j < ranges.length && ranges[j].from < end; j++) {
                const a = Math.max(pos, ranges[j].from), b = Math.min(end, ranges[j].to)
                if (a < b) result.push(mark(token.type).range(a, b))
              }
              pos = end
            }
          }
          if (n % 32 === 0 && n < last && performance.now() >= until) { n++; this.timer = setTimeout(paint, 0); return }
        }
        if (pass) this.pbRows = pass.rows
        // A deletion inside a PB token often leaves its mapped marks exactly right.
        // Do not send a second editor transaction for a paint that changes nothing.
        if (!pass || !sameMarks(this.decorations, result)) view.dispatch({ effects: repaint.of(Decoration.set(result)) })
      }
      this.timer = setTimeout(paint, 0)
    }
    destroy() { clearTimeout(this.timer); this.checkpoints.length = 0; this.pbRows = null; this.view = null }
  }, { decorations: plugin => plugin.decorations })
  modes.set(language, extension); return extension
}
