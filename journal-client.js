/** Shared diary lists and unsaved drafts for the two desktop windows. */
export function createJournalClient(rpc) {
  const empty = () => ({ revision: -1, entries: [], total: 0, hasMore: false, error: '' })
  let state = { active: empty(), trash: empty(), draftVersion: 0 }, disposed = false
  const listeners = new Set(), generations = { active: 0, trash: 0 }, pages = { active: { limit: 100, offset: 0, query: '' }, trash: { limit: 100, offset: 0, query: '' } }
  const inflight = { active: null, trash: null }
  const drafts = new Map()
  const publish = patch => {
    if (disposed) return
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }
  const request = async (operation, payload = {}, signal) => {
    const result = await rpc.call('/api', `world-journal/${operation}`, payload, signal)
    if (!result?.ok) throw Object.assign(new Error(result?.error?.message || '日记请求失败，草稿已保留；请刷新确认后再重试。'), { code: result?.error?.code || 'WORLD_DIARY_ACTION' })
    return result.value
  }
  const clearDraft = function (id, expected) {
    if (arguments.length > 1 && drafts.get(id) !== expected) return false
    if (!drafts.delete(id)) return false
    publish({ draftVersion: state.draftVersion + 1 })
    return true
  }
  const refresh = (trash = false, limit = pages[trash ? 'trash' : 'active'].limit, offset = pages[trash ? 'trash' : 'active'].offset,
    query = pages[trash ? 'trash' : 'active'].query) => {
    if (disposed) return Promise.reject(Object.assign(new Error('日记窗口已关闭。'), { code: 'WORLD_DIARY_CLOSED' }))
    const key = trash ? 'trash' : 'active'
    pages[key] = { limit, offset, query }
    if (inflight[key]?.limit === limit && inflight[key]?.offset === offset && inflight[key]?.query === query) return inflight[key].promise
    const generation = ++generations[key], entry = { limit, offset, query, promise: null }
    entry.promise = (async () => {
      try {
        const result = await request('list', { trash, limit, offset, ...(query ? { query } : {}) })
        if (generation === generations[key] && result.revision >= state[key].revision) publish({ [key]: { ...result, error: '' } })
        return result
      } catch (error) {
        if (generation === generations[key]) publish({ [key]: { ...state[key], error: error.message } })
        throw error
      } finally { if (inflight[key] === entry) inflight[key] = null }
    })()
    inflight[key] = entry
    return entry.promise
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    refresh,
    read: (id, signal) => request('get', { id }, signal),
    async change(operation, payload) {
      const previousDrafts = new Map(drafts)
      const value = await request(operation, payload)
      if (disposed) return value
      if (operation === 'clear') for (const id of value.removedIds || []) clearDraft(id, previousDrafts.get(id))
      if (operation === 'purge') clearDraft(payload.id, previousDrafts.get(payload.id))
      for (const key of ['active', 'trash']) { generations[key]++; inflight[key] = null }
      await Promise.allSettled([refresh(false), refresh(true)])
      return value
    },
    draft: id => drafts.get(id),
    draftList: () => [...drafts.values()],
    setDraft(draft) { drafts.set(draft.id, draft); publish({ draftVersion: state.draftVersion + 1 }) },
    clearDraft,
    hasDirty: () => [...drafts.values()].some(draft => draft.dirty),
    dispose() { disposed = true; listeners.clear() },
  }
}
