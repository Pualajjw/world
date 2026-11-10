import React from 'react'
import { captureDesktopScreenshot } from '../desktop-shot.js'
import { createRoot } from 'react-dom/client'
import { apply } from '../client-src.js'
import { createConversationFixture } from './conversation-fixture.js'

const effects = []
let overlay
const slotEntries = new Map()
const slotListeners = new Set()
const pluginFixtures = new Map()
let conversationFixture
const source = 'const value = 1\n'
const BIG_TEXT = Array.from({ length: 50000 }, (_, index) => `line ${index} ${'x'.repeat(20)}`).join('\n')
const calls = []
const savedFiles = new Map([['/workspace/src/main.js', source]])
let mainSessionId = 'session-1'
const mainSessionListeners = new Set()
const sessions = {
  list: {
    getSnapshot: () => ({ byId: { [mainSessionId]: { id: mainSessionId, cwd: '/workspace', retainedBy: { mainView: 1 } } } }),
    subscribe: listener => { mainSessionListeners.add(listener); return () => mainSessionListeners.delete(listener) },
  },
}
const remote = { workspaceFiles: { async list(sessionId, path) {
  return { ok: true, value: { entries: path.endsWith('/src') ? [
    { name: 'main.js', type: 'file', size: 17 },
    { name: 'big.txt', type: 'file', size: BIG_TEXT.length },
  ] : [
    { name: 'src', type: 'directory' }, { name: 'README.md', type: 'file', size: 20 },
  ], truncated: false } }
} } }
const rpc = { async call(_base, method, payload) {
  calls.push({ method, payload })
  if (method.startsWith('world-journal/') && window.__worldJournalCall) return window.__worldJournalCall(method.slice('world-journal/'.length), payload)
  if (method.startsWith('world-tasks/') && window.__worldTasksCall) return window.__worldTasksCall(method.slice('world-tasks/'.length), payload)
  if (method.startsWith('workflow-studio/') && window.__worldWorkflowCall) return window.__worldWorkflowCall(method.slice('workflow-studio/'.length), payload)
  if (method.startsWith('world-desktop-brain/') && window.__worldBrainCall) {
    try { return { ok: true, value: await window.__worldBrainCall(method.slice('world-desktop-brain/'.length), payload) } }
    catch (error) { return { ok: false, error: { message: error.message, code: error.code } } }
  }
  if (method.startsWith('world-workbench/') && window.__worldWorkbenchCall) {
    try { return { ok: true, value: await window.__worldWorkbenchCall(method.slice('world-workbench/'.length), payload) } }
    catch (error) { return { ok: false, error: { message: error.message, code: error.code } } }
  }
  if (method.startsWith('world-desktop/') && window.__worldDesktopCall) {
    try { return { ok: true, value: await window.__worldDesktopCall(method.slice('world-desktop/'.length), payload) } }
    catch (error) { return { ok: false, error: { message: error.message } } }
  }
  if (method === 'world-lan-chat/port') return { ok: true, value: { port: 53317 } }
  if (method === 'world-vscode-source/probe') {
    const path = String(payload.path || '')
    const name = path.split('/').filter(Boolean).at(-1) || path
    const directory = !/\.[^/.]+$/u.test(name)
    return { ok: true, value: { path, type: directory ? 'directory' : 'file', name } }
  }
  if (method === 'world-vscode-source/open') {
    // 大文件故意慢一点：加载态需要能被子测试看到
    if (payload.path.endsWith('big.txt')) {
      return new Promise(resolve => setTimeout(() => resolve({
        ok: true, value: { path: payload.path, source: BIG_TEXT, version: 'v1', eol: 'LF', bom: false },
      }), 900))
    }
    return { ok: true, value: { path: payload.path, source: savedFiles.get(payload.path) || '', version: 'v1', eol: 'LF', bom: false } }
  }
  if (method === 'world-vscode-source/list') {
    const path = payload.path
    if (path === 'C:/fixtures') return { ok: true, value: { path, parent: '', entries: [
      { name: 'notes.txt', type: 'file' }, { name: 'docs', type: 'directory' },
    ], truncated: false } }
    if (path === 'C:/fixtures/docs') return { ok: true, value: { path, parent: 'C:/fixtures', entries: [
      { name: 'README.md', type: 'file' }, { name: 'main.js', type: 'file' },
    ], truncated: false } }
    if (path.endsWith('/src')) return { ok: true, value: { path, parent: '/workspace', entries: [
      { name: 'main.js', type: 'file' }, { name: 'big.txt', type: 'file' },
    ], truncated: false } }
    if (path === '/workspace') return { ok: true, value: { path, parent: '/', entries: [
      { name: 'src', type: 'directory' }, { name: 'README.md', type: 'file' },
    ], truncated: false } }
    return { ok: true, value: { path, parent: '', entries: [], truncated: false } }
  }
  if (method === 'world-vscode-source/save') {
    savedFiles.set(payload.path, payload.source)
    return { ok: true, value: { path: payload.path, source: payload.source, version: 'v2' } }
  }
  if (method === 'world-vscode-source/reveal') return { ok: true, value: { path: payload.path } }
  if (method.startsWith('world-vscode-git/')) return gitRpc(method.slice('world-vscode-git/'.length), payload)
  if (method === 'world-vscode-search/find') {
    const query = String(payload.query || '').toLowerCase()
    const files = [
      { path: 'src/main.js', matches: [{ line: 1, column: 6, text: 'const value = 2', ranges: [[6, 11]], prefix: false, suffix: false }] },
      { path: 'README.md', matches: [{ line: 1, column: 9, text: '# README value', ranges: [[9, 14]], prefix: false, suffix: false }] },
    ].filter(file => file.matches.some(match => match.text.toLowerCase().includes(query)))
    return {
      ok: true,
      value: {
        root: '/workspace', query, files, fileCount: files.length,
        total: files.reduce((count, file) => count + file.matches.length, 0),
        scanned: 2, skipped: 0, truncated: false, tookMs: 4,
      },
    }
  }
  return { ok: false, error: { message: `Unknown method ${method}` } }
} }

