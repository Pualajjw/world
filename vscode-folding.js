import { StateEffect, StateField, EditorState } from '@codemirror/state'
import { ViewPlugin } from '@codemirror/view'
import { codeFolding, foldedRanges, foldEffect, foldGutter, foldService } from '@codemirror/language'
import { markdownRegion, powerScriptLineTokens } from './highlight.js'

const structured = lang => lang === 'markdown' || lang === 'powerbuilder'
/** A prose line whose first significant character cannot open a heading, list, quote,
 *  indented block or setext underline needs no regex at all. */
function plainProse(text) {
  let i = 0
  while (i < 3 && text.charCodeAt(i) === 32) i++
  const code = text.charCodeAt(i)
  if (code === 32 || code === 9) return false
  return !(code === 35 || code === 61 || code === 45 || code === 42 || code === 43 || code === 62 ||
    code === 95 || (code >= 48 && code <= 57))
}
// Unlike PB blocks, Markdown sections span fences. Close only peers and descendants;
// leave blank separator lines visible and do not offer folds for empty sections.
function markdownSections(rows) {
  const headings = []
  let lastContent = 0, paragraphBefore = null
  function close(level, end) {
    while (headings.length && headings.at(-1).level >= level) {
      const h = headings.pop()
      if (end > h.labelEnd) rows.set(h.anchor, end)
    }
  }
  return {
    line(raw, n, region) {
      const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      const before = lastContent
      if (/\S/.test(text)) lastContent = n
      if (region !== 'prose' || lastContent !== n) { paragraphBefore = null; return }
      if (plainProse(text)) { paragraphBefore ??= before; return }
      const atx = /^ {0,3}(#{1,6})(?=[ \t]|$)/.exec(text)
      const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(text)
      if (atx || (underline && paragraphBefore !== null)) {
        const level = atx ? atx[1].length : underline[1][0] === '=' ? 1 : 2
        close(level, atx ? before : paragraphBefore)
        headings.push({level, anchor: atx ? n : n - 1, labelEnd: n})
        paragraphBefore = null
      } else if (underline || /^(?: {4}| {0,3}(?:\t|>|(?:[-*+]|\d+[.)])(?:[ \t]|$)))/.test(text)
          || /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(text)) {
        paragraphBefore = null // An indented block, list or thematic break isn't a Setext title.
      } else paragraphBefore ??= before
    },
    finish() { close(1, lastContent) },
  }
}

