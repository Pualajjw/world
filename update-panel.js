import React from 'react'
import { createPortal } from 'react-dom'
import { worldConfirm } from './world-confirm.js'

const h = React.createElement
const call = async (rpc, operation, payload = {}, signal) => {
  const reply = await rpc.call('/api', `world-update/${operation}`, payload, signal)
  if (!reply?.ok) throw new Error(reply?.error?.message || '升级服务不可用，请重试。')
  return reply.value
}

export function WorldVersion({ rpc, version, portal }) {
  const [details, setDetails] = React.useState(null), [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    const controller = new AbortController()
    void call(rpc, 'info', {}, controller.signal).then(value => { if (!controller.signal.aborted) setDetails(value) }).catch(() => {})
    return () => controller.abort()
  }, [rpc])
  return h(React.Fragment, null,
    h('span', { className: 'world-version', 'data-world-version': version },
      h('span', { className: 'world-version-numbers' },
        h('span', null, `world v${version}`),
        h('span', null, `DSH ${details?.dshVersion ? `v${details.dshVersion}` : '版本未知'}`)),
      ' · ',
      h('button', { type: 'button', 'data-world-update-open': true, onClick: () => setOpen(true) }, '检查更新')),
    open && portal && createPortal(h(UpdatePanel, { rpc, version, onInfo: setDetails, onClose: () => setOpen(false) }), portal))
}

export function UpdatePanel({ rpc, version, onInfo, onClose }) {
  const [details, setDetails] = React.useState(null), [checked, setChecked] = React.useState(null)
  const [job, setJob] = React.useState(null), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const active = React.useRef(null), lock = React.useRef(false), card = React.useRef(null)
  const alive = React.useRef(true), close = React.useRef(onClose)
  close.current = onClose
  const title = React.useId()
  React.useEffect(() => {
    alive.current = true
    const previous = document.activeElement
    card.current?.querySelector('button')?.focus()
    return () => { alive.current = false; active.current?.abort(); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  const watch = async (signal, initial) => {
    let state = initial
    while (!signal.aborted) {
      if (alive.current) setJob(state)
      if (state.state === 'idle' && initial.operation !== 'reinstall' && state.installedVersion === initial.version) {
        setJob({ state: 'success', version: initial.version })
        setDetails(value => ({ ...value, installedVersion: initial.version }))
        return
      }
      if (state.state !== 'installing') {
        if (state.state === 'error') throw new Error(state.message)
        if (state.state !== 'success') throw new Error('安装结果尚未确认，请重试查询状态。')
        setDetails(value => ({ ...value, installedVersion: state.version || initial.version }))
        return
      }
      await new Promise(resolve => setTimeout(resolve, 750))
      signal.throwIfAborted()
      state = await call(rpc, 'status', {}, signal)
    }
  }
  const run = async action => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    const controller = new AbortController(); active.current = controller
    try { await action(controller.signal) }
    catch (cause) { if (alive.current && !controller.signal.aborted) setError(cause.message || String(cause)) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  const check = () => run(async signal => {
    setChecked(null)
    let info = await call(rpc, 'info', {}, signal)
    if (signal.aborted) return
    setDetails(info); onInfo?.(info); setJob(info.job)
    if (info.job?.state === 'installing') {
      await watch(signal, info.job)
      info = await call(rpc, 'info', {}, signal)
      if (signal.aborted) return
      setDetails(info); onInfo?.(info)
    }
    // Completion history and pending restarts never replace a fresh source lookup.
    const result = await call(rpc, 'check', {}, signal)
    if (!signal.aborted) { setChecked(result); setDetails(result); setJob(null); onInfo?.(result) }
  })
  React.useEffect(() => { void check() }, [])
  const install = operation => run(async signal => {
    const reinstall = operation === 'reinstall', verb = reinstall ? '重装' : '升级'
    const confirmed = await worldConfirm({ title: `${verb} world`, confirmLabel: `确认${verb}`,
      message: reinstall ? `从 ${checked.sourceName} 重新安装当前版本 world ${checked.latestVersion}？`
        : `从 ${checked.sourceName} 将 world ${version} 升级到 ${checked.latestVersion}？`,
      detail: '安装完成后需要重启 DSH。' })
    if (!confirmed || signal.aborted) return
    // On a lost response, retrying a check first recovers this host-owned job instead of installing twice.
    setJob({ state: 'installing', message: `正在提交${verb}请求…` })
    const started = await call(rpc, operation, { token: checked.token, confirmed: true }, signal)
    await watch(signal, started)
  })
  const keyDown = event => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); close.current(); return }
    if (event.key === 'Tab') {
      const controls = [...card.current.querySelectorAll('button:not(:disabled)')]
      const index = controls.indexOf(document.activeElement)
      event.preventDefault(); controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus()
    }
  }
  const installedVersion = details?.installedVersion
  const restartRequired = details?.restartRequired || (installedVersion && installedVersion !== version) ||
    (job?.operation === 'reinstall' && job.state === 'success')
  const canUpgrade = checked?.available && checked.latestVersion !== installedVersion
  return h('div', { className: 'world-workbench-setup world-update-panel', 'data-world-update': true,
    onPointerDown: event => { if (event.target === event.currentTarget) close.current() } },
  h('div', { className: 'world-workbench-setup-card', ref: card, role: 'dialog', 'aria-modal': true,
    'aria-labelledby': title, 'aria-busy': busy, onKeyDown: keyDown },
    h('strong', { id: title }, 'world 更新'),
    h('p', null, `当前 world：v${version}`),
    h('p', null, `DSH 主程序：${details?.dshVersion ? `v${details.dshVersion}` : '版本未知'}`),
    h('p', null, `更新来源：${checked?.sourceName || (details ? details.source === 'pbpkg' ? 'pbpkg · 当前源' : 'GitHub · Pualajjw/world' : '正在读取…')}`),
    checked && h('p', null, `最新版本：v${checked.latestVersion}`),
    busy && h('p', { role: 'status' }, job?.state === 'installing' ? job.message || '正在安装更新…' : '正在检查更新…'),
    !busy && !error && checked && !checked.available && !restartRequired && h('p', { role: 'status' }, checked.sourceOlder ? '当前版本高于更新源版本。' : '当前已是最新版本。'),
    restartRequired && job?.state !== 'installing' && h('p', { role: 'status' }, `world ${installedVersion} 已安装，请重启 DSH。`),
    error && h('p', { role: 'alert' }, error),
    details && !details.canInstall && h('p', { role: 'alert' }, details.blockReason || '当前 DSH 未提供插件安装能力。'),
    h('div', { className: 'world-workbench-setup-actions' },
      h('button', { type: 'button', onClick: () => close.current() }, '关闭'),
      h('button', { type: 'button', disabled: busy, onClick: check }, error ? '重试' : '检查更新'),
      (canUpgrade || (checked?.reinstallable && !restartRequired)) && h('button', { type: 'button', className: 'is-primary',
        disabled: busy || Boolean(error) || job?.state === 'installing' || !details?.canInstall,
        onClick: () => install(canUpgrade ? 'install' : 'reinstall') }, canUpgrade ? '升级 world' : '重装 world'))))
}
