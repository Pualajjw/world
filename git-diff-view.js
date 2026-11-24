import React from 'react'
import { errorMessage } from './vscode-error-details.js'
import { parseGitDiff } from './git-diff.js'

const h = React.createElement
export function GitDiffView({ tab, limit, busy, dirty, onHunk, onStageFile, onDiscard, onRefresh }) {
  const parsed = React.useMemo(() => parseGitDiff(tab.patch), [tab.patch])
  const scroll = React.useRef(null)
  const [selected, setSelected] = React.useState(0)
  // Expansion belongs to these exact bytes; a refreshed diff starts at the normal limit.
  const [expansion, setExpansion] = React.useState(null)
  const visibleLimit = expansion?.patch === tab.patch && expansion?.id === tab.id ? expansion.limit : limit
  const shown = parsed.rows.slice(0, visibleLimit), count = shown.filter(row => row.kind === 'hunk').length
  const next = parsed.rows[shown.length]
  const clippedHunk = next && next.kind !== 'hunk' ? next.hunk : -1
  const current = Math.min(selected, Math.max(0, count - 1))
  const loading = busy || tab.loading
  const scope = tab.commit ? `提交 ${tab.commit.slice(0, 7)}` : tab.staged ? '已暂存' : tab.untracked ? '未跟踪' : '工作区'
  const name = tab.path.split('/').at(-1)
  const jump = direction => {
    if (!count || !scroll.current) return
    const index = (current + direction + count) % count
    const node = scroll.current.querySelectorAll('[data-git-hunk]')[index]
    if (node) scroll.current.scrollTop += node.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top
    setSelected(index)
  }
  React.useEffect(() => { setSelected(0) }, [tab.snapshot, tab.commit, tab.path])
  if (tab.loading && !tab.patch) return h('div', { className: 'world-vscode-loading', role: 'status' },
    h('i', { className: 'world-vscode-loading-spin' }), `正在读取 ${name} 的 Diff…`)
  return h('div', { className: 'world-vscode-diff', role: 'region', 'aria-busy': Boolean(loading),
    'aria-label': `${name} 的 Diff（${scope}）`, onKeyDown: event => {
      if (event.key !== 'F7') return
      event.preventDefault(); event.stopPropagation(); jump(event.shiftKey ? -1 : 1)
    } },
    h('div', { className: 'world-vscode-diff-head' },
      h('span', { className: 'world-vscode-diff-title', title: tab.path }, name),
      h('span', { className: 'world-vscode-diff-scope' }, scope),
      h('span', { className: 'world-vscode-diff-stat' },
        h('i', { className: 'is-add' }, `+${parsed.rows.filter(row => row.kind === 'add').length}`), ' ',
        h('i', { className: 'is-del' }, `−${parsed.rows.filter(row => row.kind === 'del').length}`)),
      h('span', { className: 'world-vscode-diff-stat world-vscode-diff-count' }, count ? `${current + 1}/${count} 块` : '0 块'),
      tab.from ? h('span', { className: 'world-vscode-diff-path', title: `${tab.from} → ${tab.path}` }, `${tab.from} → ${tab.path}`) : null,
      tab.truncated ? h('span', { className: 'world-vscode-diff-note' }, '补丁过长，已截断') : null),
    h('div', { className: 'world-vscode-git-actions' },
      h('button', { type: 'button', disabled: !count, onClick: () => jump(-1), title: '上一处更改 (Shift+F7)' }, '上一块'),
      h('button', { type: 'button', disabled: !count, onClick: () => jump(1), title: '下一处更改 (F7)' }, '下一块'),
      onStageFile ? h('button', { type: 'button', disabled: Boolean(loading || dirty || tab.error), onClick: onStageFile }, tab.staged ? '取消暂存' : '暂存文件') : null,
      onDiscard ? h('button', { type: 'button', disabled: Boolean(loading), onClick: onDiscard }, '放弃更改') : null,
      h('button', { type: 'button', disabled: Boolean(loading), onClick: onRefresh }, tab.loading ? '读取中…' : '刷新 Diff')),
    tab.error ? h('div', { className: 'world-vscode-diff-message is-error', role: 'alert' }, h('strong', null, 'Diff 读取失败'), errorMessage(tab.error)) : null,
    dirty ? h('div', { className: 'world-vscode-git-note', role: 'status' }, '此处对比磁盘上已保存的内容；文件有未保存草稿，请先保存再暂存。') : null,
    !tab.commit && !tab.loading && !tab.canStageHunks && parsed.hunks.length
      ? h('div', { className: 'world-vscode-git-note' }, '此差异需使用整文件操作（新增、删除、重命名、模式变化或非 UTF-8 内容）。') : null,
    !tab.error && !parsed.rows.length ? h('div', { className: 'world-vscode-diff-message' }, h('strong', null, '没有可显示的差异'),
      h('small', null, tab.commit ? '此提交中没有可显示的文本变化。' : '索引 / 工作区里这份文件没有文本变化。')) : null,
    !tab.error && parsed.rows.length ? h('div', { className: 'world-vscode-diff-scroll', ref: scroll },
      h('div', { className: 'world-vscode-diff-rows' }, shown.map((row, index) => h('div', {
        key: index, className: `world-vscode-diff-line is-${row.kind}`, 'data-git-hunk': row.kind === 'hunk' ? row.hunk : undefined,
      },
      h('span', { className: 'world-vscode-diff-num' }, row.old ?? ''),
      h('span', { className: 'world-vscode-diff-num' }, row.new ?? ''),
      h('span', { className: 'world-vscode-diff-sign' }, row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ''),
      h('span', { className: 'world-vscode-diff-text' },
        row.kind === 'hunk' && tab.canStageHunks && !tab.commit ? h('button', {
          type: 'button', className: 'world-vscode-diff-hunk-button', disabled: Boolean(loading || dirty || row.hunk === clippedHunk),
          title: row.hunk === clippedHunk ? '请先展开并查看此块的全部内容' : undefined,
          'aria-label': `${tab.staged ? '取消暂存' : '暂存'}第 ${row.hunk + 1} 块`,
          onClick: () => onHunk(row.hunk),
        }, tab.staged ? '− 取消暂存此块' : '+ 暂存此块') : null,
        row.text || '\u200b')))),
      parsed.rows.length > shown.length ? h('div', { className: 'world-vscode-diff-more' }, `已显示 ${shown.length}/${parsed.rows.length} 行。`,
        h('button', { type: 'button', onClick: () => setExpansion({ id: tab.id, patch: tab.patch, limit: shown.length + limit }) }, '展开更多差异')) : null) : null)
}
