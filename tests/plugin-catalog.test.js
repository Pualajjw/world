import assert from 'node:assert/strict'
import test from 'node:test'
import { createPluginCatalog, PLUGIN_SLOT } from '../plugin-catalog.js'

/** A slots registry small enough to reason about: the two seats world reads, plus what it registers. */
function fixture(t, entries = []) {
  const seats = { main: [], 'sidebar.panellist': [] }
  for (const entry of entries) seats[entry.seat || 'main'].push(entry)
  const registered = [], listeners = []
  const ctx = { slots: {
    entriesOfSlot: name => seats[name] || [],
    register(options, component) { registered.push({ options, component }); return () => registered.push({ disposed: options.key }) },
    subscribe(name, listener) { listeners.push({ name, listener }); return () => {} },
  } }
  const catalog = createPluginCatalog(ctx)
  const dispose = catalog.start()
  t.after(() => dispose())
  const resync = () => listeners.filter(item => item.name === 'main').forEach(item => item.listener())
  return { catalog, registered, resync, seats }
}

/** An entry as the slot registry stores it: what world reads sits on the entry, the id/label on its options. */
const main = (key, extra = {}) => ({
  options: { key, ...(extra.options || {}) },
  component: extra.component || (() => null),
  ...(extra.children ? { children: extra.children } : {}),
  ...(extra.store ? { store: extra.store } : {}),
  ...(extra.inject ? { inject: extra.inject } : {}),
  ...(extra.locale ? { locale: extra.locale } : {}),
})
const side = (id, extra = {}) => ({ seat: 'sidebar.panellist', options: { id, label: extra.label ?? id, order: extra.order ?? 0 }, component: () => null })

test('a whole-page plugin is mirrored into the keyed seat world owns', t => {
  const body = () => null
  const { catalog, registered } = fixture(t, [main('schedules', { component: body }), side('schedules', { label: '任务' })])
  assert.deepEqual(catalog.getSnapshot().map(app => [app.key, app.label]), [['schedules', '任务']])
  assert.equal(registered[0].options.name, PLUGIN_SLOT)
  assert.equal(registered[0].options.key, 'schedules')
  assert.equal(registered[0].component, body, 'the panel body itself is registered, not a copy')
})

test('a store seat is carried over: one root instance per handle, so the page keeps its drafts', t => {
  const store = { create: () => ({ actions: {} }) }
  const { catalog, registered } = fixture(t, [main('schedules', { store }), side('schedules')])
  assert.deepEqual(catalog.getSnapshot().map(app => app.key), ['schedules'])
  assert.equal(registered[0].options.store, store, '自动化任务 keeps its store seat inside the world window')
})

test('child slots and stray panels stay out instead of showing a broken page', t => {
  const { catalog } = fixture(t, [
    main('plugins', { children: { 'plugins.tab': { kind: 'list', scope: 'root' } } }),
    side('plugins'),
    main('conversation'),
    side('conversation'),
    main('orphan'),
    main('fine'),
    side('fine'),
  ])
  assert.deepEqual(catalog.getSnapshot().map(app => app.key), ['fine'], 'only the page that can be assembled alone')
})

test('the same definition is mirrored once, and a new store re-mirrors it', t => {
  const store = { create: () => ({ actions: {} }) }
  const { catalog, registered, resync, seats } = fixture(t, [main('schedules', { store }), side('schedules')])
  resync()
  resync()
  assert.equal(registered.filter(item => item.options).length, 1, 'an unchanged panel is not registered twice')

  seats.main[0] = main('schedules', { store: { create: () => ({ actions: {} }) } })
  resync()
  assert.equal(registered.filter(item => item.options).length, 2, 'a replaced store handle means a new panel definition')
  assert.deepEqual(registered.filter(item => item.disposed), [{ disposed: 'schedules' }], 'the previous mirror was released first')
  assert.deepEqual(catalog.getSnapshot().map(app => app.key), ['schedules'])
})