// 一个固定的仓库快照：暂存 1 个、工作区改 1 个、未跟踪 1 个，够覆盖面板的所有分组
const gitState = {
  repo: true, root: '/workspace', branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0,
  detached: false, unborn: false, remotes: ['origin'], truncated: false, message: '',
  identity: { name: 'World Tester', email: 'world@example.invalid', ok: true },
  files: [
    { path: 'src/main.js', from: '', index: 'M', worktree: ' ', untracked: false, conflicted: false, staged: true, unstaged: false, open: 'src/main.js' },
    { path: 'README.md', from: '', index: ' ', worktree: 'M', untracked: false, conflicted: false, staged: false, unstaged: true, open: 'README.md' },
    { path: 'src/app.js', from: '', index: '?', worktree: '?', untracked: true, conflicted: false, staged: false, unstaged: false, open: 'src/app.js' },
  ],
}
const gitSnapshot = () => ({
  ...gitState,
  files: gitState.files.map(file => ({ ...file })),
  staged: gitState.files.filter(file => file.staged).length,
  changed: gitState.files.filter(file => file.unstaged || file.untracked).length,
})
const setStaged = (paths, staged) => {
  gitState.files = gitState.files.map(file => {
    if (!paths.includes(file.path)) return file
    if (staged) return { ...file, index: file.untracked ? 'A' : file.worktree === 'D' ? 'D' : 'M', worktree: ' ', untracked: false, staged: true, unstaged: false }
    return { ...file, index: ' ', worktree: file.index === 'A' ? '?' : 'M', untracked: file.index === 'A', staged: false, unstaged: true }
  })
}
function gitRpc(operation, payload) {
  if (operation === 'status') return { ok: true, value: gitSnapshot() }
  if (operation === 'stage' || operation === 'unstage') {
    setStaged(payload.paths, operation === 'stage')
    return { ok: true, value: { status: gitSnapshot(), output: '' } }
  }
  if (operation === 'commit') {
    if (!gitState.files.some(file => file.staged))
      return { ok: false, error: { code: 'GIT_NOTHING_STAGED', message: '没有已暂存的更改，先暂存文件再提交。' } }
    gitState.files = gitState.files.filter(file => !file.staged)
    return { ok: true, value: { status: gitSnapshot(), output: `[main 1a2b3c4] ${payload.message}` } }
  }
  if (operation === 'pull') return { ok: true, value: { status: gitSnapshot(), output: 'Already up to date.' } }
  if (operation === 'push') {
    gitState.ahead = 0
    return { ok: true, value: { status: gitSnapshot(), output: 'Everything up-to-date' } }
  }
  return { ok: false, error: { message: `Unknown git operation ${operation}` } }
}

