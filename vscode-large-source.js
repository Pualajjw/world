import React from 'react'
import { compactHistory, configureHistory, historyFor } from './vscode-source-history.js'
import { scheduleTestIndex } from './vscode-test-index.js'
import { clickWordHighlight } from './vscode-word-highlight.js'
import { viewportHighlight } from './vscode-viewport-highlight.js'
import { folding, applyFolds, captureFolds, exposeGutterActions } from './vscode-folding.js'
import { languageOf } from './highlight.js'
import { Compartment, EditorState, RangeSet, Text } from '@codemirror/state'
import { EditorView, GutterMarker, keymap, gutter, lineNumbers } from '@codemirror/view'
import { history, historyKeymap, indentWithTab, standardKeymap } from '@codemirror/commands'

// A tab object may outlive its removal (DOM events, observers and render snapshots).
// Keep immutable metadata in that object, never the multi-megabyte body itself.
const bodies = new WeakMap()
export function largeDocument({ source, ...metadata }) {
  const doc = { ...metadata, large: true }
  bodies.set(doc, source)
  return doc
}
export const tabText = tab => tab?.document?.large ? bodies.get(tab.document) ?? '' : tab?.draft ?? ''
/** 保存或重新查找之后，用新文本替换快照：下次数行、全文查找都从这份开始。 */
export const setLargeText = (doc, source) => { if (doc?.large && typeof source === 'string') bodies.set(doc, source) }

// React can retain a completed cleanup on an alternate fiber. Create the callback
// outside the mounting closure so it cannot retain the EditorView or its strings.
const cleanupFor = (ref, token, release) => () => { if (ref.current?.token === token) release() }

