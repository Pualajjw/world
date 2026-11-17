// Production SlotRegistry and native preview bundles, with only the Host/session transport replaced.
import React from 'react'
import * as jsx from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSlotRenderer } from '@deepseek-ai/dsh-client-ui-renderer/src/client/scoped-slots.tsx'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import * as stores from '@deepseek-ai/dsh-client-store'
import { apply as resourcesApply } from '@deepseek-ai/dsh-client-resources/client'
import { VscodeWindow } from '../vscode-app.js'
import { DOCUMENT_SLOT, mirrorNativeDocuments } from '../native-document.js'
import stylesheet from '../styles.css'

const h = React.createElement, ctx = new Context()
const definitions = new Map(), modules = new Map()
const base = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'
const deps = { react: React, 'react/jsx-runtime': jsx, 'react-dom': ReactDOM,
  '@deepseek-ai/dsh-client-ui-primitives': primitives, '@deepseek-ai/dsh-client-store': stores }
window.__ModuleLoader__ = { load(definition) { definitions.set(definition.chunk || 'main', definition) } }
function load(chunk = 'main') {
  if (modules.has(chunk)) return modules.get(chunk)
  const require = id => {
    if (!(id in deps)) throw new Error(`Unexpected native dependency: ${id}`)
    return deps[id]
  }
  require.async = name => Promise.resolve(load(name.replace(/^\.\//u, '')))
  const result = definitions.get(chunk).factory(require)
  modules.set(chunk, result)
  return result
}
const constant = value => ({ getSnapshot: () => value, subscribe: () => () => {} })
const calls = [], refs = new Set()
const session = { id: 'documents', cwd: '/workspace' }
const sessions = { retain(id, { signal }) {
  const token = {}; refs.add(token)
  const release = () => refs.delete(token)
  signal?.addEventListener('abort', release, { once: true })
  return { sessionId: id, ready: Promise.resolve(), release }
} }
const binding = { key: session.id, ctx, hooks: {}, keyedHooks: {}, props: { sessionId: session.id } }
const remoteRead = async (method, args) => {
  calls.push({ method, args })
  const result = await window.__worldDocumentRead(method, args)
  if (result.ok && Array.isArray(result.value.data)) result.value.data = new Uint8Array(result.value.data)
  return result
}
const remote = { workspaceFiles: {
  read: (...args) => remoteRead('text', args.slice(0, 3)),
  readBytes: (...args) => remoteRead('bytes', args.slice(0, 3)),
  stat: (...args) => remoteRead('stat', args.slice(0, 2)),
}, officeToPdf: {
  generation: () => Promise.resolve({ ok: true, value: 'fixture-generation' }),
  render: (...args) => remoteRead('office', args.slice(0, 3)),
} }
const rpc = { call: async (_base, method, payload) => {
  calls.push({ method, payload })
  if (method === 'world-vscode-source/list') return { ok: true, value: { path: '/workspace', parent: '',
    entries: ['notes.js', 'a.pdf', 'b.pdf', '报告 #1.doc', '报告.docx', 'budget.xls', 'budget.xlsx', 'slides.ppt', 'slides.pptx', 'broken.pdf'].map(name => ({ name, type: 'file' })) } }
  if (method === 'world-vscode-source/open') return { ok: true, value: { path: payload.path, source: 'const value = 1\n', version: 'v1' } }
  if (method === 'world-vscode-git/status') return { ok: true, value: { repo: false, files: [] } }
  return { ok: false, error: { message: method } }
} }
let root, stopMirror
window.__worldNativeDocuments = {
  calls, references: () => refs.size,
  suspend: () => stopMirror(),
  resume: () => { stopMirror = mirrorNativeDocuments(ctx.slots) },
  async boot() {
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.install(createSlotRenderer())
    ctx.slots.installScope('session', { current: constant(binding), bindingSource: () => constant(binding), renderArea: (_binding, props) => props.children })
    ctx.slots.bindStoreScope(binding)
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale); ctx.slots.installLocale(locale)
    ctx.provide('remote', remote); ctx.provide('remote.workspaceFiles', remote.workspaceFiles); ctx.provide('remote.officeToPdf', remote.officeToPdf)
    ctx.provide('fileDrag', { actions: {} })
    ctx.provide('sidebarRightTabs', { register: () => () => {} })
    ctx.provide('configForms', { developerTools: { enabled: constant(false) } })
    ctx.slots.provideRoot({ props: { useContextMenu: () => ({ getTriggerProps: () => ({}) }) } })
    resourcesApply(ctx)
    ctx.resources.register({ protocol: 'file', open: async function* (address) {
      const path = address.split('/').slice(5).map(decodeURIComponent).join('/')
      yield { ok: true, value: { absolutePath: path, version: 'v1', bytes: 100 } }
    } })
    function Frame({ renderSlot, SessionProvider }) {
      const [active, setActive] = React.useState(true)
      return h(VscodeWindow, { session, sessions, SessionProvider, renderSlot, remote, rpc,
        rect: { x: 10, y: 9.5, w: 80, h: 80 }, windowKey: 'native-documents', rootPath: '/workspace',
        isActive: active, onActivate: () => setActive(true), onDirtyChange() {}, onClose() {}, onMinimize() {},
        onResizeStart: () => () => {}, onDesktopRegister() {}, onDragStart() {}, onDragMove() {}, onDragEnd() {},
      })
    }
    ctx.slots.register({ name: 'root', children: {
      [DOCUMENT_SLOT]: { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: (_standard, reader) => reader } } },
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: (_standard, reader) => reader } } },
      'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
    } }, Frame)
    load().apply(ctx)
    stopMirror = mirrorNativeDocuments(ctx.slots)
    const style = document.createElement('style'); style.textContent = stylesheet; document.head.append(style)
    document.body.dataset.worldTheme = 'light'
    root = createRoot(document.getElementById('root')); root.render(ctx.slots.renderSlot('root', {}))
  },
  async dispose() { root.unmount(); stopMirror(); await ctx.fiber.dispose() },
}
