import React from 'react'
import { DEFAULT_WALLPAPER, WALLPAPER_PRESETS } from './wallpaper.js'

const h = React.createElement

const PERCENT = value => `${Math.round(value * 100)}%`

/** 桌面右键打开的壁纸面板：普通 / 3D 两个页签，3D 默认跟随普通桌面。 */
export function WallpaperPanel({ value, mode, onChange, onClose }) {
  const [tab, setTab] = React.useState(mode)
  const card = React.useRef(null)
  const titleId = React.useId()
  const closeRef = React.useRef(onClose)
  closeRef.current = onClose

  React.useEffect(() => {
    const previous = document.activeElement
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  React.useEffect(() => {
    const onKeyDown = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
  React.useEffect(() => {
    card.current?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [])

  const linked = value.linked
  // 跟随时两个页签改的是同一份配置，界面不假装有两份数据。
  const target = tab === 'depth' && !linked ? 'depth' : 'flat'
  const config = value[target]
  const update = patch => onChange({ ...value, [target]: { ...config, ...patch } })
  const unlink = () => onChange({ ...value, linked: false, depth: { ...value.flat } })
  const relink = () => onChange({ ...value, linked: true, depth: { ...value.flat } })
  const reset = () => onChange({
    linked: DEFAULT_WALLPAPER.linked,
    flat: { ...DEFAULT_WALLPAPER.flat },
    depth: { ...DEFAULT_WALLPAPER.depth },
  })

  const slider = (id, label, key, min, max, step) => h('label', { key, className: 'world-wallpaper-slider', htmlFor: id },
    h('span', null, label),
    h('input', {
      id, type: 'range', min, max, step, value: config[key],
      onChange: event => update({ [key]: Number(event.target.value) }),
    }),
    h('b', null, PERCENT(config[key])))

  return h('div', {
    className: 'world-wallpaper-panel',
    onPointerDown: event => { if (event.currentTarget === event.target) onClose() },
  }, h('div', {
    className: 'world-wallpaper-card', ref: card, role: 'dialog', 'aria-modal': true,
    'aria-labelledby': titleId,
  },
  h('div', { className: 'world-wallpaper-head' },
    h('strong', { id: titleId }, '桌面背景'),
    h('button', { type: 'button', className: 'world-wallpaper-close', 'aria-label': '关闭', onClick: onClose }, '×')),
  h('div', { className: 'world-wallpaper-tabs', role: 'tablist', 'aria-label': '桌面模式' },
    h('button', {
      type: 'button', role: 'tab', 'aria-selected': tab === 'flat',
      className: `world-wallpaper-tab${tab === 'flat' ? ' on' : ''}`, onClick: () => setTab('flat'),
    }, '普通桌面'),
    h('button', {
      type: 'button', role: 'tab', 'aria-selected': tab === 'depth',
      className: `world-wallpaper-tab${tab === 'depth' ? ' on' : ''}`, onClick: () => setTab('depth'),
    }, '3D 桌面')),
  h('div', { className: 'world-wallpaper-body' },
    tab === 'depth' && h('p', { className: 'world-wallpaper-note' },
      h('span', null, linked ? '当前跟随普通桌面，修改会同时生效。' : '3D 桌面使用独立设置。'),
      linked
        ? h('button', { type: 'button', onClick: unlink }, '单独设置')
        : h('button', { type: 'button', onClick: relink }, '恢复跟随')),
    h('div', { className: 'world-wallpaper-section' },
      h('span', null, '壁纸'),
      h('div', { className: 'world-wallpaper-presets' },
        WALLPAPER_PRESETS.map(preset => h('button', {
          key: preset.id, type: 'button', 'data-world-wallpaper-option': preset.id,
          className: `world-wallpaper-preset${config.preset === preset.id ? ' on' : ''}`,
          'aria-pressed': config.preset === preset.id,
          onClick: () => update({ preset: preset.id }),
        },
        h('i', {
          className: 'world-wallpaper-swatch',
          style: { background: preset.swatch || config.color },
          'aria-hidden': true,
        }),
        h('span', null, preset.label)))),
      config.preset === 'solid' && h('div', { className: 'world-wallpaper-solid' },
        h('input', {
          type: 'color', value: config.color, 'aria-label': '壁纸纯色',
          onChange: event => update({ color: event.target.value }),
        }),
        h('code', null, config.color.toUpperCase()))),
    h('div', { className: 'world-wallpaper-section' },
      h('span', null, '效果'),
      slider('world-wallpaper-dim', '遮罩', 'dim', 0, .6, .05),
      slider('world-wallpaper-bloom', '光晕', 'bloom', 0, 1, .05),
      tab === 'depth' && slider('world-wallpaper-grid', '3D 地面', 'grid', 0, 1, .05))),
  h('div', { className: 'world-wallpaper-foot' },
    h('button', { type: 'button', onClick: reset }, '恢复默认'),
    h('span', { className: 'spacer' }),
    h('button', { type: 'button', className: 'is-primary', onClick: onClose }, '完成'))))
}
