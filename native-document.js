import React from 'react'
import { errorMessage } from './vscode-error-details.js'

const h = React.createElement
export const DOCUMENT_SLOT = 'world.vscode.document'
const SOURCE_SLOT = 'sidebar.right.pane.tab'
const SOURCE_KEY = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'
const FORMATS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])

class NativePreviewBoundary extends React.Component {
  state = { error: '' }
  static getDerivedStateFromError(error) { return { error: error.message || String(error) } }
  render() {
    return this.state.error ? h('p', { role: 'alert' }, errorMessage(`文档预览失败：${this.state.error}`)) : this.props.children
  }
}

export const isDocumentPreviewPath = path => FORMATS.has(String(path).split(/[\\/]/u).at(-1)?.split('.').at(-1)?.toLowerCase())

export function documentAddress(sessionId, path) {
  const encode = value => encodeURIComponent(value).replace(/%3A/giu, ':')
  return `dsh-resource://file/session/${encode(sessionId)}/${String(path).replace(/\\/gu, '/').split('/').map(encode).join('/')}`
}

/** Mirror the native preview tree with new child names; all components, stores and faces remain native. */
export function mirrorNativeDocuments(slots) {
  const entries = name => slots.entriesOfSlot ? slots.entriesOfSlot(name) : slots.entries(name)
  const mirror = (source, target, root = false) => {
    const held = new Map()
    let stopped = false
    const release = value => {
      for (const stop of value.children) stop()
      value.dispose()
    }
    const sync = () => {
      if (stopped) return
      const live = entries(source).filter(entry => !root || entry.options.key === SOURCE_KEY)
      for (const [entry, value] of held) if (!live.includes(entry)) { held.delete(entry); release(value) }
      for (const entry of live) {
        if (held.has(entry)) continue
        const names = new Map(Object.keys(entry.children || {}).map(name => [name, `${DOCUMENT_SLOT}.child.${name}`]))
        const children = Object.fromEntries([...names].map(([name, renamed]) => [renamed, entry.children[name]]))
        function NativeBody(props) {
          const renderSlot = (name, owner, options) => props.renderSlot(names.get(name) || name, owner, options)
          return h(NativePreviewBoundary, null, h(entry.component, { ...props, renderSlot }))
        }
        const options = { ...entry.options, name: target }
        if (root) options.key = SOURCE_KEY
        if (entry.store) options.store = entry.store
        if (entry.inject) options.inject = entry.inject
        if (entry.locale) options.locale = entry.locale
        if (names.size) options.children = children
        const dispose = slots.register(options, NativeBody)
        const value = { dispose, children: [] }
        held.set(entry, value)
        for (const [name, renamed] of names) value.children.push(mirror(name, renamed))
      }
    }
    const unsubscribe = slots.subscribe(source, sync)
    sync()
    return () => {
      stopped = true; unsubscribe?.()
      for (const value of held.values()) release(value)
      held.clear()
    }
  }
  return mirror(SOURCE_SLOT, DOCUMENT_SLOT, true)
}

let sequence = 0

/** A native preview occurrence retained by a world editor tab, including while that tab is hidden. */
export function NativeDocument({ path, sessionId, sessions, SessionProvider, renderSlot, visible, onOpen, onClose }) {
  const [connection, setConnection] = React.useState(null)
  const [identity] = React.useState(() => {
    const controller = new AbortController()
    const held = { id: `world-document-${++sequence}`, controller, commands: {} }
    held.bindCommands = commands => {
      if (controller.signal.aborted) return () => {}
      held.commands = commands
      const release = () => {
        if (held.commands === commands) held.commands = {}
        controller.signal.removeEventListener('abort', release)
      }
      controller.signal.addEventListener('abort', release, { once: true })
      return release
    }
    return held
  })
  const address = documentAddress(sessionId, path)
  React.useEffect(() => {
    const controller = new AbortController()
    let reference
    try {
      reference = sessions.retain(sessionId, { source: 'worldDocumentPreview', signal: controller.signal })
      Promise.resolve(reference.ready).then(() => {
        if (!controller.signal.aborted) setConnection({ reference })
      }, error => { if (!controller.signal.aborted) setConnection({ error: error.message || String(error) }) })
    } catch (error) { setConnection({ error: error.message || String(error) }) }
    return () => { controller.abort(); reference?.release() }
  }, [sessions, sessionId])
  React.useEffect(() => () => identity.controller.abort(), [identity])
  const useTabInfo = React.useCallback(() => ({
    sidebar: { expanded: true, fullscreen: false }, panel: { id: identity.id, isFloating: false },
    tab: {
      id: identity.id, kind: 'text', contentId: address, title: path.split(/[\\/]/u).at(-1), visible,
      signal: identity.controller.signal, navigation: { address, params: undefined, revision: 0 },
      actions: {
        bindCommands: identity.bindCommands,
        close: onClose,
        openResource: target => {
          const prefix = documentAddress(sessionId, '')
          if (!target.startsWith(prefix)) throw new Error('预览导航目标不属于当前会话。')
          onOpen(target.slice(prefix.length).split('/').map(decodeURIComponent).join('/'))
        },
        openTab: () => { throw new Error('此操作不适用于文档预览标签。') },
      },
    },
  }), [address, identity, path, sessionId, visible, onOpen, onClose])
  const fallback = h('p', { role: 'alert' }, errorMessage('当前 DSH 未提供原生文档预览组件，请更新宿主并启用文档预览插件。'))
  if (connection?.error) return h('p', { role: 'alert' }, errorMessage(`无法打开文档预览：${connection.error}`))
  if (!connection) return h('div', { className: 'world-vscode-loading', role: 'status' }, `正在打开 ${path.split(/[\\/]/u).at(-1)}…`)
  return h(SessionProvider, { session: connection.reference },
    renderSlot(DOCUMENT_SLOT, {}, { entryKey: SOURCE_KEY, hookContext: useTabInfo, fallback }))
}
