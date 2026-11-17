import React from 'react'

const h = React.createElement
const endpoint = (address, port) => port ? `${address.includes(':') ? `[${address}]` : address}:${port}` : '—'
export function ProcessPortsPage({ rpc, visible = true }) {
  const [snapshot, setSnapshot] = React.useState(null), [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false), [paused, setPaused] = React.useState(false), [query, setQuery] = React.useState('')
  const [pageVisible, setPageVisible] = React.useState(() => !document.hidden)
  const alive = React.useRef(true), reading = React.useRef(false), active = React.useRef(null)
  React.useEffect(() => {
    alive.current = true
    const sync = () => setPageVisible(!document.hidden)
    document.addEventListener('visibilitychange', sync)
    return () => { alive.current = false; active.current?.abort(); document.removeEventListener('visibilitychange', sync) }
  }, [])
  const refresh = React.useCallback(async () => {
    if (reading.current) return
    reading.current = true; setBusy(true)
    const controller = new AbortController(); active.current = controller
    try {
      const result = await rpc.call('/api', 'world-processes/ports', {}, controller.signal)
      if (!result?.ok) throw new Error(result?.error?.message || '无法读取 DSH 端口占用。')
      if (alive.current && !controller.signal.aborted) { setSnapshot(result.value); setError('') }
    } catch (cause) { if (alive.current && !controller.signal.aborted) setError(cause.message || String(cause)) }
    finally { reading.current = false; if (alive.current) setBusy(false) }
  }, [rpc])
  React.useEffect(() => {
    if (!visible || !pageVisible || paused) return
    let stopped = false, timer
    const tick = async () => { await refresh(); if (!stopped) timer = window.setTimeout(tick, 2000) }
    void tick()
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [visible, pageVisible, paused, refresh])
  React.useEffect(() => { if (!visible || !pageVisible) active.current?.abort() }, [visible, pageVisible])
  const rows = (snapshot?.rows || []).filter(row => `${row.name} ${row.pid} ${row.protocol} ${row.localAddress}:${row.localPort} ${row.remoteAddress}:${row.remotePort} ${row.state}`
    .toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return h('div', { className: 'world-processes', 'data-world-process-ports': true },
    h('div', { className: 'world-processes-toolbar' },
      h('input', { 'aria-label': '搜索 DSH 端口', placeholder: '搜索进程、PID、协议或端口', value: query, onChange: event => setQuery(event.target.value) }),
      h('button', { type: 'button', onClick: () => setPaused(value => !value), 'aria-pressed': paused }, paused ? '继续刷新' : '暂停刷新'),
      h('button', { type: 'button', disabled: busy, onClick: refresh }, busy ? '读取中…' : '刷新')),
    h('p', { className: 'world-processes-hint', role: 'status' }, snapshot ? `${rows.length} 条端口记录 · 当前 DSH 进程及其子进程` : '正在读取 DSH 端口占用…'),
    error && h('p', { className: 'world-processes-error', role: 'alert' }, `${error}${snapshot ? ' 已保留上次数据。' : ''}`),
    h('div', { className: 'world-processes-table-wrap' }, h('table', { className: 'world-processes-table', 'aria-label': 'DSH 端口占用列表' },
      h('thead', null, h('tr', null, ...['进程', 'PID', '协议', '本地地址 / 端口', '远端地址 / 端口', '状态'].map(label => h('th', { key: label, scope: 'col' }, label)))),
      h('tbody', null, rows.map((row, index) => h('tr', { key: `${row.pid}:${row.startedAt}:${row.protocol}:${row.localAddress}:${row.localPort}:${index}` },
        h('td', null, row.name), h('td', null, row.pid), h('td', null, row.protocol),
        h('td', null, endpoint(row.localAddress, row.localPort)), h('td', null, endpoint(row.remoteAddress, row.remotePort)), h('td', null, row.state)))))),
    snapshot && !rows.length && h('p', { className: 'world-processes-hint' }, query.trim() ? '没有匹配的端口记录。' : '当前未发现 DSH 相关进程占用 TCP/UDP 端口。'),
    h('footer', { className: 'world-processes-hint' }, `${paused ? '已暂停' : '每 2 秒刷新'} · TCP / UDP · IPv4 / IPv6`))
}