// Line numbers (not displayed text) are shared by the native gutter and CodeMirror.
// A fence is a hard boundary. Neither quoted PB nor embedded native code opens PB blocks.
// Only candidate lines enter the bounded cache. Short ordinary statements need no
// tokens; structural rows can reuse their classification across adjacent revisions.
const candidate = /^\s*(?:@|(?:end|next|loop|forward|type|if|choose|global|shared|public|private|protected|local|function|subroutine|event|on|try|do|for)\b)/i
const emptyLine = { descs: [], blockComment: false }
export function foldScanner(lang, cache = {}) {
  const rows = new Map(), stack = [], lex = {}, fence = {}
  const source = cache.lang === lang ? cache.token : null
  const tokens = [new Map(), new Map()]
  let cachedChars = 0, cachedLines = 0
  cache.lang = lang; cache.token = tokens
  const sections = lang === 'markdown' ? markdownSections(rows) : null
  let native = '', prototypes = false, comment = false
  const close = (kind, n) => {
    const at = stack.findLastIndex(s => s.kind === kind)
    if (at >= 0) {
      if (stack[at].n < n) rows.set(stack[at].n, n)
      stack.length = at
    }
  }
  /** Masked code plus the block structure it opens/closes. Both depend only on the line
   *  text and its incoming block-comment state, so a keystroke reclassifies one line. */
  const masked = raw => {
    const mode = lex.blockComment ? 1 : 0, map = tokens[mode]
    let entry = map.get(raw) || source?.[mode].get(raw)
    if (!entry) {
      const code = powerScriptLineTokens(raw, lex).map(t => t.type === 'cmt' ? ' ' : t.type === 'str' ? '""' : t.text).join('')
      const descs = []
      for (const part of code.trim().toLowerCase().split(';')) { const d = describe(part.trim()); if (d) descs.push(d) }
      entry = descs.length || lex.blockComment ? { blockComment: Boolean(lex.blockComment), descs } : emptyLine
    } else lex.blockComment = entry.blockComment
    // Cache only a bounded working set, independent of the maximum file size.
    if (cachedLines < 2048 && cachedChars + raw.length <= 131072 && !map.has(raw)) {
      map.set(raw, entry); cachedChars += raw.length; cachedLines++
    }
    return entry.descs
  }
  const statement = (d, n) => {
    if (prototypes) { if (d.endPrototypes) { close('prototypes', n); prototypes = false } return }
    if (d.close) { close(d.close, n); return }
    if (d.open) {
      if (d.open === 'prototypes') prototypes = true
      if (d.native) native = d.native
      stack.push({ kind: d.open, n })
    }
  }
  return { cache, finish() { sections?.finish(); return rows }, line(raw, n) {
    if (sections) {
      const open = raw.indexOf('<!--')
      const inComment = !fence.fence && (comment || (open >= 0 && open <= 3 && !raw.slice(0, open).trim()))
      comment = inComment && !raw.includes('-->')
      const region = inComment ? 'comment' : markdownRegion(raw, fence)
      sections.line(raw, n, region)
      if (region !== 'pb' || fence.fenceLang !== 'pbtest') { stack.length = 0; lex.blockComment = false; lex.quote = ''; native = ''; prototypes = false; return }
    }
    if (native) {
      if (raw.trim().toLowerCase() === `@end ${native}`) { close(native, n); native = '' }
      return
    }
    if (!lex.blockComment && !lex.quote && raw.trimStart().startsWith('//')) return
    // Ordinary statements cannot affect subsequent lines unless they contain a comment
    // opener or another statement. Do not tokenize or retain unique assignments.
    if (!lex.blockComment && !raw.includes('/*') && !raw.includes(';') && !candidate.test(raw)) return
    for (const d of masked(raw)) statement(d, n)
  } }
}
/** Classify one `;`-separated statement. Pure and cached by the scanner: neither the
 *  open kind nor the close kind depends on surrounding lines. */
