import React from 'react'
const h = React.createElement

// 记录卡先说人话：她刚才在做什么，比原始工具名有用。
const VERBS = {
  read: '读取', write: '写入', edit: '修改', apply_patch: '应用补丁',
  grep: '搜索', glob: '查找文件', pwsh: '运行命令', bash: '运行命令', run_code: '运行代码',
  world_diary: '翻日记', world_tasks: '看待办', world_memory: '回想', world_self: '整理自述',
}
const baseNameOf = value => String(value || '').split(/[\\/]/u).filter(Boolean).at(-1) || ''
const firstLine = text => String(text || '').split('\n')[0].trim().slice(0, 40)
const clock = time => {
  const date = new Date(time)
  if (!Number.isFinite(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}

/** 标题 + 右侧元信息都只描述已经发生的事实：工具、目标、时间、耗时、成败。 */
export function toolHeadline(row, shell = row.appId === 'terminal') {
  const verb = VERBS[row.tool]
  if (shell) return verb || '运行命令'
  if (row.tool === 'grep') return ['搜索', firstLine(row.input)].filter(Boolean).join(' ')
  const name = row.path ? baseNameOf(row.path) : ''
  if (verb && name) return `${verb} ${name}`
  return verb || row.tool
}
function meta(row, pending) {
  const time = clock(row.receivedAt)
  const cost = row.done && row.doneAt > row.receivedAt ? `${((row.doneAt - row.receivedAt) / 1000).toFixed(1)}s` : ''
  // 「还有 N 个」让她忙多久有数，而不是一个永远转着的“执行中”。
  const rest = pending > 0 ? `还有 ${pending} 个` : ''
  return [time, cost, row.done ? (row.failed ? '失败' : '') : '执行中…', rest].filter(Boolean).join(' · ')
}

/** Lives inside the actual application's window, including docked plugin windows. */
export function AppToolHistory({ appId, rows, playing, pending = 0, animation, onPlayingHeading }) {
  const [chosen, choose] = React.useState(null)
  const view = React.useRef(null)
  React.useLayoutEffect(() => { if (playing) view.current?.querySelector('summary')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [playing])
  const row = playing || rows.find(r => r.id === chosen) || rows.at(-1)
  if (!row) return null
  const shell = appId === 'terminal'
  const behind = Boolean(chosen) && chosen !== rows.at(-1)?.id
  return h('details', { ref: view, className: 'world-app-tool-history', key: shell ? row.id : playing?.id || 'history', open: shell || playing ? true : undefined,
    'data-world-app-receipt':row.id, 'data-world-tool-done':String(row.done), 'data-animation': playing ? animation : undefined,
    'data-world-tool-failed': row.done && row.failed ? 'true' : undefined },
    h('summary', { ref: playing ? onPlayingHeading : null },
      h('span', { className: 'world-app-tool-name' }, toolHeadline(row, shell)),
      h('span', { className: 'world-app-tool-meta' }, meta(row, playing ? pending : 0))),
    !playing && rows.length > 1 && h('div', { className: 'world-app-tool-picker' },
      h('span', { className: 'world-app-tool-picker-note' }, `共 ${rows.length} 条`),
      h('select', { 'aria-label':'查看调用记录', value:row.id,onChange:e=>choose(e.target.value) },
        ...rows.map(r=>h('option',{key:r.id,value:r.id},`${toolHeadline(r, shell)} · ${clock(r.receivedAt)}`))),
      // 选了旧记录就不再跟着新结果跳；给一个明确出口回到底部。
      behind && h('button', { type:'button', className: 'world-app-tool-latest', onClick: () => choose(null) }, '回到最新')),
    h('pre', null, (shell ? '> ' : '') + row.input),
    h('pre', { 'data-world-tool-output': true }, row.done ? (row.failed ? '失败：' : '') + (row.output || '（无输出）') : '执行中…'))
}
