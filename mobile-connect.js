import React from 'react'
import { qrSvg } from './mobile-qr.js'

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
  const [expired, setExpired] = React.useState(false)
  const [network, setNetwork] = React.useState(null)
  const [host, setHost] = React.useState('')
  const [networkAttempt, setNetworkAttempt] = React.useState(0)
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
    return () => { window.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
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
    let timer
    setResult(null); setExpired(false)
    if (!network) return () => controller.abort()
    setError('')
    if (!host) return () => controller.abort()
    Promise.resolve().then(() => rpc.call('/api', 'world-mobile/open', { host }, controller.signal)).then(reply => {
      if (reply?.ok !== true) throw new Error(reply?.error?.message || '无法生成手机连接，请重试。')
      const { url, expiresAt } = reply.value
      const svg = qrSvg(url)
      if (controller.signal.aborted) return
      setResult({ url, expiresAt, svg })
      timer = setTimeout(() => setExpired(true), Math.max(0, expiresAt - Date.now()))
    }).catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => { controller.abort(); clearTimeout(timer) }
  }, [rpc, attempt, host, network])
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
          : !result ? h('p', { role: 'status' }, '正在生成二维码…')
          : expired ? h('p', { role: 'status' }, '二维码已过期，请刷新后扫码。')
            : h(React.Fragment, null,
              h('div', { className: 'world-mobile-qr', role: 'img', 'aria-label': '手机连接二维码', dangerouslySetInnerHTML: { __html: result.svg } }),
              h('p', null, '手机连接同一网络后扫码，直接打开 world。'))),
    h('div', { className: 'world-wallpaper-foot' }, h('span', { className: 'spacer' }),
      h('button', { type: 'button',
        onClick: () => network?.addresses.length ? setAttempt(value => value + 1) : setNetworkAttempt(value => value + 1),
        disabled: network?.addresses.length ? !host || (!result && !error) : !network && !error }, '刷新二维码'))))
}
