import { EditorView } from '@codemirror/view'

const LIMIT = 4000
const nextLine = (text, start) => { const next = text.indexOf('\n', start); return next < 0 ? text.length : next + 1 }
function lineNumber(text, end) {
  let line = 1
  for (let pos = text.indexOf('\n'); pos >= 0 && pos < end; pos = text.indexOf('\n', pos + 1)) line++
  return line
}
function atTop(tops, offset, height) {
  if (!tops?.length) return Math.floor(offset / height)
  let low = 0, high = tops.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (tops[mid] <= offset) low = mid
    else high = mid - 1
  }
  return low
}

export function taskbarSource(node, path, dirty, tops) {
  if (!node?.clientHeight || !path) return null
  const view = node.matches('.cm-content') ? EditorView.findFromDOM(node) : null
  const area = node.matches('textarea.world-vscode-textarea') ? node : null
  if (!view && !area) return null
  const doc = view?.state.doc, value = area?.value
  const selection = view?.state.selection.main
  const start = selection?.from ?? area.selectionStart, end = selection?.to ?? area.selectionEnd
  const head = selection?.head ?? (area.selectionDirection === 'backward' ? start : end)
  const lineAt = pos => doc ? doc.lineAt(pos).number : lineNumber(value, pos)
  const slice = (from, to) => doc ? doc.sliceString(from, to) : value.slice(from, to)
  const line = lineAt(head), lineStart = doc ? doc.lineAt(head).from : (head ? value.lastIndexOf('\n', head - 1) + 1 : 0)
  let from = start, to = end
  const style = area && getComputedStyle(area), rowHeight = style && parseFloat(style.lineHeight)
  if (from === to && doc) {
    const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop
    from = view.lineBlockAtHeight(Math.max(0, top)).from
    to = view.lineBlockAtHeight(Math.max(0, top + view.scrollDOM.clientHeight - 1)).to
  } else if (from === to) {
    const first = atTop(tops, area.scrollTop, rowHeight), last = atTop(tops, area.scrollTop + area.clientHeight - 1, rowHeight)
    from = 0
    for (let index = 0; index < first && from < value.length; index++) from = nextLine(value, from)
    to = from
    for (let index = first; index <= last && to < value.length && to - from < LIMIT; index++) to = nextLine(value, to)
  }
  const text = slice(from, Math.min(to, from + LIMIT)), label = node.closest('[data-srw-view]') ? node.getAttribute('aria-label') : ''
  const context = { path, label, dirty, line, column: head - lineStart + 1, from: lineAt(from),
    to: lineAt(from + Math.max(0, text.length - 1)), kind: start === end ? '可见代码' : '选区', text, truncated: to - from > LIMIT }
  return { context, focus: () => { if (node.isConnected && node.clientHeight) node.focus({ preventScroll: true }) }, mark() {
    const parent = view?.dom || area.parentElement
    const layer = document.createElement('div'), cursor = document.createElement('span')
    layer.className = 'world-taskbar-source-marker'; layer.setAttribute('aria-hidden', 'true'); layer.inert = true
    cursor.className = 'world-taskbar-source-caret'
    const render = () => {
      if (!node.isConnected) return
      if (view) {
        const rect = view.coordsAtPos(head), bounds = parent.getBoundingClientRect()
        layer.hidden = !rect || view.state.doc !== doc
        if (rect) Object.assign(cursor.style, { position: 'absolute', left: `${rect.left - bounds.left}px`, top: `${rect.top - bounds.top}px`, height: `${rect.bottom - rect.top}px` })
      } else {
        const bounds = area.getBoundingClientRect(), origin = parent.getBoundingClientRect()
        Object.assign(layer.style, { left: `${bounds.left - origin.left}px`, top: `${bounds.top - origin.top}px`, width: `${area.clientWidth}px`, height: `${area.clientHeight}px` })
        const mirror = cursor.parentElement
        Object.assign(mirror.style, { width: `${area.clientWidth - parseFloat(style.paddingRight)}px`, transform: `translate(${-area.scrollLeft}px, ${(tops?.[line - 1] ?? (line - 1) * rowHeight) - area.scrollTop}px)` })
      }
    }
    if (view) layer.append(cursor)
    else {
      const mirror = document.createElement('div')
      Object.assign(mirror.style, { font: style.font, lineHeight: style.lineHeight, whiteSpace: style.whiteSpace, overflowWrap: style.overflowWrap, wordBreak: style.wordBreak, tabSize: style.tabSize, color: 'transparent' })
      cursor.style.color = style.caretColor
      mirror.append(value.slice(lineStart, head), cursor, value.slice(head, nextLine(value, head)) || '\u200b'); layer.append(mirror)
    }
    parent.append(layer); render()
    const scroller = view?.scrollDOM || area, observer = new ResizeObserver(render)
    observer.observe(scroller); scroller.addEventListener('scroll', render, { passive: true })
    return () => { observer.disconnect(); scroller.removeEventListener('scroll', render); layer.remove() }
  } }
}
