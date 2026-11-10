import assert from 'node:assert/strict'
import test from 'node:test'

import { openNativeSettings } from '../native-settings.js'

/** 造一个「defineStore 句柄」形状的注册项：句柄自己不带 actions，实例才有。 */
function handleEntry(open = () => {}) {
  const instance = { actions: { open }, getSnapshot: () => ({ open: false }) }
  return { store: { create: () => instance, actions: instance.actions } }
}

/** 宿主把 store 直接给成实例时的形状。 */
function instanceEntry(open = () => {}) {
  return { store: { actions: { open }, getSnapshot: () => ({ open: false }) } }
}

test('openNativeSettings 通过 sidebar.settings 的 store 实例打开面板', () => {
  let opened = 0
  const slots = { entriesOfSlot: name => (name === 'sidebar.settings' ? [handleEntry(() => { opened += 1 })] : []) }
  assert.equal(openNativeSettings(slots), true)
  assert.equal(opened, 1)
})

test('openNativeSettings 接受已经是实例的 store', () => {
  let opened = 0
  const slots = { entriesOfSlot: () => [instanceEntry(() => { opened += 1 })] }
  assert.equal(openNativeSettings(slots), true)
  assert.equal(opened, 1)
})

test('openNativeSettings 在 store 挂在 options 上时也能打开', () => {
  let opened = 0
  const slots = { entriesOfSlot: () => [{ options: { store: { actions: { open: () => { opened += 1 } } } } }] }
  assert.equal(openNativeSettings(slots), true)
  assert.equal(opened, 1)
})

test('openNativeSettings 对缺失的席位、缺失的服务都返回 false', () => {
  assert.equal(openNativeSettings({ entriesOfSlot: () => [] }), false)
  assert.equal(openNativeSettings({}), false)
  assert.equal(openNativeSettings(undefined), false)
  assert.equal(openNativeSettings({ entriesOfSlot: () => [{}, { store: {} }] }), false)
})

test('openNativeSettings 在 entriesOfSlot 缺席时退回 entries，读不到就如实失败', () => {
  let opened = 0
  const slots = { entries: name => (name === 'sidebar.settings' ? [handleEntry(() => { opened += 1 })] : []) }
  assert.equal(openNativeSettings(slots), true)
  assert.equal(opened, 1)
  assert.equal(openNativeSettings({ entries: () => { throw new Error('registry closed') } }), false)
})

test('openNativeSettings 遇到抛错的 store 不会把异常带出去', () => {
  const slots = {
    entriesOfSlot: () => [
      { store: { create() { throw new Error('detached') } } },
      handleEntry(),
    ],
  }
  assert.equal(openNativeSettings(slots), true)
})

test('openNativeSettings 对抛错的 entriesOfSlot 也保持静默', () => {
  assert.equal(openNativeSettings({ entriesOfSlot() { throw new Error('no registry') } }), false)
})
