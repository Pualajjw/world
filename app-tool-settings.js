import React from 'react'
import { bindingFor } from './app-bindings.js'
const h = React.createElement, KEY = 'dsh.world.app-tools.v1'
const eventName = 'world-app-tool-settings'
const motions = { highlight: '高亮操作', fade: '窗口淡入', none: '无动画，依次切换' }
const blank = () => ({ animation: 'highlight', bindings: {}, animations: {} })
const motionOptions = () => Object.entries(motions).map(([value, text]) => h('option', { key: value, value }, text))
export function readToolSettings() {
  let saved
  try { saved = JSON.parse(localStorage.getItem(KEY)) } catch {}
  return { bindings: saved?.bindings || {}, animations: saved?.animations || {},
    animation: Object.hasOwn(motions, saved?.animation) ? saved.animation : 'highlight' }
}
export function subscribeToolSettings(fn) {
  const storage = e => { if (e.key === KEY || !e.key) fn() }
  window.addEventListener(eventName, fn); window.addEventListener('storage', storage)
  return () => { window.removeEventListener(eventName, fn); window.removeEventListener('storage', storage) }
}
const label = name => name === 'run_code' ? 'run_code（纯代码结果）' : name

export function ToolSettings({ rpc, installed }) {
  const [prefs, setPrefs] = React.useState(readToolSettings), [names, setNames] = React.useState([])
  const [error, setError] = React.useState(''), [query, setQuery] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [refreshed, setRefreshed] = React.useState('')
  const [revision, refresh] = React.useReducer(i => i + 1, 0)
  React.useEffect(() => subscribeToolSettings(() => setPrefs(readToolSettings())), [])
  React.useEffect(() => {
    const ac = new AbortController(); setError(''); setLoading(true)
    ;(async () => { const r = await rpc.call('/api','world-app-tools/catalog',{}, ac.signal)
      if (!r?.ok) throw new Error(r?.error?.message || '读取 DSH 工具目录失败')
      if (!ac.signal.aborted) {
        setNames(r.value)
        // 刷新有没有生效要看得到：只换列表，用户不知道是没必要刷新还是没刷新。
        const now = new Date()
        setRefreshed(`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`)
      }
    })().catch(e => { if (!ac.signal.aborted) setError(e.message) })
      .finally(() => { if (!ac.signal.aborted) setLoading(false) })
    return () => ac.abort()
  }, [rpc, revision])
  const save = change => {
    try { localStorage.setItem(KEY, JSON.stringify(change(readToolSettings()))); window.dispatchEvent(new Event(eventName)) }
    catch (e) { setError(`设置未保存：${e.message}`) }
  }
  const appName = id => installed.find(app => app.id === id)?.name || id
  // 改过绑定的人多半是回来找那一行：已绑定的排在前面，其余保持字母序。
  const shown = React.useMemo(() => {
    const text = query.trim().toLowerCase()
    const matches = name => !text || name.toLowerCase().includes(text) || appName(bindingFor(name, prefs.bindings)).toLowerCase().includes(text)
    return names.filter(matches).sort((a, b) => (bindingFor(a, prefs.bindings) ? 0 : 1) - (bindingFor(b, prefs.bindings) ? 0 : 1) || a.localeCompare(b))
  }, [names, query, prefs.bindings, installed])
  const custom = name => Object.hasOwn(prefs.bindings, name) || Object.hasOwn(prefs.animations, name)
  return h('section', { className: 'world-tool-settings' }, h('h3', null, '助手使用电脑'),
    h('p', null, '每个工具只交给一个已安装应用。未绑定或应用未安装时，助手不能调用它。改动立即生效，只保存在这个浏览器里。'),
    h('div', { className: 'world-tool-settings-bar' },
      h('input', { type: 'search', value: query, placeholder: '搜索工具或应用', 'aria-label': '搜索工具',
        onChange: e => setQuery(e.target.value) }),
      h('span', { className: 'world-tool-settings-count' },
        [`共 ${names.length} 个`, refreshed && `已刷新 ${refreshed}`].filter(Boolean).join(' · ')),
      h('button', { type: 'button', onClick: refresh, disabled: loading, 'aria-busy': loading ? 'true' : undefined },
        loading ? '正在读取…' : '刷新 DSH 工具目录')),
    h('label', { className: 'world-tool-settings-default' }, '切换到应用的动画 ',
      h('select', { value: prefs.animation, onChange: e => save(s => ({ ...s, animation: e.target.value })) },
        ...motionOptions())),
    error && h('p', { role:'alert' }, error),
    !loading && !error && names.length === 0 && h('div', { className: 'world-tool-settings-empty' },
      h('p', null, '没有读到任何工具。确认 DSH 和插件已经加载，然后重试。'),
      h('button', { type: 'button', onClick: refresh }, '重试')),
    shown.length === 0 && names.length > 0 && h('p', null, '没有匹配的工具。'),
    shown.length > 0 && h('div', { className: 'world-tool-binding is-head', 'aria-hidden': true },
      h('span', null, '工具'), h('span', null, '所属应用'), h('span', null, '前台动画'), h('span', null, '')),
    ...shown.map(name => {
      const owner = bindingFor(name, prefs.bindings), missing = owner && !installed.some(a => a.id === owner)
      return h('div', { key: name, className: 'world-tool-binding', 'data-world-tool-binding': name },
        h('span', { className: 'world-tool-name' }, label(name), missing && h('em', null, '应用未安装')),
        h('select', { 'aria-label': `${name} 所属应用`, value: owner,
          onChange: e => save(s => ({ ...s, bindings: { ...s.bindings, [name]: e.target.value } })) },
          h('option', { value: '' }, '不绑定'),
          missing && h('option', { value: owner, disabled: true }, `${owner}（未安装）`),
          ...installed.map(a => h('option', { key: a.id, value: a.id }, a.name))),
        h('select', { 'aria-label': `${name} 前台动画`, disabled: !owner, value: prefs.animations[name] || '',
          onChange: e => save(s => ({ ...s, animations: { ...s.animations, [name]: e.target.value } })) },
          h('option', { value: '' }, '跟随默认动画'), ...motionOptions()),
        custom(name) ? h('button', { type: 'button', className: 'world-tool-reset', 'aria-label': `${name} 恢复默认`,
          title: '这一行恢复默认', onClick: () => save(s => {
            const bindings = { ...s.bindings }, animations = { ...s.animations }
            delete bindings[name]; delete animations[name]
            return { ...s, bindings, animations }
          }) }, '恢复') : h('span', null))
    }),
    h('p', { className: 'world-tool-settings-foot' },
      h('button', { type: 'button', onClick: () => save(blank) }, '全部恢复默认')))
}
