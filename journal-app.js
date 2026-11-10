import React from 'react'

const h = React.createElement
const date = value => new Date(value).toLocaleString('zh-CN', { hour12: false })
const uuid = () => crypto.randomUUID?.() || [...crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16)).join('-')

export function DiaryGlyph({ size = 48 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M5 3.5h14v17H5zM8 3.5v17M11 8h5M11 12h5M11 16h3M3 7h4M3 12h4M3 17h4' }))
}
export function TrashGlyph({ size = 48 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7' }))
}
export const JOURNAL_APPS = [
  { key: 'world-diary', label: '日记', icon: DiaryGlyph, description: '助手工作记录 · 可以一起编辑' },
  { key: 'world-trash', label: '垃圾箱', icon: TrashGlyph, description: '已移除的日记 · 恢复或永久删除' },
]

function Confirm({ message, confirmLabel, busy, onCancel, onConfirm }) {
  const ref = React.useRef(null)
  React.useLayoutEffect(() => {
    const previous = document.activeElement
    ref.current?.querySelector('button')?.focus()
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  return h('div', { className: 'world-journal-confirm', onPointerDown: event => event.stopPropagation() },
    h('div', { ref, role: 'dialog', 'aria-modal': true, 'aria-label': confirmLabel,
      className: 'world-workbench-setup-card world-journal-confirm-card',
      onKeyDown: event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onCancel() }
        if (event.key === 'Tab') {
          const buttons = [...ref.current.querySelectorAll('button:not(:disabled)')]
          if (!buttons.length) { event.preventDefault(); return }
          const index = buttons.indexOf(document.activeElement)
          event.preventDefault(); buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus()
        }
      },
    }, h('strong', null, confirmLabel), h('p', null, message),
    h('div', { className: 'world-journal-buttons' },
      h('button', { type: 'button', disabled: busy, onClick: onCancel }, '取消'),
      h('button', { type: 'button', disabled: busy, onClick: onConfirm }, busy ? '处理中…' : confirmLabel))))
}

/** Plain-text diary editing and a separate read-only trash view, using one shared client store. */
export function JournalPage({ client, trash = false, visible = true }) {
  const store = React.useSyncExternalStore(client.subscribe, client.getSnapshot)
  const list = trash ? store.trash : store.active
  const [selected, setSelected] = React.useState(() => !trash ? client.draftList()[0]?.id || null : null)
  const [entry, setEntry] = React.useState(null), [draft, setDraft] = React.useState(null)
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [notice, setNotice] = React.useState('')
  const [confirm, setConfirm] = React.useState(null), [offset, setOffset] = React.useState(0), [reload, setReload] = React.useState(0)
  const [search, setSearch] = React.useState(''), [query, setQuery] = React.useState('')
  const alive = React.useRef(true)
  React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 260)
    return () => clearTimeout(timer)
  }, [search])
  React.useEffect(() => { setOffset(0) }, [query])
  React.useEffect(() => {
    if (!visible) return
    const update = () => { void client.refresh(trash, 100, offset, query).catch(() => {}) }
    update()
    const timer = setInterval(update, 2000)
    window.addEventListener('focus', update)
    return () => { clearInterval(timer); window.removeEventListener('focus', update) }
  }, [client, trash, visible, offset, query])
  React.useEffect(() => { if (list.revision >= 0 && offset > 0 && offset >= list.total) setOffset(Math.max(0, Math.floor((list.total - 1) / 100) * 100)) }, [list.revision, list.total, offset])
  const local = trash ? [] : client.draftList().filter(item => item.revision === 0 && !list.entries.some(row => row.id === item.id))
  const pageReady = list.offset === offset
  const rows = [...local.map(item => ({ ...item, updatedAt: item.updatedAt || Date.now(), createdBy: 'human', local: true })), ...(pageReady ? list.entries : [])]
  const selectedRow = list.entries.find(item => item.id === selected)
  React.useEffect(() => {
    if (!selected && pageReady && rows.length) setSelected(rows[0].id)
  }, [selected, pageReady, list.entries, store.draftVersion])
  React.useEffect(() => {
    if (busy) return
    if (!selected) { setEntry(null); setDraft(null); return }
    const cached = !trash && client.draft(selected)
    if (cached?.dirty) setDraft(cached)
    if (cached?.revision === 0 && !selectedRow) { setEntry(null); setDraft(cached); return }
    const abort = new AbortController()
    void client.read(selected, abort.signal).then(value => {
      if (abort.signal.aborted) return
      if (trash && value.deletedAt === null) { setSelected(null); setEntry(null); setDraft(null); return }
      setEntry(value)
      const saved = !trash && client.draft(selected)
      setDraft(saved?.dirty ? saved : { ...value, dirty: false })
      if (saved && !saved.dirty) client.clearDraft(selected)
    }).catch(error => {
      if (abort.signal.aborted) return
      if (error.code === 'WORLD_DIARY_NOT_FOUND' && !client.draft(selected)?.dirty) { setSelected(null); setEntry(null); setDraft(null) }
      setError(error.message)
    })
    return () => abort.abort()
  }, [client, trash, selected, selectedRow?.revision, list.revision, list.error, reload, busy])
  const run = async body => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await body() }
    catch (error) { if (alive.current) setError(error.message || String(error)) }
    finally { if (alive.current) setBusy(false) }
  }
  const togglePin = item => run(async () => {
    const saved = await client.change('pin', { id: item.id, expectedRevision: item.revision, pinned: !item.pinned })
    if (!alive.current) return
    setNotice(saved.pinned ? '已置顶，唤醒时会优先带回。' : '已取消置顶。')
    if (item.id === selected && !draft?.dirty) { setEntry(saved); setDraft({ ...saved, dirty: false }) }
  })
  const updateDraft = patch => {
    const value = { ...draft, ...patch }
    value.dirty = value.revision === 0 ? Boolean(value.title || value.body) : value.title !== entry?.title || value.body !== entry?.body
    if (!value.dirty && entry) value.revision = entry.revision
    setDraft(value)
    if (!value.dirty && value.revision > 0) client.clearDraft(value.id)
    else client.setDraft(value)
  }
  const freshDraft = () => {
    const value = { id: uuid(), title: '', body: '', revision: 0, dirty: false, updatedAt: Date.now() }
    client.setDraft(value); setOffset(0); setSelected(value.id); setEntry(null); setDraft(value); setError(''); setNotice('')
  }
  const ask = (message, confirmLabel, action) => setConfirm({ message, confirmLabel, action })
  const save = () => run(async () => {
    const saved = await client.change('write', { id: draft.id, title: draft.title, body: draft.body, expectedRevision: draft.revision })
    client.clearDraft(draft.id, draft)
    if (alive.current) { setOffset(0); setSelected(saved.id); setEntry(saved); setDraft(client.draft(draft.id) || { ...saved, dirty: false }); setNotice('已保存') }
  })
  const remove = () => {
    if (draft?.revision === 0) {
      const discard = () => { client.clearDraft(draft.id); setSelected(null); setDraft(null) }
      if (draft.dirty) ask('放弃这条尚未保存的日记草稿？', '放弃草稿', discard)
      else discard()
    } else {
      const previousDraft = client.draft(entry.id)
      void run(async () => {
        await client.change('trash', { id: entry.id, expectedRevision: entry.revision })
        client.clearDraft(entry.id, previousDraft); if (alive.current) { setSelected(null); setNotice('已移入垃圾箱，可以恢复') }
      })
    }
  }
  const refreshEntry = () => {
    const action = () => run(async () => {
      const previousDraft = client.draft(selected)
      const value = await client.read(selected)
      if (client.draft(selected) !== previousDraft) {
        if (alive.current) setNotice('读取期间草稿已更新，已保留新的修改。')
        return
      }
      client.clearDraft(selected, previousDraft)
      if (alive.current) { setEntry(value); setDraft({ ...value, dirty: false }); setNotice('已重新读取') }
    })
    if (draft?.dirty) ask('放弃当前未保存的修改，并重新读取这条日记？', '重新读取', action)
    else action()
  }
  const selectedEntry = entry?.id === selected ? entry : null
  const selectedDraft = draft?.id === selected ? draft : null
  const stale = selectedDraft?.dirty && selectedEntry && selectedDraft.revision !== selectedEntry.revision
  const moved = !trash && selectedEntry?.deletedAt !== null && selectedEntry?.deletedAt !== undefined
  const current = trash ? selectedEntry : selectedDraft
  return h('div', { className: 'world-journal', 'data-world-journal-view': trash ? 'trash' : 'diary' },
    h('aside', { className: 'world-journal-list', 'aria-label': trash ? '垃圾箱条目' : '日记列表', inert: confirm ? '' : undefined },
      h('div', { className: 'world-journal-toolbar world-journal-buttons' },
        h('strong', null, trash ? `垃圾箱 · ${list.total}` : query ? `搜索 · ${list.total}` : `日记 · ${list.total}`),
        trash ? h('button', { type: 'button', disabled: busy || !list.total, onClick: () => ask(`清空垃圾箱中的 ${list.total} 条日记？此操作无法恢复。`, '清空垃圾箱',
          () => run(async () => { await client.change('clear', { confirmed: true, expectedRevision: list.revision }); if (alive.current) { setSelected(null); setEntry(null); setNotice('垃圾箱已清空') } })) }, '清空')
          : h('button', { type: 'button', disabled: busy, onClick: freshDraft }, '新建日记')),
      !trash && h('div', { className: 'world-journal-search' },
        h('input', { type: 'search', 'aria-label': '搜索日记', placeholder: '搜索标题或正文', value: search, disabled: busy,
          onChange: event => setSearch(event.target.value) }),
        search && h('button', { type: 'button', className: 'world-journal-search-clear', disabled: busy, onClick: () => setSearch('') }, '清空')),
      list.error && h('p', { role: 'alert', className: 'world-journal-notice' }, list.error),
      h('div', { className: 'world-journal-rows' },
        !rows.length && h('p', { className: 'world-journal-empty', role: 'status' }, !pageReady ? '正在读取…' : trash ? '垃圾箱为空' : query ? '没有匹配的日记。' : '还没有日记，助手完成工作后会在这里留下记录。'),
        ...rows.map(item => h('div', { key: item.id, className: `world-journal-rowwrap${item.pinned ? ' is-pinned' : ''}` },
          h('button', { type: 'button', disabled: busy, className: `world-journal-row${selected === item.id ? ' is-selected' : ''}`,
            'data-world-journal-entry': item.id, 'aria-pressed': selected === item.id,
            onClick: () => { setSelected(item.id); setReload(value => value + 1); setError(''); setNotice('') } },
          h('strong', null, item.pinned ? '★ ' : '', client.draft(item.id)?.title || item.title || '未命名日记'),
          h('span', null, item.local || client.draft(item.id)?.dirty ? '未保存草稿'
            : `${item.auto ? '自动 · ' : ''}${item.updatedBy === 'assistant' ? '助手' : '手工'} · ${date(trash ? item.deletedAt : item.updatedAt)}`)),
          !trash && !item.local && h('button', {
            type: 'button', className: 'world-journal-pin', 'aria-label': item.pinned ? '取消置顶' : '置顶',
            'aria-pressed': Boolean(item.pinned), title: item.pinned ? '取消置顶' : '置顶（唤醒时优先带回）',
            disabled: busy || (selected === item.id && Boolean(draft?.dirty)),
            onClick: () => void togglePin(item),
          }, item.pinned ? '★' : '☆'))),
        (offset > 0 || list.hasMore) && h('div', { className: 'world-journal-pagination world-journal-buttons' },
          h('button', { type: 'button', disabled: busy || !pageReady || offset === 0, onClick: () => { setSelected(null); setOffset(value => Math.max(0, value - 100)) } }, '上一页'),
          h('button', { type: 'button', disabled: busy || !pageReady || !list.hasMore, onClick: () => { setSelected(null); setOffset(value => value + 100) } }, '下一页')))),
    h('section', { className: 'world-journal-detail', 'aria-label': trash ? '垃圾箱日记详情' : '日记编辑', inert: confirm ? '' : undefined },
      h('div', { className: 'world-journal-toolbar world-journal-buttons' },
        !trash && h('button', { type: 'button', disabled: busy || !selectedDraft?.dirty || moved, onClick: save }, busy ? '处理中…' : '保存日记'),
        !trash && current && h('button', { type: 'button', disabled: busy || moved || (draft.revision > 0 && draft.dirty), onClick: remove }, draft.revision === 0 ? '放弃草稿' : '移入垃圾箱'),
        !trash && (selectedEntry || selectedDraft?.revision > 0 || selectedRow) && h('button', { type: 'button', disabled: busy, onClick: refreshEntry }, '重新读取'),
        trash && selectedEntry && h('button', { type: 'button', disabled: busy, onClick: () => run(async () => {
          await client.change('restore', { id: entry.id, expectedRevision: entry.revision }); if (alive.current) { setSelected(null); setEntry(null); setNotice('已恢复到日记') }
        }) }, '恢复日记'),
        trash && selectedEntry && h('button', { type: 'button', disabled: busy, onClick: () => ask(`永久删除“${entry.title}”？删除后无法恢复。`, '永久删除', () => run(async () => {
          await client.change('purge', { id: entry.id, expectedRevision: entry.revision, confirmed: true })
          if (alive.current) { setSelected(null); setEntry(null); setNotice('已永久删除') }
        })) }, '永久删除')),
      (error || notice || stale || moved) && h('p', { className: 'world-journal-notice', role: error || stale ? 'alert' : 'status' }, error || (stale ? '这条日记已在其他位置修改；你的草稿已保留，请重新读取后再保存。' : moved ? '这条日记已移入垃圾箱，请先恢复。' : notice)),
      !current ? h('p', { className: 'world-journal-empty' }, trash ? '选择一条日记查看、恢复或永久删除。' : '新建日记，或从左侧选择一条记录。')
        : trash ? h(React.Fragment, null, h('strong', { className: 'world-journal-heading' }, entry.title),
          h('span', { className: 'world-journal-meta' }, `移入时间：${date(entry.deletedAt)}`), h('pre', { className: 'world-journal-bodytext' }, entry.body))
          : h(React.Fragment, null,
            h('input', { 'aria-label': '日记标题', maxLength: 160, placeholder: '日记标题', value: draft.title, disabled: busy || moved, onChange: event => updateDraft({ title: event.target.value }) }),
            h('span', { className: 'world-journal-meta' }, draft.dirty ? '未保存的修改' : entry ? `已保存 · ${date(entry.updatedAt)}` : '新日记'),
            h('textarea', { 'aria-label': '日记正文', maxLength: 100000, placeholder: '记录完成的工作、结果和下一步。', value: draft.body, disabled: busy || moved, onChange: event => updateDraft({ body: event.target.value }) }))),
    confirm && h(Confirm, { ...confirm, busy, onCancel: () => { if (!busy) setConfirm(null) }, onConfirm: async () => { const action = confirm.action; setConfirm(null); await action() } }))
}
