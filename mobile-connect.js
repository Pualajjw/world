import React from 'react'
import { qrSvg } from './mobile-qr.js'
import { worldConfirm } from './world-confirm.js'
import { copyMobileAddress } from './mobile-clipboard.js'

const h = React.createElement
export function MobileGlyph({ size = 34 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
    h('rect', { x: 6, y: 2, width: 12, height: 20, rx: 2 }), h('path', { d: 'M10 18h4M10 5h4' }))
}
/** Same dialog surface as personalization; only the QR size is new (approved: 240 CSS px). */
export function MobileConnect({ rpc, onClose }) {
  const [attempt, setAttempt] = React.useState(0)
  const [result, setResult] = React.useState(null)
  const [error, setError] = React.useState('')
  const [network, setNetwork] = React.useState(null)
  const [host, setHost] = React.useState('')
  const [networkAttempt, setNetworkAttempt] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [copyState, setCopyState] = React.useState('')
  const copyId = React.useRef(0), copyBusy = React.useRef(false)
  // The link never expires, so a stale QR is only possible after an explicit reset.
  const operation = React.useRef('open')
  const card = React.useRef(null), close = React.useRef(onClose)
  close.current = onClose
  const title = React.useId()
  React.useEffect(() => {
    const previous = document.activeElement
    card.current?.querySelector('button')?.focus()
    const key = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current() }
      if (event.key === 'Tab') {
        const controls = [...card.current.querySelectorAll('button:not(:disabled),select:not(:disabled)')]
        const index = controls.indexOf(document.activeElement)
        event.preventDefault(); controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => { copyId.current++; window.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  React.useEffect(() => {
    const controller = new AbortController()
    setNetwork(null); setHost(''); setError('')
    Promise.resolve().then(() => rpc.call('/api', 'world-mobile/addresses', {}, controller.signal)).then(reply => {
      if (reply?.ok !== true) throw new Error(reply?.error?.message || '无法读取网络地址，请重试。')
      if (controller.signal.aborted) return
      const value = reply.value
      setNetwork(value)
      setHost(value.selectedHost || (value.addresses.length === 1 ? value.addresses[0].address : ''))
    }).catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => controller.abort()
  }, [rpc, networkAttempt])
  React.useEffect(() => {
    const controller = new AbortController()
    setResult(null)
    copyId.current++; copyBusy.current = false; setCopyState('')
    if (!network) return () => controller.abort()
    setError('')
    if (!host) return () => controller.abort()
    const action = operation.current
    operation.current = 'open'
    Promise.resolve().then(() => rpc.call('/api', `world-mobile/${action}`, { host }, controller.signal)).then(reply => {
      if (reply?.ok !== true) throw new Error(reply?.error?.message || '无法生成手机连接，请重试。')
      const { url } = reply.value
      const svg = qrSvg(url)
      if (controller.signal.aborted) return
      setResult({ url, svg })
    }).catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [rpc, attempt, host, network])
  const copyAddress = async () => {
    if (!result || busy || copyBusy.current) return
    const id = ++copyId.current
    copyBusy.current = true; setCopyState('copying')
    const copied = await copyMobileAddress(result.url, card.current)
    if (id !== copyId.current) return
    copyBusy.current = false; setCopyState(copied ? 'copied' : 'failed')
  }
  const reset = async () => {
    if (busy) return
    const confirmed = await worldConfirm({
      title: '重置手机连接',
      message: '重置后这个二维码会换成新的，已经连接过的手机也需要重新扫码。',
      detail: '二维码长期有效，只有在这里重置才会失效。',
      confirmLabel: '重置', danger: true,
    })
    if (!confirmed) return
    setBusy(true); operation.current = 'reset'
    setAttempt(value => value + 1)
  }
  const retry = () => (network?.addresses.length ? setAttempt(value => value + 1) : setNetworkAttempt(value => value + 1))
  return h('div', { className: 'world-wallpaper-panel', 'data-world-mobile-connect': true,
    onPointerDown: event => { if (event.target === event.currentTarget) onClose() } },
  h('div', { className: 'world-wallpaper-card', role: 'dialog', 'aria-modal': true, 'aria-labelledby': title, ref: card },
    h('div', { className: 'world-wallpaper-head' }, h('strong', { id: title }, '手机连接'),
      h('button', { type: 'button', className: 'world-wallpaper-close', 'aria-label': '关闭手机连接', onClick: onClose }, '×')),
    h('div', { className: 'world-wallpaper-body world-mobile-body' },
      network && !network.configured && network.addresses.length > 0 && h('label', { className: 'world-mobile-network' },
        '网络地址',
        h('select', { value: host, 'aria-label': '手机连接网络地址', onChange: event => setHost(event.target.value) },
          h('option', { value: '', disabled: true }, '请选择手机可访问的电脑 IP'),
          ...network.addresses.map(row => h('option', { key: row.address, value: row.address }, `${row.name} · ${row.address}`)))),
      error ? h('p', { role: 'alert' }, error)
        : !network ? h('p', { role: 'status' }, '正在检测网络地址…')
          : !network.addresses.length ? h('p', { role: 'status' }, '未找到可用网络，请先连接 Wi-Fi 或有线网络。')
          : !host ? h('p', { role: 'status' }, '请选择手机可访问的电脑地址。')
          : !result ? h('p', { role: 'status' }, busy ? '正在重置二维码…' : '正在生成二维码…')
            : h(React.Fragment, null,
              h('div', { className: 'world-mobile-qr', role: 'img', 'aria-label': '手机连接二维码', dangerouslySetInnerHTML: { __html: result.svg } }),
              h('p', { className: 'world-mobile-note' }, '手机与电脑连接同一网络后扫码，直接打开 world。'),
              h('p', { className: 'world-mobile-note is-quiet' }, '二维码长期有效，重启 DSH 后仍可扫描。'))),
    copyState === 'failed' && h('p', { className: 'world-mobile-note', role: 'alert' }, '复制失败，请重试或扫描二维码。'),
    h('div', { className: 'world-wallpaper-foot' },
      h('button', { type: 'button', className: 'world-mobile-reset', onClick: reset, disabled: !result || busy }, '重置链接'),
      h('button', { type: 'button', className: 'world-mobile-copy', onClick: copyAddress,
        disabled: !result || busy, 'aria-disabled': copyState === 'copying', 'aria-busy': copyState === 'copying', 'aria-label': '复制地址' },
        copyState === 'copying' ? '复制中…' : copyState === 'copied' ? '已复制' : '复制地址'),
      h('span', { className: 'spacer' }),
      error ? h('button', { type: 'button', onClick: retry }, '重试')
        : h('button', { type: 'button', onClick: onClose }, '关闭'))))
}