function describe(code) {
  if (!code) return null
  if (/^end\s+prototypes\b/.test(code)) return { endPrototypes: true }
  const end = /^(?:@(?:[\w.]+\.)?)?end\s+(if|choose|try|function|subroutine|event|on|type|variables)\b/.exec(code)
  if (end) return { close: end[1] }
  if (/^next\b/.test(code)) return { close: 'for' }
  if (/^loop\b/.test(code)) return { close: 'do' }
  if (/^(?:forward|type)\s+prototypes\b/.test(code)) return { open: 'prototypes' }
  const mark = /^@(c|cpb|cs|cspb|rust|rustpb|go|gopb|pypb)(?:\s|$)/.exec(code)
  if (mark) return { open: mark[1], native: mark[1] }
  if (/^if\b.*\bthen\s*;?$/.test(code)) return { open: 'if' }
  if (/^choose\s+case\b/.test(code)) return { open: 'choose' }
  if (/^(?:global|shared|type)\s+variables\b/.test(code)) return { open: 'variables' }
  if (/^(?:global\s+)?type\s+\w+\s+from\b/.test(code)) return { open: 'type' }
  if (/\blibrary\s+"/.test(code)) return null
  const routine = /^(?:@[\w.]+\.)?(?:(?:public|private|protected|global|local)\s+)?(function|subroutine|event|on|try|do|for)\b/.exec(code)
  return routine ? { open: routine[1] } : null
}
const FOLDS = Symbol('foldCache')
export function nativeFoldRows(text, lang, previous) {
  if (!structured(lang)) return null
  const scan = foldScanner(lang, previous?.[FOLDS])
  text.split('\n').forEach((s, i) => scan.line(s, i + 1))
  const folds = scan.finish()
  // Hand the token cache to the next call without changing the Map's public shape.
  Object.defineProperty(folds, FOLDS, { value: scan.cache })
  return folds
}

const indexed = StateEffect.define()
/** The scan result lives in the state, so a keystroke that keeps the document height
 *  can borrow the previous row index until the new pass lands. A transaction is the
 *  only ordering the fold gutter and the indexer are guaranteed to share. */
const foldIndex = StateField.define({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(indexed)) return effect.value ? { map: effect.value, lines: tr.state.doc.lines } : value
    if (tr.docChanged && (!value || tr.state.doc.lines !== tr.startState.doc.lines)) return null
    return value
  },
})
export function folding(lang) {
  const labels = EditorState.phrases.of({ 'Fold line': '折叠代码块', 'Unfold line': '展开代码块', 'folded code': '已折叠文本', unfold: '展开' })
  if (!structured(lang)) return [labels, codeFolding()]
  // Index immutable Text in slices. Never synchronously scan a million lines on a keystroke.
  const indexer = ViewPlugin.fromClass(class {
    constructor(view) { this.cache = {}; this.start(view) }
    update(u) { if (u.docChanged) this.start(u.view) }
    start(view) {
      clearTimeout(this.timer)
      const doc = view.state.doc, scan = foldScanner(lang, this.cache), lines = doc.iterLines(); let n = 0
      const step = () => {
        const until = performance.now() + 5
        for (;;) {
          lines.next()
          if (lines.done) {
            const map = scan.finish()
            view.dispatch({ effects: indexed.of(map) }); return
          }
          scan.line(lines.value, ++n)
          if (!(n % 32) && performance.now() >= until) { this.timer = setTimeout(step, 0); return }
        }
      }
      this.timer = setTimeout(step, 0)
    }
    destroy() { clearTimeout(this.timer) }
  })
  return [foldIndex, indexer, labels,
    foldService.of((state, from) => {
      const row = state.doc.lineAt(from), end = state.field(foldIndex, false)?.map.get(row.number)
      return end ? { from: row.to, to: state.doc.line(end).to } : null
    }), foldGutter({ markerDOM: open => {
      const mark = document.createElement('span')
      mark.className = 'world-vscode-fold-arrow'; mark.dataset.open = String(open)
      mark.title = open ? '折叠代码块' : '展开代码块'
      // 与轻量视图的 <button> 折叠箭头对齐：可聚焦、可读屏、可用键盘触发。
      mark.setAttribute('role', 'button')
      mark.tabIndex = 0
      mark.setAttribute('aria-label', open ? '折叠代码块' : '展开代码块')
      mark.setAttribute('aria-expanded', String(open))
      mark.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
        event.preventDefault()
        // 复用 gutter 的点击处理，避免在这里重复一份折叠/展开逻辑。
        const cell = mark.parentElement
        mark.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        cell?.querySelector('.world-vscode-fold-arrow')?.focus({preventScroll: true})
      })
      return mark
    }, domEventHandlers: {click: (_view, _line, event) => !event.target.closest('.world-vscode-fold-arrow')},
    foldingChanged: u => u.transactions.some(tr => tr.effects.some(e => e.is(indexed))) })]
}
// CodeMirror hides the entire stock gutter from assistive technology. Our custom
// buttons are interactive: hide the decorative number column, not their ancestor.
export function exposeGutterActions(view) {
  const group = view.scrollDOM.querySelector('.cm-gutters')
  if (!group) return
  group.querySelector('.cm-lineNumbers')?.setAttribute('aria-hidden', 'true')
  group.removeAttribute('aria-hidden')
}
export function captureFolds(state) {
  const result = []
  foldedRanges(state).between(0, state.doc.length, (from, to) => { result.push({from, to}) })
  return result
}
export function applyFolds(view, ranges) {
  if (!ranges?.length) return
  const effects = ranges.filter(r => r.from >= 0 && r.from < r.to && r.to <= view.state.doc.length).map(r => foldEffect.of(r))
  if (effects.length) view.dispatch({ effects })
}
