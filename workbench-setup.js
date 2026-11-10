import React from 'react'
import { DEFAULT_BACKGROUND, DEFAULT_REVIEW_TIME, DEFAULT_WAKE_TIME, WORKBENCH_PRIORITY, EXPRESSION_STYLES, workbenchProfile } from './workbench-profile.js'

const h = React.createElement

/** First handoff asks the user for a persistent background before binding or granting control. */
export function WorkbenchSetup({ sessionId, editing = false, initialProfile, loading = false, loadError = '', onSave, onCancel }) {
  const [background, setBackground] = React.useState(DEFAULT_BACKGROUND)
  const [name, setName] = React.useState('助手')
  const [userName, setUserName] = React.useState('')
  const [tone, setTone] = React.useState('natural')
  const [wakeTime, setWakeTime] = React.useState(DEFAULT_WAKE_TIME)
  const [reviewTime, setReviewTime] = React.useState(DEFAULT_REVIEW_TIME)
  const [life, setLife] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const card = React.useRef(null)
  const inputId = React.useId()
  const titleId = React.useId()
  const savingRef = React.useRef(false)
  const disabled = saving || loading || Boolean(loadError)

  React.useLayoutEffect(() => {
    if (!editing || loading || loadError) return
    const profile = workbenchProfile(initialProfile || DEFAULT_BACKGROUND)
    setBackground(profile.background); setName(profile.name); setUserName(profile.userName); setTone(profile.tone)
    setWakeTime(profile.wakeTime); setReviewTime(profile.reviewTime); setLife(profile.life)
  }, [editing, initialProfile, loading, loadError])

  React.useEffect(() => {
    const previous = document.activeElement
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  React.useEffect(() => {
    card.current?.querySelector('input:not(:disabled),textarea:not(:disabled),button:not(:disabled)')?.focus({ preventScroll: true })
  }, [loading, loadError])
  const cancel = () => { if (!savingRef.current) onCancel() }

  const onKeyDown = event => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); cancel(); return }
    if (event.key !== 'Tab') return
    const items = [...card.current.querySelectorAll('input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled)')]
    const first = items[0], last = items.at(-1)
    if (!first) { event.preventDefault(); return }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  return h('div', {
    className: 'world-workbench-setup',
    onPointerDown: event => { if (event.currentTarget === event.target) cancel() },
  }, h('form', {
    className: 'world-workbench-setup-card', ref: card, role: 'dialog', 'aria-modal': true,
    'aria-labelledby': titleId, onKeyDown,
    onSubmit: async event => {
      event.preventDefault()
      if (savingRef.current || disabled || !background.trim() || (editing && !name.trim())) return
      savingRef.current = true
      setSaving(true)
      setError('')
      try { await onSave(editing ? workbenchProfile({ background, name, userName, tone, wakeTime, reviewTime, life }) : background) }
      catch (cause) { setError(String(cause?.message || cause)) }
      finally { savingRef.current = false; setSaving(false) }
    },
  },
  h('strong', { id: titleId }, editing ? '助手个性化' : '设定你的助手'),
  h('p', null, editing ? '为常驻助手设定名字、称呼和交流习惯。保存后在后续回复中使用。' : 'world 是助手自己的家。可以直接采用默认背景，也可以写下你希望她怎么在这里过日子。'),
  editing && h(React.Fragment, null,
    h('label', { htmlFor: `${inputId}-name` }, '助手名字'),
    h('input', { id: `${inputId}-name`, value: name, maxLength: 16, required: true, disabled,
      onChange: event => { setName(event.target.value); setError('') } }),
    h('label', { htmlFor: `${inputId}-user` }, '如何称呼你'),
    h('input', { id: `${inputId}-user`, value: userName, maxLength: 24, disabled,
      onChange: event => { setUserName(event.target.value); setError('') } }),
    h('label', { htmlFor: `${inputId}-tone` }, '表达风格'),
    h('select', { id: `${inputId}-tone`, value: tone, disabled, onChange: event => setTone(event.target.value) },
      ...EXPRESSION_STYLES.map(style => h('option', { key: style.value, value: style.value }, style.label))),
    h('div', { className: 'world-workbench-setup-times' },
      h('label', { htmlFor: `${inputId}-wake` }, '每天早上', h('input', { id: `${inputId}-wake`, type: 'time', value: wakeTime, disabled,
        onChange: event => { setWakeTime(event.target.value); setError('') } })),
      h('label', { htmlFor: `${inputId}-review` }, '每天回顾', h('input', { id: `${inputId}-review`, type: 'time', value: reviewTime, disabled,
        onChange: event => { setReviewTime(event.target.value); setError('') } }))),
    h('label', { className: 'world-workbench-setup-life' },
      h('input', { type: 'checkbox', checked: life, disabled, onChange: event => setLife(event.target.checked) }),
      '给她自己的时间：只有一个闹钟，由她定；到点她自己醒来，什么都不定就休息到第二天早上')),
  h('label', { htmlFor: inputId }, editing ? '常驻背景' : '助手背景'),
  h('textarea', {
    id: inputId, value: background, maxLength: 4000, disabled, spellCheck: false,
    onChange: event => { setBackground(event.target.value); setError('') },
  }),
  h('p', { className: 'world-workbench-setup-policy' }, WORKBENCH_PRIORITY),
  h('p', null, editing ? '保存设置不更换会话、不交接控制权。你的任务始终优先；她什么时候自己做事，由她自己的闹钟决定。' : sessionId ? '背景保存到固定助手，之后继续使用同一个会话。' : '保存后绑定当前会话为固定助手，之后继续使用同一个会话。'),
  loading && h('p', { role: 'status' }, '正在读取设置…'),
  (error || loadError) && h('p', { role: 'alert' }, error || loadError),
  h('div', { className: 'world-workbench-setup-actions' },
    h('button', { type: 'button', disabled: saving, onClick: cancel }, '取消'),
    h('button', { type: 'submit', className: 'is-primary', disabled: disabled || !background.trim() || (editing && !name.trim()) }, saving ? '正在保存' : editing ? '保存设置' : '保存并交接'))))
}
