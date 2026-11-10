import React from 'react'

const h = React.createElement
const EXTENSION_COLORS = {
  js: '#e8c34a', jsx: '#61dafb', ts: '#4f9cf9', tsx: '#61dafb', json: '#d6a44c',
  md: '#7aa2f7', html: '#e06c75', css: '#56b6c2', scss: '#d879b8', less: '#6f9bd1',
  py: '#4b8bbe', go: '#4fb3e8', rs: '#d19a66', c: '#7b9cc4', h: '#7b9cc4', cpp: '#7b9cc4',
  cs: '#9b7bd1', java: '#d1794f', sh: '#89ca78', bat: '#89ca78', ps1: '#6fa8dc',
  png: '#b47ad1', jpg: '#b47ad1', jpeg: '#b47ad1', gif: '#b47ad1', webp: '#b47ad1', svg: '#d6a44c',
  pdf: '#e05252', zip: '#b08968', tgz: '#b08968', pbl: '#4fb3e8', sra: '#4fb3e8', sru: '#4fb3e8',
}
const extensionOf = name => name.includes('.') ? name.split('.').at(-1).toLowerCase() : ''

export function HolderGlyph({ size = 48 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 48 48', fill: 'none', 'aria-hidden': true },
    h('path', { d: 'M5 13.5h13l3.4 4H43v19.5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V13.5z', fill: '#3d6f9e', stroke: '#8ec5f0', strokeWidth: 1.4, strokeLinejoin: 'round' }),
    h('path', { d: 'M5 20h38', stroke: '#8ec5f0', strokeWidth: 1.2, opacity: .7 }),
    h('rect', { x: 11, y: 24, width: 8, height: 8, rx: 2, fill: '#dceaf8' }),
    h('rect', { x: 20.5, y: 24, width: 8, height: 8, rx: 2, fill: '#b7d4ee' }),
    h('rect', { x: 30, y: 24, width: 8, height: 8, rx: 2, fill: '#8ec5f0' }))
}

export function FileLinkGlyph({ name = '', type = 'file', size = 48 }) {
  if (type === 'directory') {
    return h('svg', { width: size, height: size, viewBox: '0 0 48 48', fill: 'none', 'aria-hidden': true },
      h('path', { d: 'M6 14h13l3 3.4h20V36a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V14z', fill: '#d6a44c', stroke: '#f2cd86', strokeWidth: 1.4, strokeLinejoin: 'round' }),
      h('path', { d: 'M6 20h36', stroke: '#8a6a2f', strokeWidth: 1.2, opacity: .55 }))
  }
  const color = EXTENSION_COLORS[extensionOf(name)] || '#9fb4c8'
  return h('svg', { width: size, height: size, viewBox: '0 0 48 48', fill: 'none', 'aria-hidden': true },
    h('path', { d: 'M11 5h18l9 9v29H11z', fill: '#26323e', stroke: '#9fb4c8', strokeWidth: 1.4, strokeLinejoin: 'round' }),
    h('path', { d: 'M29 5v9h9', fill: '#1b232c', stroke: '#9fb4c8', strokeWidth: 1.4, strokeLinejoin: 'round' }),
    h('rect', { x: 16, y: 22, width: 16, height: 3, rx: 1.5, fill: color }),
    h('rect', { x: 16, y: 28, width: 12, height: 3, rx: 1.5, fill: color, opacity: .7 }),
    h('rect', { x: 16, y: 34, width: 14, height: 3, rx: 1.5, fill: color, opacity: .45 }))
}

const KIND_LABELS = { app: '应用', external: '外部应用', file: '文件', directory: '文件夹' }

/** A holder is a virtual folder: opening it lists its items; each item can be opened or moved back out. */
export function HolderPage({ holder, items, onOpen, onRemove, onRename, onOpenInVscode, onDissolve }) {
  const hasFiles = items.some(item => item.kind === 'file' || item.kind === 'directory')
  return h('div', { className: 'world-holder', 'data-world-holder': holder.id },
    h('header', { className: 'world-holder-head' },
      h('div', { className: 'world-holder-title' }, h(HolderGlyph, { size: 30 }),
        h('div', null, h('strong', null, holder.name), h('span', null, `${items.length} 个项目`))),
      h('div', { className: 'world-holder-actions' },
        h('button', { type: 'button', onClick: onRename }, '重命名'),
        h('button', { type: 'button', disabled: !hasFiles, title: hasFiles ? '在 VSCode 中显示收纳盒里的文件' : '收纳盒里还没有文件',
          onClick: onOpenInVscode }, '在 VSCode 中打开'),
        h('button', { type: 'button', onClick: onDissolve }, '解散收纳盒'))),
    items.length
      ? h('div', { className: 'world-holder-grid' }, ...items.map(item => h('div', {
        key: item.id, className: 'world-holder-item', 'data-world-holder-item': item.id,
        onDoubleClick: () => onOpen(item), title: item.kind === 'app' || item.kind === 'external' ? `打开 ${item.label}` : item.label,
      },
      h('button', { type: 'button', className: 'world-holder-open', 'aria-label': `打开 ${item.label}`, onClick: () => onOpen(item) },
        h('span', { className: 'world-holder-glyph' }, h(item.icon)),
        h('span', { className: 'world-holder-label' }, item.label),
        h('span', { className: 'world-holder-kind' }, item.kind === 'file' || item.kind === 'directory' ? item.path : KIND_LABELS[item.kind] || '')),
      h('button', { type: 'button', className: 'world-holder-remove', title: '移出收纳盒（放回桌面）',
        'aria-label': `把 ${item.label} 移出收纳盒`, onClick: () => onRemove(item) }, '移出'))))
      : h('p', { className: 'world-holder-empty' }, '这个收纳盒是空的。右键桌面上的收纳盒可以解散它。'),
    h('p', { className: 'world-holder-hint' }, '把桌面图标拖到另一个图标上即可组成收纳盒；拖进收纳盒的项目仍保留原来的位置记录。'))
}

/** Small modal for renaming a holder without depending on window.prompt. */
export function RenameDialog({ label, value, onCancel, onSave }) {
  const [draft, setDraft] = React.useState(value)
  const ref = React.useRef(null)
  React.useLayoutEffect(() => { ref.current?.focus(); ref.current?.select() }, [])
  const save = () => { const next = draft.trim(); if (next) onSave(next) }
  return h('div', { className: 'world-journal-confirm', onPointerDown: event => event.stopPropagation() },
    h('div', { className: 'world-workbench-setup-card world-journal-confirm-card', role: 'dialog', 'aria-modal': true, 'aria-label': label,
      onKeyDown: event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
        if (event.key === 'Enter') { event.preventDefault(); save() }
      } },
    h('strong', null, label),
    h('input', { ref, 'aria-label': '收纳盒名称', maxLength: 40, value: draft, onChange: event => setDraft(event.target.value),
      style: { width: '100%', height: 32, padding: '0 12px', border: '1px solid #454545', borderRadius: 4, background: '#1e1e1e', color: 'inherit', font: 'inherit' } }),
    h('div', { className: 'world-journal-buttons' },
      h('button', { type: 'button', onClick: onCancel }, '取消'),
      h('button', { type: 'button', disabled: !draft.trim(), onClick: save }, '保存'))))
}
