/** Session-authorized UTF-8 source editing through DSH's composed filesystem. */
import { dirname } from 'node:path'

const MAX_SOURCE_BYTES = 16 * 1024 * 1024
const MAX_ENTRIES = 2000

/**
 * Open an existing text file and save it with policy and version checks.
 * `root` is the folder the editor window currently has open; a path is only
 * accepted inside it. Editing outside the session workspace is allowed (the
 * user opened that folder on purpose), but every write still goes through the
 * sandbox policy, so read-only and workspace-write keep their meaning.
 */
export function createVscodeSourceEditor(ctx, { FsError, writableRoots, reveal }) {
  const lifetime = new AbortController(), pending = new Set()
  const fail = (message, code) => { throw new FsError(message, code) }

  async function sessionFor(id, signal) {
    const live = ctx.sessions.get(id)
    if (live) return live
    const persistence = ctx.get('sessionPersistence')
    if (!persistence) fail('重新打开会话后才能编辑文件。', 'FS_NOT_FOUND')
    const handle = await persistence.open(id, 'read', { signal })
    try {
      const { events, eventState } = await handle.read(0, undefined, { signal })
      return ctx.sessions.get(id) ?? ctx.sessions.prepare(id, {
        seed: events, meta: handle.header, inheritedEventCount: handle.inheritedEventCount, eventState,
      })
    } finally { await handle.close() }
  }

  async function sessionOf(payload, signal, code) {
    if (!payload || typeof payload.sessionId !== 'string' || !payload.sessionId)
      fail('先打开一个会话再浏览文件。', code)
    const session = await sessionFor(payload.sessionId, signal)
    if (!session) fail('重新打开会话后才能编辑文件。', 'FS_NOT_FOUND')
    return session
  }

  /** The folder this window is rooted at: the session workspace, or one the user opened. */
  async function rootFor(payload, session, signal) {
    const workspaceRoot = session.header?.cwd
    const requested = typeof payload?.root === 'string' && payload.root ? payload.root : workspaceRoot
    if (!requested) fail('这个会话还没有工作目录，先打开一个文件夹。', 'FS_NO_WORKSPACE')
    const root = await ctx.fs.resolve(requested, { cwd: workspaceRoot, signal })
    const info = await ctx.fs.stat(root, signal)
    if (!info) fail('文件夹不存在。', 'FS_NOT_FOUND')
    if (info.type !== 'directory') fail('只能打开文件夹。', 'FS_NOT_DIRECTORY')
    return root
  }

  /** The same root/containment check for any existing entry, file or folder. */
  async function locateExisting(payload, signal) {
    if (typeof payload?.path !== 'string' || !payload.path)
      fail('请先选择一个文件或文件夹。', 'FS_INVALID_PATH')
    const session = await sessionOf(payload, signal, 'FS_INVALID_PATH')
    const root = await rootFor(payload, session, signal)
    const rootDir = ctx.fs.processPath(root)
    const entry = await ctx.fs.lstat(payload.path, { cwd: rootDir }, signal)
    if (!entry) fail('路径不存在。', 'FS_NOT_FOUND')
    const target = await ctx.fs.resolve(payload.path, { cwd: rootDir, signal })
    if (!ctx.fs.contains(root, target)) fail('路径不在当前打开的文件夹里。', 'FS_SANDBOX_DENIED')
    return { session, target, entry }
  }

  async function locate(payload, signal) {
    const located = await locateExisting(payload, signal)
    if (located.entry?.type !== 'file') fail('只能打开已存在的普通文件。', 'FS_NOT_REGULAR_FILE')
    return located
  }

  async function read(target, signal) {
    const before = await ctx.fs.stat(target, signal)
    if (!before) fail('文件已不存在。', 'FS_NOT_FOUND')
    const bytes = await ctx.fs.readBytes(target, signal, MAX_SOURCE_BYTES)
    const after = await ctx.fs.stat(target, signal)
    if (after?.version !== before.version) fail('读取时文件被改动，请重试。', 'FS_STALE_VERSION')
    let raw
    try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
    catch (error) { if (!(error instanceof TypeError)) throw error; fail('编辑器只支持 UTF-8 文本文件。', 'FS_NOT_TEXT') }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(raw)) fail('二进制文件不能当文本编辑。', 'FS_NOT_TEXT')
    const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : ''
    if (bom) raw = raw.slice(1)
    const endings = new Map()
    for (const [ending] of raw.matchAll(/\r\n|\r|\n/gu)) endings.set(ending, (endings.get(ending) ?? 0) + 1)
    const newline = [...endings].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '\n'
    return { source: raw.replace(/\r\n?/gu, '\n'), version: before.version, bom, newline }
  }

  /** Files and folders under one directory: the tree and the "open folder" dialog share this. */
  async function list(payload, signal) {
    const session = await sessionOf(payload, signal, 'FS_INVALID_PATH')
    const workspaceRoot = session.header?.cwd
    const requested = typeof payload.path === 'string' ? payload.path : ''
    if (!requested && !workspaceRoot) fail('这个会话还没有工作目录。', 'FS_NO_WORKSPACE')
    const target = await ctx.fs.resolve(requested || workspaceRoot, { cwd: workspaceRoot, signal })
    const info = await ctx.fs.stat(target, signal)
    if (!info) fail('文件夹不存在。', 'FS_NOT_FOUND')
    if (info.type !== 'directory') fail('只能打开文件夹。', 'FS_NOT_DIRECTORY')
    let entries = []
    try { entries = await ctx.fs.listDir(target, signal) }
    catch { entries = [] }
    const items = entries
      .filter(entry => (entry?.type === 'file' || entry?.type === 'directory') && typeof entry.name === 'string')
      .map(entry => ({ name: entry.name, type: entry.type }))
      .sort((left, right) => left.type === right.type
        ? left.name.localeCompare(right.name)
        : left.type === 'directory' ? -1 : 1)
    const path = ctx.fs.processPath(target)
    const parent = dirname(path)
    return {
      path,
      parent: !parent || parent === path ? '' : parent,
      entries: items.slice(0, MAX_ENTRIES),
      truncated: items.length > MAX_ENTRIES,
    }
  }

  async function probe(payload, signal) {
    if (typeof payload?.path !== 'string' || !payload.path) fail('请先选择文件或文件夹。', 'FS_INVALID_PATH')
    const session = await sessionOf(payload, signal, 'FS_INVALID_PATH')
    const target = await ctx.fs.resolve(payload.path, { cwd: session.header?.cwd, signal })
    const info = await ctx.fs.stat(target, signal)
    if (!info) fail('路径不存在。', 'FS_NOT_FOUND')
    const path = ctx.fs.processPath(target)
    return { path, type: info.type === 'directory' ? 'directory' : 'file', name: path.split(/[\\/]/u).filter(Boolean).at(-1) || path }
  }

  async function call(operation, payload, signal) {
    const active = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    const task = (async () => {
      active.throwIfAborted()
      if (operation === 'probe') return probe(payload, active)
      if (operation === 'list') return list(payload, active)
      if (operation === 'reveal') {
        if (typeof reveal !== 'function') fail('当前宿主不支持在资源管理器中显示。', 'WORLD_REVEAL_UNAVAILABLE')
        const located = await locateExisting(payload, active)
        if (located.entry?.type !== 'file' && located.entry?.type !== 'directory')
          fail('只能显示已存在的文件或文件夹。', 'FS_NOT_REGULAR_FILE')
        await reveal(ctx.fs.processPath(located.target), active)
        return { path: ctx.fs.processPath(located.target) }
      }
      const { session, target } = await locate(payload, active)
      if (operation === 'open') {
        const opened = await read(target, active)
        return {
          path: ctx.fs.processPath(target), source: opened.source, version: opened.version,
          // 状态栏要显示真实换行符/BOM：保存时会按原样写回，不是假装统一成 LF
          eol: opened.newline === '\r\n' ? 'CRLF' : opened.newline === '\r' ? 'CR' : 'LF',
          bom: Boolean(opened.bom),
        }
      }
      if (operation !== 'save') fail('不支持的编辑器操作。', 'FS_INVALID_PATH')
      if (typeof payload.version !== 'string' || !payload.version || typeof payload.source !== 'string')
        fail('请先打开文件再保存。', 'FS_NOT_OBSERVED')
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(payload.source)) fail('文本里含有二进制控制字符。', 'FS_NOT_TEXT')
      if (Buffer.byteLength(payload.source, 'utf8') > MAX_SOURCE_BYTES) fail('文件超过 16 MiB，编辑器打不开。', 'FS_TOO_LARGE')
      const policy = ctx.sandboxPolicy.resolve({ session })
      if (policy.mode === 'read-only') fail('只读模式下不能保存文件。', 'FS_SANDBOX_DENIED')
      if (policy.mode === 'workspace-write') {
        const roots = await Promise.all(writableRoots(policy).map(path => ctx.fs.resolve(path, { signal: active })))
        if (!roots.some(root => ctx.fs.contains(root, target))) fail('文件在会话可写目录之外，保存已被拦截。', 'FS_SANDBOX_DENIED')
      }
      const current = await read(target, active)
      if (current.version !== payload.version) fail('文件在打开后被改动过，请重新打开再保存。', 'FS_STALE_VERSION')
      const normalized = payload.source.replace(/\r\n?/gu, '\n')
      const content = current.bom + normalized.replace(/\n/gu, current.newline)
      if (Buffer.byteLength(content, 'utf8') > MAX_SOURCE_BYTES) fail('文件超过 16 MiB，编辑器打不开。', 'FS_TOO_LARGE')
      const saved = await ctx.fs.writeText(target, content, { kind: 'replaceIfVersion', version: payload.version }, active, policy)
      return {
        path: ctx.fs.processPath(target), source: (saved.after ?? normalized).replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n'),
        version: saved.version,
        eol: current.newline === '\r\n' ? 'CRLF' : current.newline === '\r' ? 'CR' : 'LF',
        bom: Boolean(current.bom),
      }
    })()
    pending.add(task)
    return task.finally(() => pending.delete(task))
  }

  return { call, async dispose() { lifetime.abort(); await Promise.allSettled([...pending]) } }
}
