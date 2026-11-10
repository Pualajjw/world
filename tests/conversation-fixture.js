import React from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'

const h = React.createElement

/** Native-slot stand-in with the real single-editor constraint; no Host agents are started. */
export function createConversationFixture({ entries, mainSessionId, subscribeMain, subscribeSlots }) {
  const Scope = React.createContext(null)
  const data = new Map(), retained = new Map(), sent = [], conflicts = []
  let nextError = ''
  const session = id => {
    if (!data.has(id)) data.set(id, { snapshot: { messages: [], draft: '', running: false }, listeners: new Set(), editor: null })
    return data.get(id)
  }
  const publish = (id, patch) => {
    const state = session(id)
    state.snapshot = { ...state.snapshot, ...patch }
    for (const listener of state.listeners) listener()
  }
  const useSnapshot = id => {
    const state = session(id)
    return React.useSyncExternalStore(listener => { state.listeners.add(listener); return () => state.listeners.delete(listener) }, () => state.snapshot)
  }
  const reference = id => ({ sessionId: id, ready: Promise.resolve(), release() { retained.set(id, (retained.get(id) || 0) - 1) } })
  const retain = (id, { signal }) => {
    retained.set(id, (retained.get(id) || 0) + 1)
    const ref = reference(id)
    if (nextError) { ref.ready = Promise.reject(new Error(nextError)); nextError = '' }
    let released = false
    return { ...ref, release() { if (released) return; released = true; ref.release() }, signal }
  }
  function SessionProvider({ session: ref, children }) { return h(Scope.Provider, { value: ref.sessionId }, children) }
  function Chat() {
    const id = React.useContext(Scope)
    const state = useSnapshot(id)
    return h('div', { 'data-fixture-chat': id, style: { color: 'var(--dsw-alias-label-primary, inherit)' } }, ...state.messages.map(message =>
      h('p', { key: message.id, 'data-fixture-message': message.id }, `${message.role}: ${message.text}`)))
  }
  function Composer() {
    const id = React.useContext(Scope), state = useSnapshot(id), ref = React.useRef(null)
    const [popup, setPopup] = React.useState(false)
    React.useLayoutEffect(() => {
      const resident = session(id)
      if (resident.editor) conflicts.push(id)
      resident.editor = ref.current
      return () => { resident.editor = null }
    }, [id])
    const send = () => {
      if (!state.draft.trim()) return
      sent.push({ sessionId: id, text: state.draft })
      publish(id, { draft: '', messages: [...state.messages, { id: `sent-${sent.length}`, role: 'user', text: state.draft }] })
    }
    return h('div', { 'data-fixture-composer': id },
      h('textarea', { ref, 'aria-label': 'DSH 原生输入框夹具', value: state.draft,
        onChange: event => publish(id, { draft: event.target.value }),
        onKeyDown: event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() } } }),
      h('button', { onClick: send }, '发送'),
      h('button', { onClick: () => setPopup(true) }, '模型菜单'),
      popup && createPortal(h('div', { style: { position: 'fixed', top: 160, right: 50 }, 'data-fixture-popup': true },
        h('div', { role: 'menu' }, h('button', { onClick: () => setPopup(false) }, '保留当前模型'))), document.body))
  }
  function Factory({ options, props }) {
    const Views = options?.slots?.views
    return h('div', { 'data-conversation-content': true, 'data-fixture-variant': props.variant,
      style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
    h('div', { 'data-fixture-scroll': true, style: { overflow: 'auto', minHeight: 0, flex: 1 } },
      Views ? h(Views, { renderSlot: name => name === 'conversation.session' ? h(Chat) : null }) : h(Chat),
      h(Composer)))
  }
  const renderFactorySlot = (name, props, options) => name === 'conversation.content' ? h(Factory, { props, options }) : options?.fallback
  const renderSlot = name => {
    const entry = entries.get(name)
    if (!entry) return null
    return h(ScopedEntry, { entry })
  }
  function ScopedEntry({ entry }) {
    const sessionId = React.useContext(Scope)
    return h(entry.component, {
      sessionId, renderFactorySlot,
      useSession: select => select({ blank: false, running: useSnapshot(sessionId).running, openState: 'open' }),
      useConversation: select => select({ activeTargets: new Set() }),
      useSessions: select => select({ byId: { [sessionId]: { blank: false } } }),
    })
  }
  function Main() {
    const id = React.useSyncExternalStore(subscribeMain, mainSessionId)
    const away = React.useSyncExternalStore(subscribeSlots, () => entries.get('main'))
    return away ? h(away.component) : h('div', { 'data-slot': 'main.conversation' },
      h(Scope.Provider, { value: id }, h(Factory, { props: { variant: 'main' } })))
  }
  const mainContainer = document.createElement('div')
  mainContainer.dataset.fixtureNativeMain = 'true'
  document.querySelector('#host-ui')?.append(mainContainer)
  const root = createRoot(mainContainer)
  root.render(h(Main))
  return {
    retain, SessionProvider, renderSlot, sent, conflicts,
    setMessages(id, messages) { publish(id, { messages }) },
    setDraft(id, draft) { publish(id, { draft }) },
    retainCount: id => retained.get(id) || 0,
    snapshot: id => session(id).snapshot,
    failNextOpen(message) { nextError = message },
    dispose() { root.unmount(); mainContainer.remove() },
  }
}
