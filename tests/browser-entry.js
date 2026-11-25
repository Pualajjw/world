import React from 'react'
import { captureDesktopScreenshot } from '../desktop-shot.js'
import { createRoot } from 'react-dom/client'
import { apply } from '../client-src.js'
import { createConversationFixture } from './conversation-fixture.js'
import { worldConfirm } from '../world-confirm.js'

const effects = []
let overlay
const slotEntries = new Map()
const slotListeners = new Set()
const pluginFixtures = new Map()
let conversationFixture
const source = 'const value = 1\n'
// 0.85 MiB / 50000 行：纯文本也应只挂载可见视口。
const BIG_TEXT = Array.from({ length: 50000 }, (_, index) => `line ${index} ${'x'.repeat(6)}`).join('\n')
const calls = []
const runJobs = new Map()
const savedFiles = new Map([['/workspace/src/main.js', source]])
// 版本号跟着 setFile 走：对话/外部工具改完文件，编辑器靠它判断要重读哪几个标签。
const fileVersions = new Map()
const versionOf = path => fileVersions.get(path) || 'v1'
let mainSessionId = 'session-1'
const mainSessionListeners = new Set()
/** 会话列表夹具：VSCode 对话按 cwd 筛选；新建会真的往里加一行。 */
const sessionRows = {
  'session-1': {
    id: 'session-1', title: '工作区会话', displayTitle: '工作区会话', cwd: '/workspace',
    updatedAt: 1, blank: false, running: false, retainedBy: { mainView: 1 },
  },
}
const sessionListListeners = new Set()
const sessionCreates = []
const projectionRefreshes = []
let nextSessionId = 2
let sessionSnapshot = null
const publishSessions = () => {
  sessionSnapshot = null
  for (const listener of sessionListListeners) listener()
}
const sessions = {
  list: {
    getSnapshot: () => {
      if (!sessionSnapshot) {
        const byId = { ...sessionRows }
        if (!byId[mainSessionId])
          byId[mainSessionId] = { id: mainSessionId, displayTitle: mainSessionId, cwd: '/workspace', updatedAt: 1, blank: false, running: false, retainedBy: { mainView: 1 } }
        sessionSnapshot = { ids: Object.keys(byId), byId, phase: 'ready' }
      }
      return sessionSnapshot
    },
    subscribe: listener => { sessionListListeners.add(listener); return () => sessionListListeners.delete(listener) },
  },
  async create({ cwd, workspaceId } = {}) {
    const id = `session-${nextSessionId++}`
    const root = cwd || (workspaceId === 'ws-main' ? '/workspace' : '')
    sessionRows[id] = {
      id, title: `新建会话 ${id}`, displayTitle: `新建会话 ${id}`, cwd: root,
      updatedAt: Date.now(), blank: true, running: false, retainedBy: {},
    }
    sessionCreates.push({ id, ...(workspaceId ? { workspaceId } : { cwd }) })
    publishSessions()
    return id
  },
  async refreshProjections(id) { projectionRefreshes.push(id) },
}
const remote = { session: { openWorkspacePath: request => window.__worldOpenWorkspacePath(request) }, workspaceFiles: { async list(sessionId, path) {
  return { ok: true, value: { entries: path.endsWith('/src') ? [
    { name: 'main.js', type: 'file', size: 17 },
    { name: 'big.txt', type: 'file', size: BIG_TEXT.length },
  ] : [
    { name: 'src', type: 'directory' }, { name: 'README.md', type: 'file', size: 20 },
  ], truncated: false } }
} } }
/**
 * 宿主的 RPC 会随调用方的取消一起失败。假 transport 也得照做，
 * 否则「Esc 取消连接」在浏览器测试里只会卡在那里，测不出真实行为。
 */
function cancellable(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const stop = () => reject(Object.assign(new Error('已取消。'), { code: 'WORLD_SSH_CANCELLED' }))
    if (signal.aborted) { stop(); return }
    signal.addEventListener('abort', stop, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', stop); resolve(value) },
      error => { signal.removeEventListener('abort', stop); reject(error) },
    )
  })
}

