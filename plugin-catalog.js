/**
 * Whole-page plugin discovery, kept free of React so it can be reasoned about on its own.
 * Entries that need host child slots cannot be assembled in an independent outlet — a child key can only be
 * declared once — so they are left out instead of showing a broken entry.
 *
 * A store seat is fine and is mirrored with the entry: the framework keeps one root instance per handle, so the
 * panel in a world window shares the drafts it would have inside the DSH window (that is what 自动化任务 needs).
 */

/** Keyed child slot owned by world's shell.overlay entry; hosts mirrored main panels. */
export const PLUGIN_SLOT = 'world.app.page'

function labelOf(entry) {
  const raw = entry?.options?.label
  try { return typeof raw === 'function' ? String(raw()) : String(raw ?? '') }
  catch { return '' }
}

function sameApps(left, right) {
  return left.length === right.length && left.every((app, index) => {
    const next = right[index]
    return app.key === next.key && app.label === next.label && app.order === next.order
      && app.icon === next.icon
  })
}

/**
 * Discover whole-page plugins from the live slot registry and mirror their
 * main entries into a keyed child slot world owns. Nothing in the contributing
 * plugins needs to change. Entries that need host child slots cannot be
 * assembled in an independent outlet — a child key can only be declared once —
 * so they are left out of the catalog entirely instead of showing a broken entry.
 *
 * A store seat is fine and is mirrored with the entry: the framework keeps one
 * root instance per handle, so the panel in a world window shares the drafts it
 * would have inside the DSH window (that is what 自动化任务 needs).
 */
export function createPluginCatalog(ctx) {
  const listeners = new Set()
  let snapshot = []
  let mirrors = new Map()
  let subscriptions = []
  let stopped = false

  const release = mirror => { if (typeof mirror?.dispose === 'function') mirror.dispose() }
  const publish = next => {
    if (sameApps(snapshot, next)) return
    snapshot = next
    for (const listener of listeners) listener()
  }
  const read = name => {
    try {
      return ctx.slots.entriesOfSlot ? ctx.slots.entriesOfSlot(name) : ctx.slots.entries(name)
    } catch { return [] }
  }
  const sync = () => {
    if (stopped) return
    const mains = read('main')
    const sides = read('sidebar.panellist')
    const sideById = new Map(sides.filter(entry => entry?.options?.id).map(entry => [entry.options.id, entry]))
    const candidates = []
    for (const main of mains) {
      const key = main?.options?.key
      if (!key || key === 'conversation') continue
      const side = sideById.get(key)
      if (!side) continue
      if (main.children && Object.keys(main.children).length) continue
      candidates.push({
        key,
        label: labelOf(side) || key,
        order: Number(side.options.order) || 0,
        icon: side.component,
        main,
      })
    }
    candidates.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))

    const wanted = new Set(candidates.map(item => item.key))
    for (const [key, mirror] of mirrors) {
      if (!wanted.has(key)) { release(mirror); mirrors.delete(key) }
    }
    for (const item of candidates) {
      const main = item.main
      const previous = mirrors.get(item.key)
      if (previous && previous.component === main.component && previous.inject === main.inject
        && previous.locale === main.locale && previous.store === main.store) continue
      release(previous)
      try {
        const options = { name: PLUGIN_SLOT, key: item.key }
        if (main.locale) options.locale = main.locale
        if (main.inject) options.inject = main.inject
        // Same handle, same scope ('root' on both seats): the framework serves one instance for it.
        if (main.store) options.store = main.store
        const dispose = ctx.slots.register(options, main.component)
        mirrors.set(item.key, { dispose, component: main.component, inject: main.inject, locale: main.locale, store: main.store })
      } catch (error) {
        mirrors.delete(item.key)
        console.warn(`[world] cannot mirror plugin panel "${item.key}":`, error)
      }
    }
    publish(candidates.filter(item => mirrors.has(item.key)).map(({ main, ...app }) => app))
  }
  const start = () => {
    subscriptions = [
      ctx.slots.subscribe('main', sync),
      ctx.slots.subscribe('sidebar.panellist', sync),
    ]
    sync()
    return () => {
      stopped = true
      for (const unsubscribe of subscriptions) unsubscribe?.()
      subscriptions = []
      for (const mirror of mirrors.values()) release(mirror)
      mirrors.clear()
      publish([])
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    start,
  }
}
