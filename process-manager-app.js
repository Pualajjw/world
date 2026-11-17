import React from 'react'
import { StoragePage } from './storage-manager-app.js'
import { ProcessPortsPage } from './process-ports-app.js'

const h = React.createElement
const keyOf = row => `${row.pid}:${row.startedAt}`
const memory = value => value == null ? '—' : `${(value / 1048576).toFixed(1)} MiB`
const percent = value => value == null ? '采样中' : `${value.toFixed(1)}%`
const clock = value => value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '尚未更新'

export function ProcessesGlyph({ size = 48 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 3 }),
  h('path', { d: 'M6 14h3l2-6 3 10 2-6h2' }))
}
export const PROCESS_APPS = [
  { key: 'world-processes', label: '进程管理器', icon: ProcessesGlyph, description: 'DSH 进程 · 端口占用 · 存储明细与空间清理' },
]

export function ProcessesPage({ rpc, visible = true }) {
  const [tab, setTab] = React.useState('processes')
  return h('div', { className: 'world-resource-manager' },
    h('div', { className: 'world-resource-tabs', role: 'tablist', 'aria-label': '资源管理视图' },
      ...[['processes', '进程'], ['ports', '端口占用'], ['storage', '存储与清理']].map(([id, label]) =>
        h('button', { type: 'button', key: id, role: 'tab', 'aria-selected': tab === id,
          onClick: () => setTab(id) }, label))),
    h('div', { className: 'world-resource-panel', hidden: tab !== 'processes', role: 'tabpanel', 'aria-label': '进程' },
      h(ProcessList, { rpc, visible: visible && tab === 'processes' })),
    h('div', { className: 'world-resource-panel', hidden: tab !== 'ports', role: 'tabpanel', 'aria-label': '端口占用' },
      tab === 'ports' && h(ProcessPortsPage, { rpc, visible })),
    h('div', { className: 'world-resource-panel', hidden: tab !== 'storage', role: 'tabpanel', 'aria-label': '存储与清理' },
      h(StoragePage, { rpc, visible: visible && tab === 'storage' })))
}