const rpc = { async call(_base, method, payload, signal) {
  calls.push({ method, payload })
  if (method === 'world-app-tools/catalog' && window.__worldToolCatalog) return { ok:true, value:await window.__worldToolCatalog() }
  if (method === 'world-internet/connection' && !window.__worldInternetCall)
    return { ok: true, value: { connected: false, ipv4: '', peerCount: 0 } }
  if (method.startsWith('world-internet/') && window.__worldInternetCall)
    return cancellable(window.__worldInternetCall(method.slice('world-internet/'.length), payload), signal)
  if (method.startsWith('world-pbnpm/')) {
    if (window.__worldPbnpmCall) return cancellable(window.__worldPbnpmCall(method.slice('world-pbnpm/'.length), payload), signal)
    return { ok: true, value: { version: '0.8.4', installedVersion: null, source: '开发 pbpkg' } }
  }
  if (method.startsWith('world-update/')) {
    if (window.__worldUpdateCall) return cancellable(window.__worldUpdateCall(method.slice('world-update/'.length), payload), signal)
    return { ok: true, value: { currentVersion: '0.2.145', dshVersion: '0.2.2-rc.3', source: 'github', canInstall: false, job: { state: 'idle' } } }
  }
  if (method.startsWith('world-storage/') && window.__worldStorageCall)
    return cancellable(window.__worldStorageCall(method.slice('world-storage/'.length), payload), signal)
  if (method.startsWith('world-startup/') && window.__worldStartupCall)
    return cancellable(window.__worldStartupCall(method.slice('world-startup/'.length), payload), signal)
  if (method.startsWith('world-processes/') && window.__worldProcessesCall)
    return cancellable(window.__worldProcessesCall(method.slice('world-processes/'.length), payload), signal)
  if (method.startsWith('world-journal/') && window.__worldJournalCall) return window.__worldJournalCall(method.slice('world-journal/'.length), payload)
  if (method.startsWith('world-tasks/') && window.__worldTasksCall) return window.__worldTasksCall(method.slice('world-tasks/'.length), payload)
  if (method.startsWith('workflow-studio/') && window.__worldWorkflowCall) return window.__worldWorkflowCall(method.slice('workflow-studio/'.length), payload)
  if (method.startsWith('world-desktop-brain/') && window.__worldBrainCall) {
    try { return { ok: true, value: await window.__worldBrainCall(method.slice('world-desktop-brain/'.length), payload) } }
    catch (error) { return { ok: false, error: { message: error.message, code: error.code } } }
  }
  if (method.startsWith('world-terminal/') && window.__worldTerminalCall) {
    return window.__worldTerminalCall(method.slice('world-terminal/'.length), payload)
  }
  if (method.startsWith('world-ssh/') && window.__worldSshCall) {
    return cancellable(window.__worldSshCall(method.slice('world-ssh/'.length), payload), signal)
  }
  if (method.startsWith('world-her-message/') && window.__worldHerMessage) {
    try { return { ok: true, value: await window.__worldHerMessage(method.slice('world-her-message/'.length), payload) } }
    catch (error) { return { ok: false, error: { message: error.message, code: error.code } } }
  }
  if (method.startsWith('world-power/') && window.__worldPowerCall) {
    try { return { ok: true, value: await window.__worldPowerCall(method.slice('world-power/'.length), payload) } }
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
  if (method === 'world-launch/ready') return { ok: true, value: { ready: true, services: { sessions: true, subprocess: true } } }
  if (method === 'world-launch/poll') {
    if (!window.__worldLaunchPoll) return { ok: true, value: { intent: null } }
    return { ok: true, value: { intent: await window.__worldLaunchPoll() } }
  }
  if (method === 'world-launch/shortcut' && window.__worldLaunchShortcut) {
    try { return { ok: true, value: await window.__worldLaunchShortcut(payload) } }
    catch (error) { return { ok: false, error: { message: error.message, code: error.code } } }
  }
  if (method === 'world-vscode-source/open-zip' && window.__worldZipOpen) return window.__worldZipOpen(payload)
  if (method === 'world-vscode-source/probe') {
    const path = String(payload.path || '')
    const name = path.split('/').filter(Boolean).at(-1) || path
    const directory = !/\.[^/.]+$/u.test(name)
    return { ok: true, value: { path, type: directory ? 'directory' : 'file', name } }
  }
  if (method === 'world-vscode-source/versions') {
    if (window.__worldSourceVersions) return window.__worldSourceVersions(payload)
    return { ok: true, value: { versions: (payload.paths || []).filter(path => savedFiles.has(path)).map(path => ({ path, version: versionOf(path) })) } }
  }
  if (method === 'world-vscode-source/open') {
    if (window.__worldSourceOpen) return cancellable(window.__worldSourceOpen(payload), signal)
    // 大文件故意慢一点：加载态需要能被子测试看到
    if (payload.path.endsWith('big.txt')) {
      return new Promise(resolve => setTimeout(() => resolve({
        ok: true, value: { path: payload.path, source: BIG_TEXT, version: 'v1', eol: 'LF', bom: false },
      }), 900))
    }
    if (payload.path.endsWith('build.bat')) {
      return { ok: true, value: { path: payload.path, source: '@echo off\r\necho hello from batch\r\n', version: 'v1', eol: 'CRLF', bom: false } }
    }
    return { ok: true, value: { path: payload.path, source: savedFiles.get(payload.path) || '', version: versionOf(payload.path), eol: 'LF', bom: false } }
  }
  if (method.startsWith('world-vscode-pb/') && window.__worldPbAction) return { ok: true, value: await window.__worldPbAction(method.split('/').at(-1), payload) }
  if (method.startsWith('world-vscode-roots/') && window.__worldRootsCall) {
    try { return { ok: true, value: await window.__worldRootsCall(method.split('/').at(-1), payload) } }
    catch (error) { return { ok: false, error: { message: error.message, code: error.code } } }
  }
  if (['pbnpm-pbd-project/open', 'pbnpm-pbd-project/application'].includes(method) && window.__worldPbdCall) {
    return window.__worldPbdCall(method.split('/').at(-1), payload)
  }
  if (method === 'world-vscode-source/list' && window.__worldWorkspaceList) {
    const custom = await window.__worldWorkspaceList(payload)
    if (custom) return custom
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
      { name: 'src', type: 'directory' }, { name: 'README.md', type: 'file' }, { name: 'build.bat', type: 'file' },
    ], truncated: false } }
    return { ok: true, value: { path, parent: '', entries: [], truncated: false } }
  }
  if (method === 'world-vscode-source/save') {
    if (window.__worldSourceSave) return window.__worldSourceSave(payload)
    savedFiles.set(payload.path, payload.source)
    fileVersions.set(payload.path, 'v2')
    return { ok: true, value: { path: payload.path, source: payload.source, version: 'v2' } }
  }
  if (method === 'world-vscode-source/reveal') return { ok: true, value: { path: payload.path } }
  if (method.startsWith('world-vscode-git/')) return gitRpc(method.slice('world-vscode-git/'.length), payload)
  if (method === 'world-vscode-sessions/resolve')
    return { ok: true, value: { workspaceId: payload.root === '/workspace' ? 'ws-main' : '' } }
  if (method === 'world-vscode-search/find') {
    if (window.__worldContentSearch) return cancellable(window.__worldContentSearch(payload), signal)
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
  if (method === 'world-vscode-search/files') {
    if (window.__worldFileSearch) return cancellable(window.__worldFileSearch(payload), signal)
    const query = String(payload.query || '').toLowerCase().replaceAll('\\', '/')
    const files = ['src/main.js', 'README.md'].filter(path => path.toLowerCase().includes(query)).map(path => ({ path }))
    return { ok: true, value: { root: payload.root || '/workspace', query: payload.query, files,
      fileCount: files.length, scanned: 2, skipped: 0, truncated: false, tookMs: 1 } }
  }
  if (method === 'world-vscode-search/replace') {
    const paths = Array.isArray(payload.paths) ? payload.paths : []
    return {
      ok: true,
      value: {
        root: '/workspace', query: payload.query, replacement: payload.replacement,
        files: paths.map(path => ({ path, replacements: 1 })), fileCount: paths.length,
        replacements: paths.length, skipped: [], tookMs: 2,
      },
    }
  }
  if (method === 'world-terminal/run') {
    const jobId = `run-${runJobs.size + 1}`
    runJobs.set(jobId, 0)
    return { ok: true, value: { jobId, cwd: payload.cwd, startedAt: Date.now(), shell: 'cmd' } }
  }
  if (method === 'world-terminal/poll') {
    const polls = runJobs.get(payload.jobId) || 0
    runJobs.set(payload.jobId, polls + 1)
    return polls === 0
      ? { ok: true, value: { chunk: 'hello from batch\r\n', offset: 18, lossy: false, running: true,
        exitCode: null, signal: null, cancelled: false, error: '', durationMs: 12 } }
      : polls < 3
        ? { ok: true, value: { chunk: '', offset: 18, lossy: false, running: true,
          exitCode: null, signal: null, cancelled: false, error: '', durationMs: 12 + polls * 220 } }
        : { ok: true, value: { chunk: '', offset: 18, lossy: false, running: false,
          exitCode: 0, signal: null, cancelled: false, error: '', durationMs: 24 + polls * 220 } }
  }
  if (method === 'world-terminal/cancel') return { ok: true, value: { cancelled: true } }
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
const gitCommits = [
  { hash: 'abcdef0123456789012345678901234567890123', shortHash: 'abcdef0', subject: '完善提交历史', body: '完善提交历史\n\n支持中文说明\n以及多行详情', author: 'World Tester', date: '2026-11-16T09:00:00+08:00' },
  { hash: '1234567890123456789012345678901234567890', shortHash: '1234567', subject: '初始提交', body: '初始提交', author: 'World Tester', date: '2026-11-15T09:00:00+08:00' },
]
function gitRpc(operation, payload) {
  if (window.__worldGitCall) return window.__worldGitCall(operation, payload)
  if (operation === 'commit-files') return { ok: true, value: { commit: payload.commit, parent: null, merge: false,
    files: [{ path: 'src/main.js', from: '', status: 'M' }], truncated: false } }
  if (operation === 'commit-diff') return gitRpc('diff', { ...payload, staged: true })
  if (operation === 'log') return window.__worldGitLog
    ? window.__worldGitLog(payload)
    : { ok: true, value: { commits: gitCommits.map(commit => ({ ...commit })), truncated: false } }
  if (operation === 'status') return { ok: true, value: gitSnapshot() }
  if (operation === 'diff') {
    const path = payload.paths?.at(-1) || ''
    const scope = payload.staged ? 'index' : 'worktree'
    const patch = payload.untracked
      ? `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,1 @@\n+${path} untracked\n`
      : `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n unchanged\n-removed line\n+added ${scope} line\n`
    return {
      ok: true,
      value: {
        paths: payload.paths, staged: payload.staged === true, untracked: payload.untracked === true,
        patch, truncated: false,
      },
    }
  }
  if (operation === 'stage' || operation === 'unstage') {
    setStaged(payload.paths, operation === 'stage')
    return { ok: true, value: { status: gitSnapshot(), output: '' } }
  }
  if (operation === 'commit') {
    if (!gitState.files.some(file => file.staged))
      return { ok: false, error: { code: 'GIT_NOTHING_STAGED', message: '没有已暂存的更改，先暂存文件再提交。' } }
    gitState.files = gitState.files.filter(file => !file.staged)
    gitCommits.unshift({ hash: 'fedcba9876543210012345678901234567890123', shortHash: 'fedcba9', subject: payload.message, body: payload.message, author: 'World Tester', date: new Date().toISOString() })
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
  get: name => name === 'shortcuts' ? window.__worldShortcuts : name === 'remote.directoryPicker'
    ? { pick: async () => ({ ok: true, value: '/workspace/src' }) }
    : undefined,
  effect(effect) { const cleanup = effect(); if (cleanup) effects.push(cleanup) },
  slots: {
    inject(name, resolve) {
      const value = resolve()
      if (name === 'shell.overlay') overlay = value
      if (typeof value === 'function' && ['world.app.page', 'world.vscode.document'].includes(name)) effects.push(value)
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
  // 确认框的队列是模块级的，测试直接拿同一个函数就能验证键盘 / 焦点 / 手机布局。
  confirm: options => worldConfirm(options),
  conversation: conversationFixture,
  sessionCreates,
  sessionRows,
  projectionRefreshes,
  renderPlugin(key, component) { pluginFixtures.set(key, component) },
  setFile(path, source) { savedFiles.set(path, source); fileVersions.set(path, `v${(Number(fileVersions.get(path)?.slice(1)) || 1) + 1}`) },
  switchMain(id) { mainSessionId = id; for (const listener of mainSessionListeners) listener(); publishSessions() },
  dispose() { root.unmount(); conversationFixture.dispose(); effects.forEach(cleanup => cleanup()) },
}
