import React from 'react'
import { copyMobileAddress } from './mobile-clipboard.js'

const h = React.createElement
export const ErrorDetailsContext = React.createContext(null)

// The provider belongs to one editor window, including its React portals. Shared native
// components outside VSCode keep their ordinary error text without a dead details link.
function DetailsButton({ text }) {
  const open = React.useContext(ErrorDetailsContext)
  return open && text ? h('button', { type: 'button', className: 'world-vscode-error-action', 'data-world-error-link': true, 'aria-haspopup': 'dialog',
    onClick: event => { event.stopPropagation(); open({ text, trigger: event.currentTarget }) },
  }, '查看详情') : null
}
export const detailsButton = text => text ? h(DetailsButton, { text }) : null
export const errorMessage = (text, details = text) => h(React.Fragment, null, h('span', null, text), detailsButton(details))

// Native slots render their own alerts (e.g. corrupt PDFs). Keep our action outside the
// host's DOM tree and snapshot only the visible messages, excluding retry/dismiss controls.
export function NativeErrorScope({ children, visible, ...props }) {
  const root = React.useRef(null), [text, setText] = React.useState('')
  React.useLayoutEffect(() => {
    if (!visible) return undefined
    const node = root.current
    let timer = 0
    const update = () => {
      const messages = []
      for (const alert of node.querySelectorAll('[role="alert"], [data-slot-error]')) {
        if (!alert.getClientRects().length || alert.closest('[aria-hidden="true"]') || alert.querySelector('[data-world-error-link]')) continue
        const copy = alert.cloneNode(true)
        copy.querySelectorAll('button, [role="button"]').forEach(button => button.remove())
        copy.querySelectorAll('br').forEach(br => br.replaceWith('\n'))
        if (copy.textContent.trim()) messages.push(copy.textContent)
      }
      setText([...new Set(messages)].join('\n\n'))
    }
    // A streaming conversation mutates this subtree per token; a forced layout per
    // mutation is not worth it. Coalesce into one scan and keep the last one immediate.
    const schedule = () => { if (!timer) timer = setTimeout(() => { timer = 0; update() }, 250) }
    const observer = new MutationObserver(schedule)
    observer.observe(node, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['role', 'aria-hidden', 'hidden', 'data-slot-error'] })
    update()
    return () => { clearTimeout(timer); observer.disconnect() }
  }, [visible])
  return h('div', { ...props, ref: root }, children, text && h('div', { className: 'world-vscode-native-error-link' }, detailsButton(text)))
}

export function ErrorDetailsDialog({ details, onClose }) {
  const card = React.useRef(null), source = React.useRef(null)
  const [feedback, setFeedback] = React.useState('')
  React.useLayoutEffect(() => {
    source.current.focus({ preventScroll: true })
    return () => { if (details.trigger?.isConnected) details.trigger.focus({ preventScroll: true }) }
  }, [details])
  const copy = async () => {
    const copied = await copyMobileAddress(details.text, card.current)
    if (!card.current) return
    setFeedback(copied ? '已复制错误信息' : '未能自动复制，请选中原文手动复制。')
    if (!copied) { source.current.focus(); source.current.select() }
  }
  const keyDown = event => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); onClose() }
    if (event.key !== 'Tab') return
    const nodes = [...card.current.querySelectorAll('button,textarea')]
    if (event.shiftKey && event.target === nodes[0]) { event.preventDefault(); nodes.at(-1).focus() }
    else if (!event.shiftKey && event.target === nodes.at(-1)) { event.preventDefault(); nodes[0].focus() }
  }
  return h('div', { className: 'world-vscode-picker', 'data-world-error-details': true, onKeyDown: keyDown,
    onPointerDown: event => { if (event.target === event.currentTarget) onClose() } },
    h('section', { className: 'world-vscode-picker-card', role: 'dialog', 'aria-modal': true, 'aria-label': '错误详情', ref: card },
      h('header', { className: 'world-vscode-picker-head' }, h('span', { className: 'world-vscode-picker-title' }, '错误详情'),
        h('button', { type: 'button', className: 'world-vscode-picker-close', 'aria-label': '关闭错误详情', onClick: onClose }, '×')),
      h('textarea', { className: 'world-vscode-error-source', ref: source, 'aria-label': '错误原文', readOnly: true, spellCheck: false, value: details.text }),
      h('footer', { className: 'world-vscode-picker-foot' }, h('span', { className: 'world-vscode-picker-hint', role: 'status' }, feedback),
        h('span', { className: 'world-vscode-picker-actions' }, h('button', { type: 'button', className: 'is-primary', onClick: copy }, '复制错误信息')))))
}
