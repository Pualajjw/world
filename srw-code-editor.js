import React from 'react'
import { Annotation, Compartment, Facet, EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { closeSearchPanel, findNext, findPrevious, openSearchPanel } from '@codemirror/search'
import { history, historyKeymap, indentWithTab, standardKeymap, undo, redo, undoDepth, redoDepth, selectAll } from '@codemirror/commands'
import { createScriptSource, scriptCompletion } from './srw-completion.js'
import { clickWordHighlight, viewWordHit } from './vscode-word-highlight.js'
import { folding, captureFolds, applyFolds, exposeGutterActions } from './vscode-folding.js'
import { viewportHighlight } from './vscode-viewport-highlight.js'
import { openBody, editsDirty, setBody } from './srw-edits.js'

// 行号槽跟普通源码视图一样是透明底 + 弱化行号色。原来借用 --world-surface，宿主没给
// 浅色别名时它兜底成 #202020，浅色主题里就在左边留一条黑带。
const numberedGutter = [lineNumbers(), EditorView.theme({
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--vscode-gutter-ink, #6e7681)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 4px' },
})]
const positions = new WeakMap() // session → member key → selection and logical scroll anchor, never an EditorView
const wrapping = new Compartment() // configuration is local to each EditorState
// Split panes can show the same SRA section at once. Apply each edit to its source once;
// mirror the ChangeSet into peers without echoing it back or adding a second undo step.
const mirrored = Annotation.define(), sraViews = new WeakMap()
const keys = keymap.of([...standardKeymap, ...historyKeymap, indentWithTab])
const scriptFolding = folding('powerbuilder')
const scriptSearch = [EditorState.phrases.of({ Find: '查找', Replace: '替换', next: '下一处', previous: '上一处', all: '全选',
  'match case': '区分大小写', regexp: '正则', 'by word': '全词', replace: '替换', 'replace all': '全部替换', close: '关闭' }),
  keymap.of([{ key: 'Escape', run: closeSearchPanel, scope: 'editor search-panel' },
    { key: 'F3', run: findNext, shift: findPrevious, scope: 'editor search-panel' }])]

export function findInScript(pane) {
  const dom = pane?.querySelector('[data-srw-view="script"] .cm-editor')
  const view = dom && EditorView.findFromDOM(dom)
  return !!view && openSearchPanel(view)
}
/** Editable Script normally gets the host's native editing menu. When we need a
 * custom menu, keep its editing commands above the project-object links. */
export function scriptContext(event) {
  const dom = event.target.closest('[data-srw-view="script"] .cm-content')
  const view = dom && EditorView.findFromDOM(dom)
  if (!view) return null
  const hit = viewWordHit(view, event, true, event.button !== 2 && !event.ctrlKey)
  if (!hit) return null
  const {word, pos} = hit, state = view.state
  const resolve = hit.member && state.facet(memberResolver)
  const selected = !view.state.selection.main.empty
  const clipboard = cmd => { if (!document.execCommand(cmd)) throw Error('无法访问剪贴板，请使用键盘快捷键。') }
  const paste = async () => {
    const { doc, selection } = view.state
    let text = await navigator.clipboard.readText()
    if (!view.dom.isConnected || view.state.doc !== doc || !view.state.selection.eq(selection)) return
    for (const filter of view.state.facet(EditorView.clipboardInputFilter)) text = filter(text, view.state)
    if (text) view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true })
  }
  const actions = view.state.readOnly ? null : [
    ['撤销', undoDepth(view.state), undo], ['重做', redoDepth(view.state), redo],
    ['剪切', selected, () => clipboard('cut')], ['复制', selected, () => clipboard('copy')],
    ['粘贴', true, paste], ['全选', true, selectAll],
  ]
  return { word, actions, resolve: resolve && (signal => resolve({state, pos, view, get aborted() { return signal.aborted }}, word)), run(fn) { view.focus(); return fn(view) } }
}
const memberResolver = Facet.define({ combine: values => values[0] })
const singleLine = [EditorView.clipboardInputFilter.of(text => text.replace(/[\r\n]+/g, ' ')),
  EditorState.changeFilter.of(tr => !tr.docChanged || tr.newDoc.lines === 1)]

