import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_WALLPAPER, parseWallpaper, wallpaperFor, wallpaperStyle, wallpaperTone,
} from '../wallpaper.js'

test('missing or broken storage falls back to the default aurora wallpaper', () => {
  for (const value of [null, undefined, '', '{not json', [], 42]) {
    const parsed = parseWallpaper(value)
    assert.deepEqual(parsed, {
      linked: true,
      flat: { ...DEFAULT_WALLPAPER.flat },
      depth: { ...DEFAULT_WALLPAPER.flat },
    })
  }
})

test('unknown presets, colors and out-of-range sliders are sanitized', () => {
  const parsed = parseWallpaper({
    linked: true,
    flat: { preset: 'neon', color: 'red', dim: 9, bloom: -3, grid: 'x' },
  })
  assert.deepEqual(parsed.flat, { preset: 'aurora', color: '#eef3fc', dim: .6, bloom: 0, grid: 1 })
  assert.deepEqual(parsed.depth, parsed.flat)
})

test('unlinked 3D desktop keeps its own config, linked mirrors the flat one', () => {
  const unlinked = parseWallpaper({
    linked: false,
    flat: { preset: 'ocean', dim: .1 },
    depth: { preset: 'dusk', color: '#102030', dim: .2, bloom: .5, grid: .3 },
  })
  assert.equal(unlinked.linked, false)
  assert.equal(unlinked.flat.preset, 'ocean')
  assert.deepEqual(unlinked.depth, { preset: 'dusk', color: '#102030', dim: .2, bloom: .5, grid: .3 })
  assert.equal(wallpaperFor(unlinked, false), unlinked.flat)
  assert.equal(wallpaperFor(unlinked, true), unlinked.depth)

  const linked = parseWallpaper({ linked: true, flat: { preset: 'forest' }, depth: { preset: 'rose' } })
  assert.equal(wallpaperFor(linked, true).preset, 'forest')
})

test('solid wallpapers report their tone so icon labels stay readable', () => {
  assert.equal(wallpaperTone({ preset: 'aurora', color: '#000000' }), '')
  assert.equal(wallpaperTone({ preset: 'solid', color: '#f6f7fb' }), 'light')
  assert.equal(wallpaperTone({ preset: 'solid', color: '#0b1220' }), 'dark')
})

test('wallpaper style exposes tint, solid color and slider variables', () => {
  assert.deepEqual(wallpaperStyle({ preset: 'ocean', color: '#eef3fc', dim: .12, bloom: .8, grid: .55 }), {
    '--wall-dim': '12%',
    '--wall-bloom': '0.8',
    '--wall-grid': '0.55',
    '--wall-tint': '#2f7dd1',
  })
  assert.deepEqual(wallpaperStyle({ preset: 'solid', color: '#102030', dim: 0, bloom: 1, grid: 1 }), {
    '--wall-dim': '0%',
    '--wall-bloom': '1',
    '--wall-grid': '1',
    '--wall-solid': '#102030',
  })
})
