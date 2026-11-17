import React from 'react'
import { worldConfirm } from './world-confirm.js'

const h = React.createElement
export const diskBytes = value => {
  if (value == null) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let number = value, unit = 0
  while (number >= 1024 && unit < units.length - 1) { number /= 1024; unit++ }
  return `${number.toFixed(unit ? 1 : 0)} ${units[unit]}`
}
const STATES = { missing: '未找到', error: '不可读取', overlap: '已合并统计', partial: '部分统计', cancelled: '已停止' }

export function StoragePage({ rpc, visible }) {
  const [data, setData] = React.useState(null), [job, setJob] = React.useState(null)
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
  const [listError, setListError] = React.useState('')
  const [rootId, setRootId] = React.useState(''), [parentId, setParentId] = React.useState('')
  const [query, setQuery] = React.useState(''), [offset, setOffset] = React.useState(0)
  const [listing, setListing] = React.useState(null), [listingBusy, setListingBusy] = React.useState(false)
  const [selected, setSelected] = React.useState([]), [report, setReport] = React.useState(null)
  const alive = React.useRef(true), locked = React.useRef(false), initial = React.useRef(false), listVersion = React.useRef(0)
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; listVersion.current++ } }, [])
  const request = React.useCallback(async (operation, payload = {}) => {
    const result = await rpc.call('/api', `world-storage/${operation}`, payload)
    if (!result?.ok) throw new Error(result?.error?.message || '存储操作失败，请重试。')
    return result.value
  }, [rpc])
  const accept = value => {
    setData(value); setSelected([]); setListing(null); setParentId(''); setOffset(0); setQuery('')
    setRootId(value.roots.find(root => root.state !== 'missing' && root.state !== 'error')?.id || value.roots[0]?.id || '')
  }
  const watch = async id => {
    while (alive.current) {
      const state = await request('status', { jobId: id })
      if (!alive.current) return
      setJob(state)
      if (state.state === 'error') throw new Error(state.error)
      if (state.state !== 'running') {
        if (state.mode === 'scan') accept(state.result)
        else {
          setReport(state.result)
          const next = await request('start', { mode: 'scan' })
          if (alive.current) await watch(next.jobId)
        }
        return
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  const run = async action => {
    if (locked.current) return
    locked.current = true; setBusy(true); setError(''); listVersion.current++
    try { await action() }
    catch (cause) { if (alive.current) setError(cause.message || String(cause)) }
    finally { locked.current = false; if (alive.current) setBusy(false) }
  }
  const scan = () => run(async () => { setJob(null); const next = await request('start', { mode: 'scan' }); await watch(next.jobId) })
  React.useEffect(() => {
    if (!visible || initial.current) return
    initial.current = true
    void run(async () => {
      const current = await request('status')
      if (!alive.current) return
      if (current.state === 'running') await watch(current.id)
      else if (current.state === 'done' && current.mode === 'scan') { setJob(current); accept(current.result) }
      else { const next = await request('start', { mode: 'scan' }); await watch(next.jobId) }
    })
  }, [visible])
  React.useEffect(() => {
    if (!data || !rootId || busy || !visible) return
    const version = ++listVersion.current
    setListingBusy(true); setListError('')
    void request('list', { scanId: data.scanId, rootId, parentId, query, offset }).then(value => {
      if (alive.current && version === listVersion.current) setListing(value)
    }).catch(cause => { if (alive.current && version === listVersion.current) setListError(cause.message) })
      .finally(() => { if (alive.current && version === listVersion.current) setListingBusy(false) })
    return () => { listVersion.current++ }
  }, [data, rootId, parentId, query, offset, busy, visible, request])
  const cleanup = () => run(async () => {
    const preview = await request('preview', { scanId: data.scanId, ruleIds: selected })
    if (!alive.current) return
    const confirmed = await worldConfirm({ title: '释放 DSH 磁盘空间', danger: true, confirmLabel: '清理所选文件',
      message: `将永久删除 ${preview.count} 个文件，预计释放 ${diskBytes(preview.bytes)}。`,
      detail: `${preview.categories.join('、')}。仅包含 7 天以上未使用的文件；已变化或无法删除的文件将跳过。` })
    if (!confirmed || !alive.current) return
    setJob(null)
    const next = await request('start', { mode: 'cleanup', token: preview.token, confirmed: true })
    await watch(next.jobId)
  })
  const cancel = async () => {
    if (!job || job.state !== 'running') return
    try { await request('cancel', { jobId: job.id }) }
    catch (cause) { if (alive.current) setError(cause.message) }
  }
  const activeRoot = data?.roots.find(root => root.id === rootId)
  const picked = data?.rules.filter(rule => selected.includes(rule.id)) || []
  const navigate = id => { setParentId(id); setQuery(''); setOffset(0); setListing(null) }
  return h('div', { className: 'world-storage', 'aria-busy': busy },
    h('div', { className: 'world-storage-heading' },
      h('div', null, h('strong', null, 'DSH 存储空间'), h('p', null, '安装目录与 DSH 用户数据 · 按文件大小统计')),
      h('button', { type: 'button', disabled: busy, onClick: scan }, busy ? '处理中…' : '重新扫描')),
    h('div', { className: 'world-resource-cards' },
      ...[['安装占用', data?.totals.install], ['用户数据', data?.totals.user], ['可释放空间', data?.totals.reclaimable]].map(([label, value]) =>
        h('div', { className: 'world-resource-card', key: label }, h('span', null, label), h('strong', null, diskBytes(value))))),
    busy && h('div', { className: 'world-storage-progress', role: 'status' },
      h('span', null, job?.state === 'running' ? `${job.mode === 'cleanup' ? '正在清理' : '正在扫描'} · 已处理 ${job.visited} 项` : '正在准备…'),
      h('span', { title: job?.path }, job?.path || ''),
      job?.state === 'running' && h('button', { type: 'button', onClick: cancel }, '停止')),
    (error || listError) && h('p', { role: 'alert', className: 'world-processes-error' }, error || listError),
    report && h('div', { className: 'world-storage-report', role: 'status' },
      h('strong', null, `${report.cancelled ? '清理已停止' : '清理完成'} · 已删除 ${report.removed} 个文件（${diskBytes(report.bytes)}）`),
      h('span', null, `跳过 ${report.skipped} 个；实际可用空间以系统为准。`),
      report.failures.length > 0 && h('details', null, h('summary', null, '查看未清理的文件'),
        ...report.failures.map((item, index) => h('p', { key: index }, `${item.path}：${item.reason}`)))),
    data?.partial && h('p', { className: 'world-processes-hint' }, '当前为部分统计，未读取的文件没有计入。'),
    h('div', { className: 'world-storage-content' },
      h('aside', { className: 'world-storage-roots', 'aria-label': 'DSH 存储目录' },
        ...(data?.roots || []).map(root => h('button', { type: 'button', key: root.id, disabled: busy,
          'aria-pressed': root.id === rootId, onClick: () => { setRootId(root.id); navigate('') } },
        h('strong', null, root.label), h('span', null, STATES[root.state] || diskBytes(root.bytes)), h('small', { title: root.path }, root.path))),
        h('p', null, '符号链接不跟随；硬链接只计一次。安装文件、会话、原始附件及配置保留。')),
      h('section', { className: 'world-storage-files', 'aria-label': '磁盘文件明细', 'aria-busy': listingBusy },
        h('div', { className: 'world-storage-listbar' },
          h('button', { type: 'button', disabled: busy || !listing?.parent?.parentId, onClick: () => navigate(listing.parent.parentId) }, '上一级'),
          h('input', { value: query, disabled: busy, 'aria-label': '搜索 DSH 存储文件', placeholder: '搜索此目录下的文件与文件夹',
            onChange: event => { setQuery(event.target.value); setOffset(0) } })),
        h('div', { className: 'world-storage-path', title: listing?.parent?.path || activeRoot?.path }, listing?.parent?.path || activeRoot?.path || '扫描后显示目录'),
        h('div', { className: 'world-storage-table-wrap' }, h('table', { className: 'world-processes-table', 'aria-label': 'DSH 磁盘文件列表' },
          h('thead', null, h('tr', null, h('th', null, '名称'), h('th', null, '大小 ↓'), h('th', null, '类型 / 清理'))),
          h('tbody', null, ...(listing?.items || []).map(entry => h('tr', { key: entry.id, 'data-storage-entry': entry.name },
            h('td', { title: entry.path }, entry.type === 'directory'
              ? h('button', { type: 'button', onClick: () => navigate(entry.id) }, entry.name)
              : h('span', { className: 'world-storage-filename' }, entry.name)),
            h('td', null, diskBytes(entry.bytes)),
            h('td', null, entry.type === 'directory' ? `${entry.files} 个文件` : entry.duplicate ? '硬链接 · 已计入' : entry.ruleId ? '可清理' : '保留')))))),
        (!listing?.items.length || listingBusy) && h('p', { className: 'world-processes-hint', role: 'status' }, listingBusy ? '正在读取明细…' : activeRoot?.error || (query ? '没有匹配的文件。' : '此处没有可列出的文件。')),
        listing?.total > 100 && h('div', { className: 'world-storage-pagination' },
          h('button', { type: 'button', disabled: offset === 0 || busy, onClick: () => setOffset(value => Math.max(0, value - 100)) }, '上一页'),
          h('span', null, `${offset + 1}–${Math.min(offset + 100, listing.total)} / ${listing.total}`),
          h('button', { type: 'button', disabled: offset + 100 >= listing.total || busy, onClick: () => setOffset(value => value + 100) }, '下一页')))),
    h('div', { className: 'world-storage-cleanup' },
      h('div', { className: 'world-storage-rules' }, ...(data?.rules || []).map(rule => h('label', { key: rule.id, title: rule.note },
        h('input', { type: 'checkbox', checked: selected.includes(rule.id), disabled: busy || !rule.count,
          onChange: event => setSelected(ids => event.target.checked ? [...ids, rule.id] : ids.filter(id => id !== rule.id)) }),
        h('span', null, rule.label, h('small', null, `${rule.count} 个 · ${diskBytes(rule.bytes)}`))))),
      h('div', { className: 'world-storage-cleanup-note' }, '仅清理 7 天以上未使用的可再生成文件与旧日志。删除前可预览并取消。')),
    h('div', { className: 'world-storage-cleanup-action' },
        h('span', null, `已选 ${picked.reduce((sum, rule) => sum + rule.count, 0)} 个 · ${diskBytes(picked.reduce((sum, rule) => sum + rule.bytes, 0))}`),
        h('button', { type: 'button', className: 'is-primary', disabled: busy || !selected.length, onClick: cleanup }, '释放空间')),
    data?.warnings.length > 0 && h('details', { className: 'world-storage-warnings' }, h('summary', null, `扫描提示（${data.warnings.length}）`),
      ...data.warnings.map((message, index) => h('p', { key: index }, message))))
}
