import React from 'react'

const h = React.createElement

/** 标题栏图钉：未钉住是空心针头，钉住后填实。 */
export function PinGlyph({ size = 12, filled = false }) {
  return h('svg', {
    width: size, height: size, viewBox: '0 0 12 12', 'aria-hidden': true, focusable: 'false',
  },
  h('path', {
    d: 'M4.1 1.4h3.8l-.5 2.7 1.8 2H2.8l1.8-2z',
    fill: filled ? 'currentColor' : 'none', stroke: 'currentColor',
    strokeWidth: 1.1, strokeLinejoin: 'round',
  }),
  h('path', { d: 'M6 6.1v4.6', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' }))
}

export const pinLabel = pinned => pinned ? '取消钉住（不再始终置顶）' : '钉住（始终置顶）'