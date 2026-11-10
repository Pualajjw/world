/** One editable native Conversation surface; the Session and its draft remain resident. */
export function createConversationSeat({ suspend } = {}) {
  let owner = null, snapshot = null, resume = null
  const listeners = new Set()
  const publish = value => {
    if (snapshot === value) return
    snapshot = value
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    claim(sessionId) {
      const token = {}
      owner = token
      resume?.()
      resume = null
      if (suspend) publish(null)
      try { resume = suspend ? suspend(() => { if (owner === token) publish(sessionId) }) : null }
      catch (error) { owner = null; publish(null); throw error }
      if (!suspend) publish(sessionId)
      return () => {
        if (owner !== token) return
        owner = null
        publish(null)
        resume?.()
        resume = null
      }
    },
    dispose() { owner = null; publish(null); resume?.(); resume = null; listeners.clear() },
  }
}
