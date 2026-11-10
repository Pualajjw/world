import React from 'react'

const h = React.createElement
export const ASSISTANT_CONVERSATION_SLOT = 'world.assistant.conversation'
const NATIVE_VIEWS = { views: FixedChatView }
const DIALOG_ROLES = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="tooltip"]'

function FixedChatView({ renderSlot }) {
  return renderSlot('conversation.session', { view: 'chat' })
}

/** Shared native factory, explicitly bound by the enclosing SessionProvider. */
export function AssistantConversationContent({ sessionId, useSession, useConversation, useSessions, renderFactorySlot }) {
  const session = useSession(value => value)
  const conversation = useConversation(value => value)
  const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
  const active = conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
  const blank = !active && !session.promptAttempted
  const settling = blank && session.openState === 'loading' && summaryBlank !== true
  const hero = blank && (session.openState === 'open' || summaryBlank === true)
  return renderFactorySlot('conversation.content', {
    variant: 'embedded', phase: settling ? 'settling' : hero ? 'hero' : 'active', hero,
  }, {
    slots: NATIVE_VIEWS,
    fallback: h('p', { role: 'alert' }, '当前 DSH 无法加载原生对话视图，请接管后检查插件是否已更新。'),
  })
}

/** Shadow only the main Conversation occurrence; leave its registered child slots and Session alive. */
export function suspendMainConversation(slots, ready) {
  let live = true
  const notify = () => { if (live) { observer.disconnect(); ready() } }
  function MainConversationAway() {
    // All old native editor layout cleanups finish before this placeholder's layout effect.
    React.useLayoutEffect(notify, [])
    return h('p', { role: 'status', 'data-world-conversation-away': true }, '对话已交接到助手面板，操作工作台即可接管并恢复此处。')
  }
  const probe = () => {
    // A different global panel may be selected, with no main Conversation to relinquish.
    if (!document.querySelector('#root [data-slot="main.conversation"]')) notify()
  }
  const observer = new MutationObserver(probe)
  observer.observe(document.body, { childList: true, subtree: true })
  let dispose
  try {
    const entries = slots.entries('main').filter(entry => entry.options.key === 'conversation')
    const priority = Math.min(0, ...entries.map(entry => entry.options.priority || 0)) - 1
    dispose = slots.register({ name: 'main', key: 'conversation', priority }, MainConversationAway)
    queueMicrotask(probe)
  } catch (error) { observer.disconnect(); throw error }
  return () => { live = false; observer.disconnect(); dispose() }
}

function ResidentConversation({ sessionId, conversationSeat, children }) {
  const active = React.useSyncExternalStore(conversationSeat.subscribe, conversationSeat.getSnapshot)
  const [error, setError] = React.useState('')
  React.useLayoutEffect(() => {
    try { return conversationSeat.claim(sessionId) }
    catch (error) { setError(String(error?.message || error)) }
  }, [conversationSeat, sessionId])
  if (error) return h('p', { role: 'alert' }, `无法交接对话输入区：${error}`)
  return active === sessionId ? children : null
}

/** Retaining observes the existing fixed brain; releasing never cancels its Host turn. */
export function AssistantConversation({ sessionId, sessions, SessionProvider, renderSlot, conversationSeat }) {
  const [connection, setConnection] = React.useState(null)
  React.useEffect(() => {
    const abort = new AbortController()
    let reference
    setConnection(null)
    try {
      reference = sessions.retain(sessionId, { source: 'worldAssistantPanel', signal: abort.signal })
      Promise.resolve(reference.ready).then(() => {
        if (!abort.signal.aborted) setConnection({ sessionId, reference })
      }, error => {
        if (!abort.signal.aborted) setConnection({ sessionId, error: String(error?.message || error) })
      })
    } catch (error) { setConnection({ sessionId, error: String(error?.message || error) }) }
    return () => { abort.abort(); reference?.release() }
  }, [sessions, sessionId])
  if (!connection || connection.sessionId !== sessionId) return h('p', { role: 'status' }, '正在打开固定助手对话…')
  if (connection.error) return h('p', { role: 'alert' }, `无法打开固定助手对话：${connection.error}`)
  return h(SessionProvider, { session: connection.reference },
    h(ResidentConversation, { sessionId, conversationSeat }, renderSlot(ASSISTANT_CONVERSATION_SLOT, {})))
}

/** Attribute only newly opened native portals to an interaction originating in this panel. */
export function observeConversationPortals(card) {
  const document = card.ownerDocument
  const seen = new WeakSet(document.querySelectorAll(DIALOG_ROLES))
  const owned = new Map()
  let interacting = false
  const activate = () => { interacting = true }
  const outside = event => {
    if (!event.target?.closest?.('[data-world-control-ui]')) interacting = false
  }
  const rectVars = node => {
    const rect = card.getBoundingClientRect()
    for (const [name, value] of Object.entries({ x: rect.x, y: rect.y, w: rect.width, h: rect.height })) {
      const size = name === 'x' || name === 'w' ? innerWidth : innerHeight
      node.style.setProperty(`--world-dialog-${name}`, `${value / (size || 1) * 100}${name === 'x' || name === 'w' ? 'vw' : 'vh'}`)
    }
  }
  const scan = records => {
    const added = new Set()
    for (const record of records) for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue
      if (node.matches(DIALOG_ROLES)) added.add(node)
      for (const dialog of node.querySelectorAll(DIALOG_ROLES)) added.add(dialog)
    }
    for (const dialog of added) {
      if (seen.has(dialog)) continue
      seen.add(dialog)
      if (!interacting || card.contains(dialog)) continue
      let node = dialog
      while (node.parentElement && node.parentElement !== document.body) node = node.parentElement
      if (node.id === 'root' || node.dataset.worldPortal || node.dataset.windowsMenu !== undefined) continue
      owned.set(node, new Map(['data-world-dialog', 'data-world-portal', 'data-world-control-ui', 'data-world-assistant-dialog']
        .map(name => [name, node.getAttribute(name)])))
      node.dataset.worldDialog = 'assistant'
      node.dataset.worldPortal = 'dsh-world'
      node.dataset.worldControlUi = 'true'
      node.dataset.worldAssistantDialog = 'true'
      rectVars(node)
    }
  }
  card.addEventListener('pointerdown', activate, true)
  card.addEventListener('pointerover', activate, true)
  card.addEventListener('focusin', activate, true)
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('pointerover', outside, true)
  const observer = new MutationObserver(scan)
  observer.observe(document.body, { childList: true, subtree: true })
  const resize = new ResizeObserver(() => { for (const node of owned.keys()) rectVars(node) })
  resize.observe(card)
  return () => {
    observer.disconnect(); resize.disconnect()
    card.removeEventListener('pointerdown', activate, true)
    card.removeEventListener('pointerover', activate, true)
    card.removeEventListener('focusin', activate, true)
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('pointerover', outside, true)
    for (const [node, attributes] of owned) {
      for (const [name, value] of attributes) value === null ? node.removeAttribute(name) : node.setAttribute(name, value)
      for (const name of ['x', 'y', 'w', 'h']) node.style.removeProperty(`--world-dialog-${name}`)
    }
  }
}
