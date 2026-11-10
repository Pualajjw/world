import React from 'react'

const h = React.createElement
const date = value => new Date(value).toLocaleString('zh-CN', { hour12: false })
const STATUS_LABELS = { pending: '待处理', doing: '进行中', blocked: '阻塞', done: '已完成' }
const STATUS_ORDER = ['doing', 'pending', 'blocked', 'done']
const FILTERS = [
  { value: 'active', label: '未完成' },
  { value: 'doing', label: '进行中' },
  { value: 'pending', label: '待处理' },
  { value: 'blocked', label: '阻塞' },
  { value: 'done', label: '已完成' },
  { value: 'all', label: '全部' },
]
const payloadOf = filter => filter === 'active' ? {} : filter === 'all' ? { all: true } : { status: filter }

export function TasksGlyph({ size = 48 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M4 5.5h2.4l1.1 1.1M4 12h2.4l1.1 1.1M4 18.5h2.4l1.1 1.1M10 5.5h10M10 12h10M10 18.5h10' }))
}
export const TASK_APPS = [
  { key: 'world-tasks', label: '待办', icon: TasksGlyph, description: '还没做什么 · 与助手共用' },
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

const blankDraft = () => ({ id: null, title: '', note: '', next: '', status: 'pending', revision: 0, updatedAt: Date.now(), createdAt: Date.now() })
const sameDraft = (draft, item) => item && draft.title === item.title && draft.note === item.note
  && draft.next === item.next && draft.status === item.status

/** Shared open-work list: the diary records what happened, this records what is still open. */
export function TasksPage({ rpc, visible = true, onDirtyChange }) {
  const [filter, setFilter] = React.useState('active')
  const [list, setList] = React.useState({ revision: -1, items: [], total: 0, counts: null, error: '' })
  const [draft, setDraft] = React.useState(null)
  const [remote, setRemote] = React.useState(null)
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [notice, setNotice] = React.useState('')
  const [confirm, setConfirm] = React.useState(null)
  const alive = React.useRef(true)
  React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const request = React.useCallback(async (operation, payload = {}) => {
    const result = await rpc.call('/api', `world-tasks/${operation}`, payload)
    if (!result?.ok) throw Object.assign(new Error(result?.error?.message || '待办请求失败，请刷新确认后再重试。'), { code: result?.error?.code || 'WORLD_TASKS_ACTION' })
    return result.value
  }, [rpc])

  const refresh = React.useCallback(async (nextFilter = filter) => {
    const value = await request('list', payloadOf(nextFilter))
    if (!alive.current) return value
    setList(current => value.revision >= current.revision ? { ...value, error: '' } : current)
    return value
  }, [filter, request])

  React.useEffect(() => {
    if (!visible) return
    const update = () => { void refresh(filter).catch(error => { if (alive.current) setList(current => ({ ...current, error: error.message })) }) }
    update()
    const timer = setInterval(update, 2000)
    window.addEventListener('focus', update)
    return () => { clearInterval(timer); window.removeEventListener('focus', update) }
  }, [refresh, filter, visible])

  React.useEffect(() => {
    if (filter === 'done' && list.revision >= 0 && (list.counts?.done ?? 0) === 0) setFilter('active')
  }, [filter, list.revision, list.counts])

  // Keep the open item in sync with remote edits unless the user has unsaved changes.
  React.useEffect(() => {
    if (!draft?.id) return
    const item = list.items.find(row => row.id === draft.id)
    if (!item || (remote && remote.revision === item.revision)) return
    setRemote(item)
    if (!sameDraft(draft, remote)) return
    setDraft({ ...item })
  }, [list.revision, list.items])

  const dirty = draft ? (!draft.id ? Boolean(draft.title.trim() || draft.note || draft.next || draft.status !== 'pending') : !sameDraft(draft, remote)) : false
  const stale = Boolean(draft?.id && dirty && remote && draft.revision !== remote.revision)
  React.useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false) }, [dirty, onDirtyChange])

  const run = async body => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await body() }
    catch (error) { if (alive.current) setError(error.message || String(error)) }
    finally { if (alive.current) setBusy(false) }
  }
  const choose = id => {
    const item = list.items.find(row => row.id === id)
    if (!item) return
    const select = () => { setRemote(item); setDraft({ ...item }); setError(''); setNotice('') }
    if (dirty) setConfirm({ message: '放弃这条待办尚未保存的修改？', confirmLabel: '放弃修改', action: select })
    else select()
  }
  const create = () => {
    const open = () => { setRemote(null); setDraft(blankDraft()); setError(''); setNotice('') }
    if (dirty) setConfirm({ message: '放弃这条待办尚未保存的修改并新建？', confirmLabel: '放弃并新建', action: open })
    else open()
  }
  const update = patch => setDraft(value => value ? { ...value, ...patch } : value)
  const save = () => run(async () => {
    if (!draft.title.trim()) throw new Error('请填写待办标题。')
    const saved = await request('write', { id: draft.id ?? undefined, expectedRevision: draft.revision,
      title: draft.title, note: draft.note, next: draft.next, status: draft.status })
    setRemote(saved); setDraft({ ...saved }); setNotice('已保存')
    await refresh(filter)
  })
  const setStatus = status => {
    if (draft) update({ status })
  }
  const remove = () => {
    if (!draft?.id) {
      const discard = () => { setDraft(null); setRemote(null) }
      if (dirty) setConfirm({ message: '放弃这条尚未保存的待办？', confirmLabel: '放弃草稿', action: discard })
      else discard()
      return
    }
    const expectedRevision = remote?.revision ?? draft.revision
    setConfirm({ message: `删除待办“${draft.title}”？删除后无法恢复。`, confirmLabel: '删除待办', action: () => run(async () => {
      await request('remove', { id: draft.id, expectedRevision, confirmed: true })
      setDraft(null); setRemote(null); setNotice('已删除')
      await refresh(filter)
    }) })
  }
  const clearDone = () => setConfirm({ message: `清理 ${list.counts?.done ?? 0} 条已完成待办？此操作无法恢复。`, confirmLabel: '清理已完成', action: () => run(async () => {
    await request('clearDone', { confirmed: true, expectedRevision: list.revision })
    if (draft?.status === 'done') { setDraft(null); setRemote(null) }
    setNotice('已清理完成项')
    await refresh(filter)
  }) })

  const counts = list.counts || { active: 0, done: 0 }
  return h('div', { className: 'world-journal world-tasks', 'data-world-tasks-view': filter },
    h('aside', { className: 'world-journal-list', 'aria-label': '待办列表', inert: confirm ? '' : undefined },
      h('div', { className: 'world-journal-toolbar world-journal-buttons' },
        h('strong', null, `待办 · ${counts.active}`),
        h('button', { type: 'button', disabled: busy, onClick: create }, '新建待办')),
      h('div', { className: 'world-task-filters world-journal-buttons', role: 'tablist', 'aria-label': '筛选待办' },
        ...FILTERS.filter(item => item.value !== 'done' && item.value !== 'all' || counts.done > 0).map(item => h('button', {
          key: item.value, type: 'button', role: 'tab', 'aria-selected': filter === item.value,
          className: `world-task-filter${filter === item.value ? ' is-on' : ''}`,
          onClick: () => setFilter(item.value),
        }, item.label))),
      list.error && h('p', { role: 'alert', className: 'world-journal-notice' }, list.error),
      h('div', { className: 'world-journal-rows' },
        !list.items.length && h('p', { className: 'world-journal-empty', role: 'status' }, list.revision < 0 ? '正在读取…' : '这里没有待办。'),
        ...list.items.map(item => h('button', {
          key: item.id, type: 'button', disabled: busy,
          className: `world-journal-row world-task-row${draft?.id === item.id ? ' is-selected' : ''}`,
          'data-world-task': item.id, 'aria-pressed': draft?.id === item.id,
          onClick: () => choose(item.id),
        },
        h('strong', null, h('i', { className: `world-task-dot is-${item.status}`, 'aria-hidden': true }), item.title),
        h('span', null, [STATUS_LABELS[item.status], item.next && `下一步：${item.next}`]
          .filter(Boolean).join(' · ') + ` · ${date(item.updatedAt)}`))))),
    h('section', { className: 'world-journal-detail', 'aria-label': '待办详情', inert: confirm ? '' : undefined },
      h('div', { className: 'world-journal-toolbar world-journal-buttons' },
        draft && h('button', { type: 'button', disabled: busy || !dirty || stale, onClick: save }, busy ? '处理中…' : '保存'),
        draft && h('button', { type: 'button', disabled: busy || (draft.id ? stale : false), onClick: remove }, draft.id ? '删除' : '放弃草稿'),
        counts.done > 0 && h('button', { type: 'button', disabled: busy, onClick: clearDone }, `清理已完成 (${counts.done})`)),
      (error || notice || stale) && h('p', { className: 'world-journal-notice', role: error || stale ? 'alert' : 'status' },
        error || (stale ? '这条待办已在其他位置修改；你的修改已保留，请重新选择后再保存。' : notice)),
      !draft
        ? h('p', { className: 'world-journal-empty' }, '新建待办，或从左侧选择一条。助手也会在这里留下下一步。')
        : h(React.Fragment, null,
          h('input', { 'aria-label': '待办标题', maxLength: 200, placeholder: '要做什么', value: draft.title, disabled: busy,
            onChange: event => update({ title: event.target.value }) }),
          h('div', { className: 'world-task-statuses world-journal-buttons', role: 'group', 'aria-label': '状态' },
            ...STATUS_ORDER.map(status => h('button', {
              key: status, type: 'button', disabled: busy, 'aria-pressed': draft.status === status,
              className: `world-task-status is-${status}${draft.status === status ? ' is-on' : ''}`,
              onClick: () => setStatus(status),
            }, h('i', { className: `world-task-dot is-${status}`, 'aria-hidden': true }), STATUS_LABELS[status]))),
          h('input', { 'aria-label': '下一步', maxLength: 500, placeholder: '下一步（可选）', value: draft.next, disabled: busy,
            onChange: event => update({ next: event.target.value }) }),
          h('textarea', { 'aria-label': '备注', maxLength: 4000, placeholder: '备注（可选）', value: draft.note, disabled: busy,
            onChange: event => update({ note: event.target.value }) }),
          h('span', { className: 'world-journal-meta' },
            draft.id ? `${dirty ? '未保存的修改' : `已保存 · ${date(draft.updatedAt)}`} · 由${draft.updatedBy === 'assistant' ? '助手' : '你'}更新` : '新待办')) ),
    confirm && h(Confirm, { ...confirm, busy, onCancel: () => { if (!busy) setConfirm(null) },
      onConfirm: async () => { const action = confirm.action; setConfirm(null); await action() } }))
}
