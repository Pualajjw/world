/**
 * 世界内确认框：替代 window.confirm。
 *
 * 原生 confirm 会在标题栏写「localhost 说…」，还会把整个 DSH 页面挂起；在模拟桌面上
 * 一眼就出戏。这里用一个模块级队列 + 一个挂在桌面树里的 ConfirmHost：
 * 调用方 `await worldConfirm({...})` 拿到 true / false，视觉、键盘和主题都跟窗口一致。
 *
 * 队列一次只显示一条（后来的排队），避免嵌套确认互相盖住。
 */
import React from 'react'

const h = React.createElement

const queue = []
const listeners = new Set()
let hostMounted = false
let idSeed = 0

function publish() {
  const head = queue[0] || null
  for (const listener of [...listeners]) listener(head)
}

function subscribe(listener) {
  listeners.add(listener)
  listener(queue[0] || null)
  return () => { listeners.delete(listener) }
}

/**
 * 问一句「要不要」。
 * @param {string|{title?:string,message:string,detail?:string,confirmLabel?:string,cancelLabel?:string,danger?:boolean}} options
 * @returns {Promise<boolean>} 确定 true / 取消 false（Esc、点遮罩、关窗口都算取消）
 */
export function worldConfirm(options) {
  const value = typeof options === 'string' ? { message: options } : (options || {})
  const entry = {
    id: ++idSeed,
    title: value.title || 'world',
    message: value.message || '',
    detail: value.detail || '',
    confirmLabel: value.confirmLabel || '确定',
    cancelLabel: value.cancelLabel || '取消',
    danger: Boolean(value.danger),
    resolve: null,
  }
  return new Promise(resolve => {
    entry.resolve = resolve
    queue.push(entry)
    publish()
  })
}

/** 当前排在最前面的那条（测试用）。 */
export function pendingConfirm() {
  return queue[0] || null
}

function settle(entry, ok) {
  const index = queue.indexOf(entry)
  if (index < 0) return
  queue.splice(index, 1)
  publish()
  entry.resolve(ok)
}

/** 焦点在卡片里循环：只有两个按钮，首尾互相接住，Tab 不会跑到底下的桌面去。 */
function trapTab(card, event) {
  const items = [...card.querySelectorAll('button:not([disabled]),[href],input,select,textarea')]
    .filter(node => node.offsetParent !== null)
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (!card.contains(active)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); return }
  if (event.shiftKey && active === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus() }
}

export function ConfirmHost() {
  const [entry, setEntry] = React.useState(null)
  const cardRef = React.useRef(null)
  const primaryRef = React.useRef(null)
  const cancelRef = React.useRef(null)
  const restoreRef = React.useRef(null)

  React.useEffect(() => {
    hostMounted = true
    const stop = subscribe(setEntry)
    return () => { hostMounted = false; stop() }
  }, [])

  React.useEffect(() => {
    if (!entry) return undefined
    restoreRef.current = document.activeElement
    // 危险动作默认停在「取消」上：回车不会顺手把东西删了。
    const target = entry.danger ? cancelRef.current : primaryRef.current
    target?.focus()
    return () => {
      const back = restoreRef.current
      restoreRef.current = null
      if (back && back.isConnected && typeof back.focus === 'function') back.focus()
    }
  }, [entry])

  React.useEffect(() => {
    if (!entry) return undefined
    const onKey = event => {
      if (event.isComposing) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        settle(entry, false)
        return
      }
      if (event.key === 'Tab' && cardRef.current) {
        event.stopPropagation()
        trapTab(cardRef.current, event)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [entry])

  if (!entry) return null

  const stop = event => event.stopPropagation()
  const titleId = `world-confirm-title-${entry.id}`
  const bodyId = `world-confirm-body-${entry.id}`

  return h('div', {
    className: 'world-confirm', 'data-world-confirm': true,
    onPointerDown: event => {
      // 点遮罩等于取消；但卡片里的点击继续往下走，别把它一起吞掉。
      event.stopPropagation()
      if (event.target === event.currentTarget) settle(entry, false)
    },
    onClick: stop,
    onContextMenu: event => { event.preventDefault(); stop(event) },
  },
  h('div', {
    className: `world-confirm-card${entry.danger ? ' is-danger' : ''}`,
    ref: cardRef,
    role: 'alertdialog', 'aria-modal': true, 'aria-labelledby': titleId, 'aria-describedby': bodyId,
    'data-world-confirm-card': true,
  },
  h('strong', { id: titleId, className: 'world-confirm-title' }, entry.title),
  h('p', { id: bodyId, className: 'world-confirm-message' }, entry.message),
  entry.detail ? h('p', { className: 'world-confirm-detail' }, entry.detail) : null,
  h('div', { className: 'world-confirm-actions' },
    h('button', {
      ref: cancelRef, type: 'button', 'data-role': 'cancel',
      onClick: () => settle(entry, false),
    }, entry.cancelLabel),
    h('button', {
      ref: primaryRef, type: 'button', className: 'is-primary', 'data-role': 'confirm',
      onClick: () => settle(entry, true),
    }, entry.confirmLabel))))
}

/** 测试与调试：宿主是否已经挂上（没挂时确认框会一直悬着）。 */
export function confirmHostMounted() {
  return hostMounted
}