/** The same editable DOM paints the tokens, selection, IME composition and caret. */
export function SrwCodeEditor({ session, bounds, label, inline, active, onDirty, script, jump, wrap = false, readOnly = false }) {
  const host = React.useRef(null), editor = React.useRef(null), latest = React.useRef(null)
  latest.current = { bounds, onDirty, wrap }
  const release = React.useCallback(() => { const view = editor.current; editor.current = null; view?.destroy() }, [])
  React.useLayoutEffect(() => {
    const { doc, original } = readOnly && !bounds.parts ? { doc: session.text.slice(bounds.start, bounds.end) } : openBody(session, bounds)
    let peers
    if (!readOnly && session.model?.isApplication && ['declare:global', 'declare:globalExternal'].includes(bounds.key)) {
      let sections = sraViews.get(session)
      if (!sections) sraViews.set(session, sections = new Map())
      peers = sections.get(bounds.key)
      if (!peers) sections.set(bounds.key, peers = new Set())
    }
    let marks = positions.get(session)
    if (!marks) positions.set(session, marks = new Map())
    const saved = marks.get(bounds.key)
    const selection = saved && { anchor: Math.min(saved.anchor, doc.length), head: Math.min(saved.head, doc.length) }
    let symbols // Read-only Script views need no declaration state until the first member lookup.
    const getSymbols = () => symbols ||= createScriptSource(session, script)
    const view = new EditorView({ parent: host.current, scrollTo: saved?.scroll, state: EditorState.create({
      doc, selection,
      extensions: [numberedGutter, script ? [scriptSearch, scriptFolding] : [], wrapping.of(latest.current.wrap ? EditorView.lineWrapping : []),
        viewportHighlight('powerbuilder'), clickWordHighlight('powerbuilder'), EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
        script ? memberResolver.of((ctx, member) => getSymbols().resolveMember(ctx, member)) : [],
        readOnly ? [] : [history(), keys, script ? scriptCompletion(getSymbols(), host.current.closest('.world-srw-panes')) : []],
        inline ? singleLine : [], EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': String(!inline), 'aria-readonly': String(readOnly), ...(readOnly ? { tabindex: script ? '0' : '-1' } : {}), spellcheck: 'false' }),
        EditorView.updateListener.of(update => {
          if (!update.docChanged || readOnly || update.transactions.some(tr => tr.annotation(mirrored))) return
          const wasDirty = editsDirty(session.edits)
          setBody(session, latest.current.bounds, update.state.doc, original, update.changes)
          if (peers) for (const peer of peers) if (peer !== update.view) peer.dispatch({ changes: update.changes,
            annotations: [mirrored.of(true), Transaction.addToHistory.of(false)] })
          if (editsDirty(session.edits) !== wasDirty) latest.current.onDirty()
        }),
      ],
    }) })
    if (script) exposeGutterActions(view)
    applyFolds(view, saved?.folds)
    editor.current = view
    peers?.add(view)
    let scroll = saved?.scroll
    const rememberScroll = () => { if (view.scrollDOM.clientHeight) scroll = view.scrollSnapshot() }
    view.scrollDOM.addEventListener('scroll', rememberScroll, { passive: true })
    return () => {
      rememberScroll()
      const { anchor, head } = view.state.selection.main
      marks.set(bounds.key, { anchor, head, scroll, folds: captureFolds(view.state) })
      view.scrollDOM.removeEventListener('scroll', rememberScroll)
      peers?.delete(view); release()
    }
  }, [session, bounds.key, bounds.start, bounds.end, inline, label, script, readOnly, release])
  React.useLayoutEffect(() => {
    const view = editor.current
    if (view && (wrapping.get(view.state) === EditorView.lineWrapping) !== wrap) {
      view.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) })
    }
  }, [wrap])
  React.useLayoutEffect(() => { if (active) editor.current?.focus() }, [active, session, bounds.key])
  React.useLayoutEffect(() => {
    const view = editor.current
    if (!jump || jump !== session.state.jumpCaret || jump.key !== bounds.key || !view) return
    session.state.jumpCaret = null // Do not replay this jump on tab switch or steal a restored selection.
    const pos = view.state.doc.line(Math.min(jump.line, view.state.doc.lines)).from
    view.dispatch({selection:{anchor:pos}, effects:EditorView.scrollIntoView(pos,{y:'center'})})
    view.focus()
  }, [session, bounds.key, jump])
  return React.createElement('div', { ref: host, className: 'world-srw-code-input', 'data-inline': String(Boolean(inline)) })
}
