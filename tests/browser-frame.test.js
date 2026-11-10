import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BROWSER_WORKSPACE, MAX_ADDRESS_LENGTH, MAX_TABS, createGuestAttributes, createLeasePool,
  createTabStore, describeBrowserFailure, hostLabel, parseBrowserAddress, resolveBrowserBridge,
} from '../browser-frame.js'

test('parseBrowserAddress: 补 https、保留 http、返回规范化 URL', () => {
  assert.deepEqual(parseBrowserAddress('example.com'), {
    ok: true, target: { url: 'https://example.com/', title: 'example.com' },
  })
  assert.deepEqual(parseBrowserAddress(' http://127.0.0.1:8080/a?b=1 '), {
    ok: true, target: { url: 'http://127.0.0.1:8080/a?b=1', title: '127.0.0.1' },
  })
  assert.equal(parseBrowserAddress('example.com:8080').ok, true)
})

test('parseBrowserAddress: 白名单拒绝协议 / 凭据 / 空 / 超长 / 宿主 origin', () => {
  assert.equal(parseBrowserAddress('').reason, 'empty')
  assert.equal(parseBrowserAddress('   ').reason, 'empty')
  assert.equal(parseBrowserAddress('https://example.com/' + 'x'.repeat(MAX_ADDRESS_LENGTH)).reason, 'invalid')
  for (const value of ['file:///C:/a.txt', 'javascript:alert(1)', 'data:text/html,x', 'chrome://settings']) {
    assert.equal(parseBrowserAddress(value).reason, 'protocol', value)
  }
  assert.equal(parseBrowserAddress('https://user:pass@example.com/').reason, 'credentials')
  assert.equal(parseBrowserAddress('https://user@example.com/').reason, 'credentials')
  assert.equal(parseBrowserAddress('http://localhost:3000/', 'http://localhost:3000').reason, 'application-origin')
  assert.equal(parseBrowserAddress('http://localhost:3000/', 'null').ok, true)
  assert.equal(parseBrowserAddress('https://example.com/', 'not a url').ok, true)
  assert.match(describeBrowserFailure('credentials'), /用户名/)
})

test('hostLabel 不抛异常，也不读取页面内容', () => {
  assert.equal(hostLabel('https://example.com/a'), 'example.com')
  assert.equal(hostLabel(''), '网页')
})

test('createGuestAttributes 精确对齐主进程 will-attach-webview 校验', () => {
  assert.deepEqual(createGuestAttributes({ lease: 'lease-1', partition: 'persist:p1' }), {
    src: 'about:blank#lease-1',
    partition: 'persist:p1',
    name: 'lease-1',
    allowpopups: '',
    'data-sidebar-browser-frame': 'webview',
  })
  for (const bad of [null, {}, { lease: '', partition: 'p' }, { lease: 1, partition: 'p' }, { lease: 'l' }]) {
    assert.throws(() => createGuestAttributes(bad), /invalid browser reservation/)
  }
})

test('resolveBrowserBridge 只在 protocolVersion === 1 且三件套齐全时放行', () => {
  assert.equal(resolveBrowserBridge({}), null)
  assert.equal(resolveBrowserBridge({ dshDesktop: { protocolVersion: 0, browser: {} } }), null)
  const bridge = { acquire() {}, release() {}, onOpenRequested() {} }
  assert.equal(resolveBrowserBridge({ dshDesktop: { protocolVersion: 1, browser: bridge } }), bridge)
  const partial = { acquire() {}, release() {} }
  assert.equal(resolveBrowserBridge({ dshDesktop: { protocolVersion: 1, browser: partial } }), null)
})

test('createTabStore: 触顶返回 null、关最后一个自动补空白页、快照不可变', () => {
  const store = createTabStore()
  assert.equal(store.getSnapshot().tabs.length, 0)
  const emptySnapshot = store.getSnapshot()
  const first = store.addTab()
  assert.equal(first.url, '')
  assert.equal(first.title, '新标签页')
  assert.equal(store.getSnapshot().activeId, first.id)

  for (let i = 1; i < MAX_TABS; i += 1) assert.ok(store.addTab({ url: `https://e${i}.com/` }))
  assert.equal(store.getSnapshot().tabs.length, MAX_TABS)
  assert.equal(store.addTab(), null, '第 9 个标签必须被拒绝')
  assert.equal(store.getSnapshot().tabs.length, MAX_TABS)
  assert.equal(emptySnapshot.tabs.length, 0, '旧快照不能被后续修改污染')
  assert.equal(store.getSnapshot().version > emptySnapshot.version, true)

  const updated = store.update(first.id, { loading: true, title: '已更新' })
  assert.equal(updated.loading, true)
  assert.equal(store.getSnapshot().tabs.find(tab => tab.id === first.id).title, '已更新')
  assert.equal(store.update('missing', { loading: true }), null)
  assert.equal(store.activate(first.id), true)
  assert.equal(store.activate(first.id), false)
})