// The view virtualizes layout, not the document: selection, clipboard and navigation
// operate on full UTF-16 offsets, even when neither end of a range is mounted.
class TestMarker extends GutterMarker {
  constructor(target, disabled, callbacks) { super(); Object.assign(this, {target, disabled, callbacks}) }
  toDOM() {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'world-vscode-gutter-test'; b.textContent = '▶'
    b.title = this.target.label; b.setAttribute('aria-label', b.title); b.disabled = this.disabled || !!this.target.ambiguous
    b.onclick = () => this.callbacks.current.runTest(this.target)
    return b
  }
}
export function LargeSource({ tab, visible, wrap, phone, handles, locked, onActivate, onCaret, onEdit, testRows, runTest, testsDisabled, publishTests }) {
  const host = React.useRef(null), instance = React.useRef(null)
  const callbacks = React.useRef(null)
  callbacks.current = { onActivate, onCaret, onEdit, runTest, publishTests }
  const bookmark = React.useRef(null)
  // React can keep an already-called effect destructor on its alternate fiber.
  // Give it a stable disposer that only owns this ref, never the retired view.
  const releaseView = React.useCallback(() => {
    const current = instance.current
    instance.current = null
    current?.dispose()
  }, [])
  const doc = tab.document, id = tab.id, label = tab.path.split(/[\\/]/u).pop()
  // 只读的两种来源：服务端判只读（编码等），或者大到「保存时一次 toString 就卡一下」的文件。
  const editable = !locked
  const revision = tab.reload || 0
  const initialWrap = React.useRef(wrap)
  initialWrap.current = wrap
  // The tab owns the text until close/reload, even while its view is suspended.
  // Re-register on setup so React effect replay does not consume a live document.
  React.useLayoutEffect(() => {
    if (!doc.large) return
    bodies.set(doc, tabText(tab))
    return () => { bodies.delete(doc) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc])
  React.useLayoutEffect(() => {
    if (!visible) return
    // 正常时序下上一轮的 cleanup 已经销毁了旧视图；这里兜住 React 复用析构函数、
    // 或 setup 先于 cleanup 跑的情形：先安全销毁残留，再按它留下的书签恢复。
    releaseView()
    const identity = tab.foldEditor || doc
    const saved = bookmark.current?.identity === identity ? bookmark.current : null
    let flatText = tabText(tab)
    // Passing a string to EditorState invokes its default regexp splitter. In Chromium
    // the legacy last-match slot can then outlive the window and retain the whole file.
    if (flatText.includes('\r')) flatText = flatText.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
    const prior = !doc.large && editable && historyFor(tab)
    const initialDoc = prior?.doc || Text.of(flatText.split('\n'))
    let changed = false, cancelIndex
    const leafCache = new WeakMap()
    const largeMarkdown = doc.large && /\.(?:md|markdown)$/i.test(label)
    const index = (text, delay) => {
      cancelIndex?.()
      cancelIndex = scheduleTestIndex(text, leafCache, blocks => callbacks.current.publishTests(doc, blocks), delay)
    }
    const wrapping = new Compartment(), runs = new Compartment()
    const extensions = [
      viewportHighlight(languageOf(label)), clickWordHighlight(languageOf(label)), EditorState.readOnly.of(!editable),
      keymap.of(editable ? [...standardKeymap, indentWithTab, ...historyKeymap] : standardKeymap),
      runs.of([]), lineNumbers(), folding(languageOf(label)),
      // 只读时没必要攒 undo 栈；可编辑时它按操作记录，和文档大小无关。
      editable ? history() : [],
      wrapping.of(initialWrap.current ? EditorView.lineWrapping : []),
      EditorView.contentAttributes.of({ 'aria-label': `${editable ? '编辑' : '查看'} ${label}`, spellcheck: 'false',
        ...(editable ? {} : { inputmode: 'none' }) }),
      EditorView.domEventHandlers({ focus: (_event, editor) => { callbacks.current.onActivate(); report(editor) } }),
      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          flatText = null; changed = true
          if (doc.large) callbacks.current.onEdit()
          else callbacks.current.onEdit(flatText = update.state.doc.toString(), compactHistory(update.state))
          if (largeMarkdown) {
            callbacks.current.publishTests(doc, null)
            index(update.state.doc, 250)
          }
        }
        if (update.selectionSet || update.docChanged) report(update.view)
      }),
    ]
    const state = prior ? configureHistory(prior, extensions, saved?.selection) : EditorState.create({doc: initialDoc, selection: saved?.selection, extensions})
    const view = new EditorView({parent: host.current, scrollTo: saved?.scroll, state})
    if (['markdown', 'powerbuilder'].includes(languageOf(label))) exposeGutterActions(view)
    if (largeMarkdown) index(initialDoc, 0)
    const initial = tab.foldEditor
    if (!saved && initial) {
      const range = initial.line ? { from: initialDoc.line(initial.line).to, to: initialDoc.line(initial.endLine).to } : initial
      applyFolds(view, [range]); view.dispatch({ selection: { anchor: range.from }, scrollIntoView: true }); view.focus()
    } else applyFolds(view, saved?.folds)
    function report(editor) {
      const head = editor.state.selection.main.head, line = editor.state.doc.lineAt(head)
      callbacks.current.onCaret(line.number - 1, head - line.from)
    }
    // The mounted view owns one LF-normalized snapshot. Selection/scroll changes keep it;
    // edits (including undo and equal-length replacements) invalidate it before the next read.
    const snapshot = () => flatText ??= view.state.doc.toString()
    const api = {
      get value() { return snapshot() }, focus: () => view.focus(), reportCaret: () => report(view),
      text: snapshot, fold: range => applyFolds(view, [range]),
      multiline: (from, to) => view.state.doc.lineAt(from).to < to,
      /** Text 对象的身份：保存返回时用它判断「这期间用户还动过没有」，O(1)。 */
      doc: () => view.state.doc,
      get selectionStart() { return view.state.selection.main.from },
      get selectionEnd() { return view.state.selection.main.to },
      /** 对话上下文：只取选区文本与行号，不把整篇 toString。 */
      context() {
        const { from, to, head } = view.state.selection.main
        const raw = view.state.doc.sliceString(from, to)
        const first = view.state.doc.lineAt(from), last = view.state.doc.lineAt(from + raw.replace(/\n+$/, '').length)
        return { lines: view.state.doc.lines, line: view.state.doc.lineAt(head).number,
          selection: to > from ? { text: raw, from: first.number, to: last.number } : null }
      },
      select(from, to) {
        view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(to, { y: 'nearest' }) })
      },
      /** 查找替换：一次事务改完（全部替换有上千处，一次 dispatch 才不会卡）。 */
      replace(changes, caret) {
        const spec = { changes }
        if (Number.isFinite(caret)) spec.selection = { anchor: caret }
        view.dispatch(spec)
      },
      reveal(line, column) {
        const row = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, line || 1)))
        const pos = row.from + Math.max(0, Math.min(row.length, column || 0))
        view.focus(); this.select(pos, pos)
      },
    }
    handles.current.set(id, api)
    // Moving the portal to a hidden slot can zero scrollTop before cleanup. Keep a
    // logical scroll anchor while visible, not the view, state or document tree.
    let scroll = saved?.scroll
    const remember = () => { if (view.scrollDOM.clientHeight) scroll = view.scrollSnapshot() }
    view.scrollDOM.addEventListener('scroll', remember, { passive: true })
    const dispose = () => {
      cancelIndex?.(); remember()
      const { anchor, head } = view.state.selection.main
      bookmark.current = { identity, scroll, selection: { anchor, head }, folds: captureFolds(view.state) }
      // 可编辑时，没保存的修改只活在 CodeMirror 里：切到别的标签会把视图销毁，
      // 把当前正文留给标签，切回来还能接着改。
      if (changed && bodies.has(doc)) setLargeText(doc, snapshot())
      flatText = null
      view.scrollDOM.removeEventListener('scroll', remember)
      // 同一标签可能已经换了一把新视图：只删自己注册的那条
      if (handles.current.get(id) === api) handles.current.delete(id)
      view.destroy()
    }
    const token = Symbol()
    instance.current = { token, view, wrapping, runs, wrap: initialWrap.current, dispose }
    // 旧一轮的析构函数可能晚到：只销毁自己创建的那个视图，别动已经接班的新视图
    return cleanupFor(instance, token, releaseView)
    // 刻意不依赖 tabText(tab)：保存/查找只刷新快照，不该重建视图（那会丢光标和滚动位置）。
    // 只有换文件（doc）或重新读盘（revision）才需要重来。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.foldEditor || doc, revision, visible, id, label, editable, handles, releaseView])
  React.useLayoutEffect(() => {
    const current = instance.current
    if (!current || !/\.(?:md|markdown)$/i.test(label)) return
    const {view, runs} = current, markers = []
    // On a phone the ▶ column would eat a third more of the gutter; the test panel is the touch path.
    for (const [n, target] of phone ? [] : testRows || []) if (n <= view.state.doc.lines) {
      markers.push(new TestMarker(target, testsDisabled, callbacks).range(view.state.doc.line(n).from))
    }
    const set = RangeSet.of(markers, true)
    view.dispatch({effects: runs.reconfigure(markers.length ? gutter({class: 'world-vscode-run-gutter', markers: () => set}) : [])})
    exposeGutterActions(view)
  }, [visible, testRows, testsDisabled, label, revision, tab.foldEditor || doc, phone])
  React.useLayoutEffect(() => {
    // A save provider may return normalized source. Keep a promoted small editor in sync
    // without recreating its view (and losing folds) after ordinary saves.
    const current = instance.current, handle = handles.current.get(id)
    if (current && visible && !doc.large && handle && handle.text() !== tab.draft) {
      current.view.dispatch({changes: {from: 0, to: current.view.state.doc.length, insert: tab.draft}})
    }
  }, [tab.draft, doc, visible, id, handles])
  React.useLayoutEffect(() => {
    const current = instance.current
    if (current && current.wrap !== wrap) {
      current.wrap = wrap
      current.view.dispatch({ effects: current.wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) })
    }
  }, [wrap])
  return React.createElement('div', { ref: host, className: `world-vscode-editor-content world-vscode-large${phone ? ' is-phone' : ''}` })
}
