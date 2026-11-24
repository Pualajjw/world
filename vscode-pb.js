import React from 'react'
import { errorMessage } from './vscode-error-details.js'
import { worldConfirm } from './world-confirm.js'

const h = React.createElement
const types = new Map(Object.entries({ sra: '应用程序', srw: '窗口', srm: '菜单', srf: '全局函数', sru: '用户对象', srd: '数据窗口', srs: '结构', srq: '查询', srp: '数据管道' }))
export const groupOf = name => types.get(name.split('.').at(-1)?.toLowerCase()) || '其他'
export const groupKey = (lib, group) => `${lib}\0pb:${group}` // cannot collide with a filesystem path
export function pbGroups(entries) {
  const groups = new Map([...types.values(), '其他'].map(name => [name, []]))
  for (const entry of entries) groups.get(groupOf(entry.name)).push(entry)
  return [...groups].filter(([, items]) => items.length) // listing already sorted by name
}

/** Window-local, lazy filename index. Coalesce cold lookups; never retain source text. */
export function projectObjects(load) {
  let index, pending, controller, objectNote
  const result = word => ({ matches: index.get(word) || [], objectNote })
  return {
    find(word) {
      if (index) return result(word)
      if (!pending) {
        controller = new AbortController()
        const { signal } = controller
        pending = load(signal).then(({ libraries, skipped }) => {
          signal.throwIfAborted()
          const map = new Map()
          for (const [library, names] of libraries) for (const entry of names) {
            // Ordinary PBL/older overlays give source names; a compiled index also
            // carries the actual binary name (including .win vs .wnd). Open only the SR path.
            const [source, binary] = Array.isArray(entry) ? entry : [entry]
            const path = `${library}/${source}`, keys = new Set()
            for (const name of binary ? [source, binary] : [source]) {
              const lower = name.toLowerCase()
              keys.add(lower); keys.add(lower.slice(0, lower.lastIndexOf('.')))
            }
            for (const key of keys) {
              if (!map.has(key)) map.set(key, [])
              map.get(key).push(path)
            }
          }
          index = map
          objectNote = skipped.length ? `未能读取 ${skipped.join('、')}，可刷新资源管理器后重试。` : ''
        }).finally(() => { if (!signal.aborted) pending = null })
      }
      return pending.then(() => result(word))
    },
    clear() { controller?.abort(); index = pending = null },
  }
}

/** Poll only the job belonging to this session and project; switching roots never transfers a result. */
export function usePbJob({ rpc, project, sessionId, dirty, show }) {
  const scope = project && sessionId ? JSON.stringify([sessionId, project.root]) : ''
  const [state, setState] = React.useState(null)
  const [refresh, setRefresh] = React.useState(0)
  const guard = React.useRef(null), current = React.useRef(scope), counter = React.useRef(0)
  current.current = scope
  React.useLayoutEffect(() => {
    current.current = scope
    return () => { current.current = '' }
  }, [scope])
  const call = React.useCallback(async (op, options = {}, signal) => {
    const response = await rpc.call('/api', `world-vscode-pb/${op}`, { ...options, root: project.root, sessionId }, signal)
    if (!response?.ok) throw new Error(response?.error?.message || 'PB 工程操作失败。')
    return response.value
  }, [rpc, project?.root, sessionId])
  React.useEffect(() => {
    if (!scope) return
    const controller = new AbortController(); let timer
    const poll = async () => {
      const seq = counter.current
      try {
        const value = await call('status', {}, controller.signal)
        if (seq !== counter.current || current.current !== scope || controller.signal.aborted) return
        setState({ scope, value })
        if (value?.running) timer = setTimeout(poll, 800)
      } catch (error) {
        if (!controller.signal.aborted && seq === counter.current) setState({ scope, value: { error: error.message } })
      }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [scope, call, refresh])
  const value = state?.scope === scope ? state.value : null
  const start = async (op, options) => {
    if (!scope || value?.running || guard.current?.scope === scope) return
    const token = { scope }; guard.current = token
    show()
    try {
      if (dirty && !await worldConfirm({ title: '工程有未保存的修改', message: '草稿不会参与本次操作。继续使用已保存的库吗？', confirmLabel: '使用已保存版本' })) return
      if (current.current !== scope) return
      ++counter.current
      setState({ scope, value: { action: op, running: true } })
      const job = await call(op, options)
      if (current.current === scope) { setState({ scope, value: job }); setRefresh(n => n + 1) }
    } catch (error) {
      if (current.current === scope) setState({ scope, value: { error: error.message } })
    } finally { if (guard.current === token) guard.current = null }
  }
  return { value, start }
}

export function PbRunPanel({ project, job }) {
  const name = project.name.replace(/\.(pbt|exe)$/i, '')
  const [directory, setDirectory] = React.useState(`${project.root.replace(/\\/g, '/')}/${name}-build`)
  const [mode, setMode] = React.useState('embedded'), [icon, setIcon] = React.useState(''), [pbr, setPbr] = React.useState('')
  const field = (label, value, update) => h('label', null, label, h('input', { value, onChange: e => update(e.target.value), spellCheck: false }))
  const { value } = job
  return h('section', { className: 'world-vscode-pb-panel', 'aria-label': 'PB 工程运行' },
    h('strong', { title: project.pbtPath }, project.name), h('small', null, `PB${project.pbVersion || '?'} · ${project.kind === 'exe' ? '已编译程序' : '使用已保存的 PBL'}`),
    h('button', { type: 'button', disabled: value?.running, onClick: () => job.start('run') }, '运行项目 (F5)'),
    project.kind === 'exe' ? h(React.Fragment, null, h('button', { type: 'button', disabled: true }, '打包 EXE'), h('small', null, '当前是二进制工程。请先还原为 PBT/PBL，再打包新 EXE。'))
      : h('details', null, h('summary', null, '打包 EXE'), h('form', { onSubmit: e => { e.preventDefault(); void job.start('build', { directory, mode, icon, pbr }) } },
        field('新输出目录', directory, setDirectory), h('small', null, `生成 ${name}.exe，不覆盖已有目录。`),
        h('label', null, '库的打包方式', h('select', { value: mode, onChange: e => setMode(e.target.value) }, h('option', { value: 'embedded' }, '嵌入 EXE'), h('option', { value: 'external' }, '生成外置 PBD'))),
        field('图标 .ico（可选）', icon, setIcon), field('资源 .pbr（可选）', pbr, setPbr),
        h('button', { type: 'submit', disabled: !directory.trim() || value?.running }, '开始打包'))),
    value && h('div', { role: value.error ? 'alert' : 'status' }, value.error ? errorMessage(value.error) : (value.running ? (value.action === 'build' ? '正在打包…' : '程序运行中…') : value.action === 'build' ? `已生成：${value.output}` : '程序已退出。')))
}