test('createTabStore: 关非最后一个标签时把前台交给相邻标签', () => {
  const store = createTabStore({ maxTabs: 3 })
  const a = store.addTab()
  const b = store.addTab()
  const c = store.addTab()
  assert.equal(store.getSnapshot().activeId, c.id)
  let { removed, replacement } = store.closeTab(c.id)
  assert.equal(removed.id, c.id)
  assert.equal(replacement, null)
  assert.equal(store.getSnapshot().activeId, b.id)
  ;({ removed, replacement } = store.closeTab(a.id))
  assert.equal(removed.id, a.id)
  assert.equal(store.getSnapshot().activeId, b.id)
  ;({ removed, replacement } = store.closeTab(b.id))
  assert.equal(removed.id, b.id)
  assert.ok(replacement, '关最后一个标签要自动补一个空白页')
  assert.equal(replacement.url, '')
  assert.equal(store.getSnapshot().tabs.length, 1)
  assert.equal(store.getSnapshot().activeId, replacement.id)
})

test('createTabStore: subscribe 可退订', () => {
  const store = createTabStore()
  let calls = 0
  const off = store.subscribe(() => { calls += 1 })
  store.addTab()
  assert.equal(calls, 1)
  off()
  store.addTab()
  assert.equal(calls, 1)
})

function fakeBridge() {
  let serial = 0
  const released = []
  const openListeners = new Map()
  return {
    released,
    openListeners,
    async acquire(workspace) {
      assert.equal(workspace, BROWSER_WORKSPACE)
      serial += 1
      return { lease: `lease-${serial}`, partition: `persist:p${serial}` }
    },
    async release(lease) { released.push(lease) },
    onOpenRequested(lease, listener) {
      openListeners.set(lease, listener)
      return () => openListeners.delete(lease)
    },
  }
}

test('createLeasePool: 每个 lease 恰好 release 一次，重复释放被吞掉', async () => {
  const bridge = fakeBridge()
  const pool = createLeasePool({ bridge })
  const a = await pool.acquire()
  const b = await pool.acquire()
  assert.equal(pool.size, 2)
  assert.equal(await pool.release(a.lease), true)
  assert.equal(await pool.release(a.lease), false)
  assert.deepEqual(bridge.released, ['lease-1'])
  await pool.dispose()
  assert.deepEqual(bridge.released, ['lease-1', 'lease-2'])
  assert.equal(pool.size, 0)
  await pool.dispose()
  assert.equal(bridge.released.length, 2, '重复 dispose 不再释放')
})

test('createLeasePool: watchOpen 随 lease 一起注销', async () => {
  const bridge = fakeBridge()
  const pool = createLeasePool({ bridge })
  const reservation = await pool.acquire()
  let calls = 0
  const off = pool.watchOpen(reservation.lease, () => { calls += 1 })
  assert.equal(bridge.openListeners.size, 1)
  bridge.openListeners.get(reservation.lease)('https://example.com/')
  assert.equal(calls, 1)
  await pool.release(reservation.lease)
  assert.equal(bridge.openListeners.size, 0)
  off()
  assert.equal(calls, 1)
  await pool.dispose()
})

test('createLeasePool: acquire 失败不泄漏；dispose 期间完成的 acquire 会立刻归还', async () => {
  const errors = []
  const failing = createLeasePool({ bridge: { async acquire() { throw new Error('nope') }, async release() {} },
    onError: error => errors.push(error.message) })
  await assert.rejects(failing.acquire(), /nope/)
  assert.equal(failing.size, 0)

  const bridge = fakeBridge()
  let resolveAcquire
  bridge.acquire = () => new Promise(resolve => { resolveAcquire = resolve })
  const pool = createLeasePool({ bridge })
  const pending = pool.acquire()
  const disposing = pool.dispose()
  resolveAcquire({ lease: 'late', partition: 'persist:late' })
  await assert.rejects(pending, /disposed/)
  await disposing
  assert.deepEqual(bridge.released, ['late'], '迟到的租约必须归还')
  assert.equal(pool.size, 0)
})

test('createLeasePool: 无桥时不 acquire，release 的异常只记录不抛出', async () => {
  const errors = []
  const bridge = {
    async acquire() { return { lease: 'l1', partition: 'p1' } },
    async release() { throw new Error('release failed') },
    onOpenRequested() { return () => {} },
  }
  const pool = createLeasePool({ bridge, onError: error => errors.push(error.message) })
  const reservation = await pool.acquire()
  assert.equal(await pool.release(reservation.lease), true)
  assert.deepEqual(errors, ['release failed'])
  assert.equal(createLeasePool({}).size, 0)
  await assert.rejects(createLeasePool({}).acquire(), /unavailable/)
})
