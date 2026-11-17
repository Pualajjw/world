import React from 'react'

const h = React.createElement
const nameOf = path => path.split('/').at(-1)
const directoryOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

export function QuickOpen({ rpc, sessionId, root, cardRef, onOpen, onClose }) {
  const [query, setQuery] = React.useState(''), [result, setResult] = React.useState(null)
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const [selection, setSelection] = React.useState(0), [attempt, setAttempt] = React.useState(0)
  const input = React.useRef(null), sequence = React.useRef(0), previous = React.useRef(null)
  const title = React.useId()
  React.useLayoutEffect(() => {
    previous.current = document.activeElement; input.current?.focus({ preventScroll: true })
    return () => { if (previous.current?.isConnected) previous.current.focus({ preventScroll: true }) }
  }, [])
  React.useEffect(() => {
    const current = ++sequence.current, controller = new AbortController(), term = query.trim()
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
  }, [query, attempt, sessionId, root, rpc])
  const files = result?.query === query.trim() ? result.files : []
  React.useEffect(() => { cardRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [selection])
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
      if (!busy && files[selection]) onOpen(files[selection].path)
      else if (error) setAttempt(value => value + 1)
    }
  }
  return h('div', { className: 'world-vscode-picker world-vscode-quickopen', onKeyDown: keyDown,
    onPointerDown: event => { if (event.target === event.currentTarget) onClose() } },
  h('section', { ref: cardRef, className: 'world-vscode-picker-card', role: 'dialog', 'aria-modal': true, 'aria-labelledby': title },
    h('div', { className: 'world-vscode-picker-head' }, h('span', { className: 'world-vscode-picker-title', id: title }, '搜索文件 · Ctrl+P'),
      h('button', { type: 'button', className: 'world-vscode-picker-close', 'aria-label': '关闭文件搜索', onClick: onClose }, '×')),
    h('div', { className: 'world-vscode-picker-path' },
      h('input', { ref: input, className: 'world-vscode-picker-input', 'aria-label': '搜索文件名', placeholder: '输入文件名或相对路径',
        spellCheck: false, value: query, onChange: event => setQuery(event.target.value) }),
      error && h('button', { type: 'button', className: 'world-vscode-picker-browse', onClick: () => setAttempt(value => value + 1) }, '重试')),
    h('div', { className: 'world-vscode-picker-note', role: error ? 'alert' : 'status' },
      error || (busy ? '正在搜索文件…' : !query.trim() ? '输入文件名，在当前文件夹及子目录中查找。'
        : result ? files.length ? `${files.length} 个文件${result.truncated ? ' · 结果已截断，请缩小范围' : ''}` : '没有匹配的文件。' : '正在搜索文件…')),
    h('div', { className: 'world-vscode-picker-list', role: 'listbox', 'aria-label': '文件搜索结果', 'aria-busy': busy },
      files.map((file, index) => h('button', { key: file.path, type: 'button', role: 'option', 'aria-selected': index === selection,
        className: 'world-vscode-picker-row', title: file.path, onMouseEnter: () => setSelection(index), onClick: () => onOpen(file.path) },
      h('span', { className: 'world-vscode-picker-root-name' }, nameOf(file.path)),
      h('span', { className: 'world-vscode-picker-root-note' }, directoryOf(file.path)))))))
}