const FakeIcon = ({ size = 20 }) => React.createElement('svg', {
  width: size, height: size, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', 'aria-hidden': true,
}, React.createElement('rect', { x: 2, y: 2, width: 16, height: 16, rx: 3 }))
const mainEntries = [
  { options: { key: 'conversation' }, component: () => null },
  { options: { key: 'workflow-studio' }, component: () => null, inject: () => ({ rpc }), locale: 'workflow-studio' },
  { options: { key: 'assessment' }, component: () => null, inject: () => ({}) },
  { options: { key: 'pbide' }, component: () => null, children: { 'pbide.chat': { kind: 'single', scope: 'session' } } },
]
const sideEntries = [
  { options: { id: 'workflow-studio', label: () => '工作流', order: 15 }, component: FakeIcon },
  { options: { id: 'assessment', label: () => '能力测评', order: 30 }, component: FakeIcon },
  { options: { id: 'pbide', label: () => 'PBIDE', order: 20 }, component: FakeIcon },
]
const renderSlot = (name, _owner, opts) => name === 'world.assistant.conversation'
  ? conversationFixture.renderSlot(name)
  : pluginFixtures.has(opts?.entryKey) ? React.createElement(pluginFixtures.get(opts.entryKey), { rpc })
  : React.createElement('div', {
  className: 'world-plugin-test-page', 'data-world-plugin-page': opts?.entryKey,
}, `插件页面：${opts?.entryKey}`)

const layoutCalls = []
apply({
  sessions, remote, connection: { rpc },
  // 只能在 DSH 窗口里打开的宿主页面（插件管理）走 layout.selectPanel，这里记下来给断言用。
  layout: { selectPanel: id => layoutCalls.push(id) },
  // 桌面宿主的原生选目录；浏览器测试里用它模拟「浏览…」按钮
  get: name => name === 'remote.directoryPicker'
    ? { pick: async () => ({ ok: true, value: '/workspace/src' }) }
    : undefined,
  effect(effect) { const cleanup = effect(); if (cleanup) effects.push(cleanup) },
  slots: {
    inject(name, resolve) {
      const value = resolve()
      if (name === 'shell.overlay') overlay = value
      if (typeof value === 'function' && name === 'world.app.page') effects.push(value)
      return value
    },
    register(options, component) {
      const entry = { options, component }
      slotEntries.set(options.name, entry)
      for (const notify of slotListeners) notify()
      const dispose = () => {
        if (slotEntries.get(options.name) === entry) slotEntries.delete(options.name)
        for (const notify of slotListeners) notify()
      }
      dispose.options = options
      dispose.component = component
      return dispose
    },
    subscribe() { return () => {} },
    entries(name) { return name === 'main' ? mainEntries : name === 'sidebar.panellist' ? sideEntries : [] },
    entriesOfSlot(name) { return name === 'main' ? mainEntries : name === 'sidebar.panellist' ? sideEntries : [] },
  },
})

conversationFixture = createConversationFixture({ entries: slotEntries, mainSessionId: () => mainSessionId,
  subscribeSlots: listener => { slotListeners.add(listener); return () => slotListeners.delete(listener) },
  subscribeMain: listener => { mainSessionListeners.add(listener); return () => mainSessionListeners.delete(listener) } })
sessions.retain = conversationFixture.retain
const root = createRoot(document.getElementById('overlay-root'))
root.render(React.createElement(overlay.component, { ...overlay.options.inject(), renderSlot, SessionProvider: conversationFixture.SessionProvider }))
window.__worldTesting = {
  calls,
  layoutCalls,
  files: () => Object.fromEntries(savedFiles),
  capture: options => captureDesktopScreenshot(options),
  conversation: conversationFixture,
  renderPlugin(key, component) { pluginFixtures.set(key, component) },
  setFile(path, source) { savedFiles.set(path, source) },
  switchMain(id) { mainSessionId = id; for (const listener of mainSessionListeners) listener() },
  dispose() { root.unmount(); conversationFixture.dispose(); effects.forEach(cleanup => cleanup()) },
}