function ProcessList({ rpc, visible = true }) {
  const [snapshot, setSnapshot] = React.useState(null)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [paused, setPaused] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [sort, setSort] = React.useState({ key: 'cpu', descending: true })
  const [selection, setSelection] = React.useState('')
  const [path, setPath] = React.useState('')
  const [fileState, setFileState] = React.useState(null)
  const [pageVisible, setPageVisible] = React.useState(() => !document.hidden)
  const snapshotController = React.useRef(null), fileController = React.useRef(null)
  const alive = React.useRef(true), snapshotBusy = React.useRef(false), fileBusy = React.useRef(false)
  React.useEffect(() => {
    alive.current = true
    const sync = () => setPageVisible(!document.hidden)
    document.addEventListener('visibilitychange', sync)
    return () => {
      alive.current = false; document.removeEventListener('visibilitychange', sync)
      snapshotController.current?.abort(); fileController.current?.abort()
    }
  }, [])
  const request = React.useCallback(async (operation, payload, signal) => {
    const result = await rpc.call('/api', `world-processes/${operation}`, payload, signal)
    if (!result?.ok) throw new Error(result?.error?.message || '无法读取 DSH 进程。')
    return result.value
  }, [rpc])
  const refresh = React.useCallback(async () => {
    if (snapshotBusy.current) return
    snapshotBusy.current = true
    const controller = new AbortController(); snapshotController.current = controller
    setBusy(true)
    try {
      const value = await request('snapshot', {}, controller.signal)
      if (alive.current && !controller.signal.aborted) { setSnapshot(value); setError('') }
    } catch (cause) {
      if (alive.current && !controller.signal.aborted) setError(cause.message || String(cause))
    } finally {
      snapshotBusy.current = false
      if (alive.current) setBusy(false)
    }
  }, [request])
  React.useEffect(() => {
    if (!visible || !pageVisible || paused) return
    let stopped = false, timer
    const tick = async () => {
      const started = performance.now()
      await refresh()
      if (!stopped) timer = window.setTimeout(tick, Math.max(0, 2000 - (performance.now() - started)))
    }
    void tick()
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [visible, pageVisible, paused, refresh])
  React.useEffect(() => {
    if (!visible || !pageVisible) { snapshotController.current?.abort(); fileController.current?.abort() }
  }, [visible, pageVisible])
  const findOwners = async event => {
    event.preventDefault()
    if (!path.trim() || fileBusy.current) return
    const controller = new AbortController(); fileController.current = controller
    fileBusy.current = true; setFileState({ busy: true })
    try {
      const value = await request('files', { path: path.trim() }, controller.signal)
      if (alive.current && !controller.signal.aborted) setFileState({ ...value, busy: false })
    } catch (cause) {
      if (alive.current && !controller.signal.aborted) setFileState({ error: cause.message || String(cause), busy: false })
    } finally {
      fileBusy.current = false
      if (alive.current && controller.signal.aborted && fileController.current === controller) setFileState(null)
    }
  }
  const rows = (snapshot?.rows || []).filter(row =>
    `${row.name} ${row.pid} ${row.role}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key]
      if (av == null || bv == null) return av == null && bv != null ? 1 : bv == null && av != null ? -1 : a.pid - b.pid
      const compared = typeof av === 'string' ? av.localeCompare(bv, 'zh-CN') : av - bv
      return (sort.descending ? -compared : compared) || a.pid - b.pid
    })
  const selected = snapshot?.rows.find(row => keyOf(row) === selection)
  const column = (key, label) => h('th', { key, scope: 'col', 'aria-sort': sort.key === key ? sort.descending ? 'descending' : 'ascending' : 'none' },
    h('button', { type: 'button', onClick: () => setSort(current => ({ key, descending: current.key === key ? !current.descending : key !== 'name' })) },
      label, sort.key === key ? sort.descending ? ' ↓' : ' ↑' : ''))
  return h('div', { className: 'world-processes' },
    h('div', { className: 'world-processes-toolbar' },
      h('input', { 'aria-label': '搜索 DSH 进程', placeholder: '搜索名称或 PID', value: query, onChange: event => setQuery(event.target.value) }),
      h('button', { type: 'button', onClick: () => setPaused(value => !value), 'aria-pressed': paused }, paused ? '继续刷新' : '暂停刷新'),
      h('button', { type: 'button', disabled: busy, onClick: refresh }, busy ? '读取中…' : '刷新')),
    h('div', { className: 'world-resource-cards world-processes-summary', role: 'status' },
      ...[['DSH 进程', snapshot ? `${snapshot.totals.count} 个` : '—'], ['CPU', percent(snapshot?.totals.cpu)],
        ['工作集', memory(snapshot?.totals.workingSet)]].map(([label, value]) => h('div', { className: 'world-resource-card', key: label },
        h('span', null, label), h('strong', null, value)))),
    error && h('p', { className: 'world-processes-error', role: 'alert' }, `${error}${snapshot ? ' 已保留上次数据。' : ''}`),
    h('div', { className: 'world-processes-table-wrap' },
      h('table', { className: 'world-processes-table', 'aria-label': 'DSH 进程列表' },
        h('thead', null, h('tr', null, column('name', '进程'), column('pid', 'PID'), column('cpu', 'CPU'),
          column('workingSet', '工作集'), column('privateBytes', snapshot?.platform === 'linux' ? '匿名驻留' : '专用内存'))),
        h('tbody', null, rows.map(row => h('tr', { key: keyOf(row), tabIndex: 0, 'aria-selected': selection === keyOf(row),
          'data-process-pid': row.pid, onClick: () => setSelection(keyOf(row)),
          onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelection(keyOf(row)) } } },
          h('td', { title: row.role }, h('strong', null, row.name), h('span', null, row.role)), h('td', null, row.pid),
          h('td', null, percent(row.cpu)), h('td', null, memory(row.workingSet)), h('td', null, memory(row.privateBytes))))))),
    snapshot && !rows.length && h('p', { className: 'world-processes-hint' }, '没有匹配的 DSH 进程。'),
    h('section', { className: 'world-processes-detail', 'aria-label': '进程详情' },
      selected ? h(React.Fragment, null,
        h('strong', null, `${selected.name} · PID ${selected.pid}`),
        h('span', null, `父进程 ${selected.parentPid} · 线程 ${selected.threads ?? '—'} · ${snapshot?.platform === 'linux' ? '文件描述符' : '句柄'} ${selected.handles ?? '—'}`),
        h('input', { 'aria-label': '进程文件路径', readOnly: true, value: selected.path || '路径不可读取' }))
        : h('span', null, selection ? '所选进程已退出或不可读取。' : '选择进程，查看路径、父进程、线程和句柄。')),
    h('section', { className: 'world-processes-files', 'aria-label': '文件占用查询' },
      h('form', { className: 'world-processes-toolbar', onSubmit: findOwners },
        h('input', { 'aria-label': '查询占用的文件路径', placeholder: '输入完整文件路径，查询 DSH 占用', value: path,
          onChange: event => { fileController.current?.abort(); setFileState(null); setPath(event.target.value) } }),
        h('button', { type: 'submit', disabled: !path.trim() || fileState?.busy }, fileState?.busy ? '查询中…' : '查询占用')),
      fileState?.error && h('p', { role: 'alert', className: 'world-processes-error' }, fileState.error),
      fileState?.owners && h('div', { className: 'world-processes-owners', role: 'status' },
        h('span', { title: fileState.path }, fileState.owners.length ? '以下 DSH 进程正在占用该文件：' : '未发现 DSH 进程占用该文件；其他程序的占用不在查询范围内。'),
        ...fileState.owners.map(row => h('button', { key: keyOf(row), type: 'button',
          onClick: () => setSelection(keyOf(row)) }, `${row.name} · PID ${row.pid}`)))),
    h('footer', { className: 'world-processes-hint' },
      `${paused ? '已暂停' : '每 2 秒刷新'} · ${clock(snapshot?.timestamp)} · CPU 按整机核心归一化；工作集包含共享页，系统未提供的指标显示 —。`))
}
