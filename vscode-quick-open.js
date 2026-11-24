import React from 'react'
import { errorMessage } from './vscode-error-details.js'

const h = React.createElement
const nameOf = path => path.split('/').at(-1)
const directoryOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

// Only the filename is searched. A drive-letter colon is part of a Windows path.
function splitQuickQuery(query) {
  const text = query.trim(), colon = text.indexOf(':', /^[A-Za-z]:[\\/]/u.test(text) ? 2 : 0)
  if (colon < 0) return { term: text }
  const term = text.slice(0, colon).trimEnd(), suffix = text.slice(colon + 1)
  if (term && !/^[\d:]*$/u.test(suffix)) return { term: text }
  const match = /^(\d+)(?::(\d+))?$/u.exec(suffix)
  const line = Number(match?.[1]), column = Number(match?.[2] ?? 1)
  return { term, position: Number.isSafeInteger(line) && line > 0 && Number.isSafeInteger(column) && column > 0
    ? { line, column: column - 1 } : null }
}

/** Reserve the local key while this editor owns input so Desktop delivers it to the DOM. */
export function reserveQuickOpen(shortcuts) {
  if (typeof shortcuts?.registerFixed !== 'function') return undefined
  return shortcuts.registerFixed({
    id: 'world.vscode.quick-open', label: () => 'VSCode 搜索文件',
    keys: [shortcuts.platform === 'macos' ? 'Cmd' : 'Ctrl', 'P'],
    bindings: [{ code: 'KeyP', modifiers: ['primary'] }], group: 'input',
  })
}

export function reserveTextFind(shortcuts, findOnly = false) {
  if (typeof shortcuts?.registerFixed !== 'function') return undefined
  return shortcuts.registerFixed({
    id: 'world.vscode.text-find', label: () => 'VSCode 当前文件查找替换', keys: findOnly ? ['Ctrl+F'] : ['Ctrl+F', 'Ctrl+H'],
    bindings: (findOnly ? ['KeyF'] : ['KeyF', 'KeyH']).map(code => ({ code, modifiers: ['primary'] })), group: 'input',
  })
}

export function QuickOpen({ rpc, sessionId, root, cardRef, currentPath, onOpen, onClose }) {
  const [query, setQuery] = React.useState(''), [result, setResult] = React.useState(null)
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const [selection, setSelection] = React.useState(0), [attempt, setAttempt] = React.useState(0)
  const input = React.useRef(null), sequence = React.useRef(0), previous = React.useRef(null)
  const title = React.useId()
  const { term, position } = splitQuickQuery(query)
  const currentFile = !term && position !== undefined
  const destination = position && `第 ${position.line} 行，第 ${position.column + 1} 列`
  React.useLayoutEffect(() => {
    previous.current = document.activeElement; input.current?.focus({ preventScroll: true })
    return () => { if (previous.current?.isConnected) previous.current.focus({ preventScroll: true }) }
  }, [])
  React.useEffect(() => {
    const current = ++sequence.current, controller = new AbortController()
    setResult(null); setError(''); setSelection(0); setBusy(Boolean(term))
    if (!term) return () => controller.abort()
    const timer = window.setTimeout(() => {
      void Promise.resolve().then(() => rpc.call('/api', 'world-vscode-search/files', { sessionId, root, query: term }, controller.signal)).then(reply => {
        if (!reply?.ok) throw new Error(reply?.error?.message || '文件搜索失败，请重试。')
        if (!controller.signal.aborted && sequence.current === current) setResult(reply.value)
      }).catch(cause => {
        if (!controller.signal.aborted && sequence.current === current) setError(cause.message || String(cause))
      }).finally(() => { if (!controller.signal.aborted && sequence.current === current) setBusy(false) })
    }, 200)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [term, attempt, sessionId, root, rpc])
  const files = term && position !== null && result?.query === term ? result.files : []
  const canJump = Boolean(currentFile && position && currentPath)
  React.useEffect(() => { cardRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [selection])
  let note = '输入文件名搜索；:行号[:列号] 跳转，也可输入 文件名:行号。'
  if (position === null) note = '请输入从 1 开始的行号，可在其后加 :列号。'
  else if (currentFile) note = currentPath ? `在 ${nameOf(currentPath)} 中定位。` : '请先打开源码文件。'
  else if (term) {
    if (error) note = error
    else if (busy || result?.query !== term) note = '正在搜索文件…'
    else if (!files.length) note = '没有匹配的文件。'
    else note = `${files.length} 个文件${destination ? ` · ${destination}` : ''}${result.truncated ? ' · 结果已截断，请缩小范围' : ''}`
  }
  const keyDown = event => {
    event.stopPropagation()
    if (event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') { event.preventDefault(); input.current?.focus(); return }
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
    if (event.key === 'Tab') {
      const controls = [...cardRef.current.querySelectorAll('input,button:not(:disabled)')]
      const index = controls.indexOf(document.activeElement)
      event.preventDefault(); controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setSelection(value => Math.max(0, Math.min(files.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1))))
    } else if (event.key === 'Enter' && event.target === input.current) {
      event.preventDefault()
      if (canJump) onOpen(null, position)
      else if (!busy && files[selection]) onOpen(files[selection].path, position)
      else if (term && error) setAttempt(value => value + 1)
    }
  }
  return h('div', { className: 'world-vscode-picker world-vscode-quickopen', onKeyDown: keyDown,
    onPointerDown: event => { if (event.target === event.currentTarget) onClose() } },
  h('section', { ref: cardRef, className: 'world-vscode-picker-card', role: 'dialog', 'aria-modal': true, 'aria-labelledby': title },
    h('div', { className: 'world-vscode-picker-head' }, h('span', { className: 'world-vscode-picker-title', id: title }, '搜索文件 · Ctrl+P'),
      h('button', { type: 'button', className: 'world-vscode-picker-close', 'aria-label': '关闭文件搜索', onClick: onClose }, '×')),
    h('div', { className: 'world-vscode-picker-path' },
      h('input', { ref: input, className: 'world-vscode-picker-input', 'aria-label': '搜索文件名', placeholder: '文件名或相对路径；:行号 跳转',
        spellCheck: false, value: query, onChange: event => setQuery(event.target.value) }),
      term && error && h('button', { type: 'button', className: 'world-vscode-picker-browse', onClick: () => setAttempt(value => value + 1) }, '重试')),
    h('div', { className: 'world-vscode-picker-note', role: term && error ? 'alert' : 'status' },
      term && error ? errorMessage(note, error) : note),
    h('div', { className: 'world-vscode-picker-list', role: 'listbox', 'aria-label': '文件搜索结果', 'aria-busy': Boolean(term && busy) },
      canJump && h('button', { type: 'button', role: 'option', 'aria-selected': true, className: 'world-vscode-picker-row',
        onClick: () => onOpen(null, position) }, `跳转到${destination}`),
      files.map((file, index) => h('button', { key: file.path, type: 'button', role: 'option', 'aria-selected': index === selection,
        className: 'world-vscode-picker-row', title: file.path, onMouseEnter: () => setSelection(index), onClick: () => onOpen(file.path, position) },
      h('span', { className: 'world-vscode-picker-root-name' }, nameOf(file.path)),
      h('span', { className: 'world-vscode-picker-root-note' }, directoryOf(file.path)))))))
}
