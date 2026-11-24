/** Session-authorized UTF-8 editing and read-only GBK viewing through DSH's filesystem. */
import { dirname } from 'node:path'

const MAX_SOURCE_BYTES = 16 * 1024 * 1024
const MAX_ENTRIES = 2000

/** For a mixed-ending source keep original raw slices outside changed body ranges. */
function restoreMixed(before, after, raw, newline, spans) {
  const valid = () => {
    if (!Array.isArray(spans)) return false
    let a = 0, b = 0
    for (const span of spans) {
      if (!Array.isArray(span) || span.length !== 4 || !span.every(Number.isSafeInteger)) return false
      const [i,j,k,l] = span
      if (i<a || k<b || j<i || l<k || j>before.length || l>after.length || before.slice(a,i)!==after.slice(b,k)) return false
      a=j; b=l
    }
    return before.slice(a) === after.slice(b)
  }
  if (!valid()) {
    let i = 0, j = before.length, l = after.length
    while (i<j && i<l && before[i]===after[i]) i++
    while (i<j && i<l && before[j-1]===after[l-1]) { j--; l-- }
    spans = [[i,j,i,l]]
  }
  let normalizedAt = 0, rawAt = 0
  const take = end => {
    const start = rawAt
    while (normalizedAt < end) { if (raw[rawAt] === '\r' && raw[rawAt+1] === '\n') rawAt++; rawAt++; normalizedAt++ }
    return raw.slice(start, rawAt)
  }
  const result = []
  for (const [i,j,k,l] of spans) {
    result.push(take(i)); const previous = take(j).matchAll(/\r\n|\r|\n/g)
    result.push(after.slice(k,l).replace(/\n/g, () => previous.next().value?.[0] || newline))
  }
  result.push(raw.slice(rawAt)); return result.join('')
}

/**
 * Open an existing text file and save it with policy and version checks.
 * `root` is the folder the editor window currently has open; a path is only
 * accepted inside it. Editing outside the session workspace is allowed (the
 * user opened that folder on purpose), but every write still goes through the
 * sandbox policy, so read-only and workspace-write keep their meaning.
 */
export function createVscodeSourceEditor(ctx, { FsError, writableRoots, reveal, zip }) {
  const fs = zip?.fs || ctx.fs
  const lifetime = new AbortController(), pending = new Set()
  const fail = (message, code) => { throw new FsError(message, code) }

  async function sessionFor(id, signal, headerOnly) {
    const live = ctx.sessions.get(id)
    if (live) return live
    const persistence = ctx.get('sessionPersistence')
    if (!persistence) fail('重新打开会话后才能编辑文件。', 'FS_NOT_FOUND')
    const handle = await persistence.open(id, 'read', { signal })
    try {
      // Listing only needs the persisted cwd, not a replay of every chat event.
      if (headerOnly) return ctx.sessions.get(id) ?? { header: handle.header }
      const { events, eventState } = await handle.read(0, undefined, { signal })
      return ctx.sessions.get(id) ?? ctx.sessions.prepare(id, {
        seed: events, meta: handle.header, inheritedEventCount: handle.inheritedEventCount, eventState,
      })
    } finally { await handle.close() }
  }

  async function sessionOf(payload, signal, code, headerOnly = false) {
    if (!payload || typeof payload.sessionId !== 'string' || !payload.sessionId)
      fail('先打开一个会话再浏览文件。', code)
    const session = await sessionFor(payload.sessionId, signal, headerOnly)
    if (!session) fail('重新打开会话后才能编辑文件。', 'FS_NOT_FOUND')
    return session
  }

  /** The folder this window is rooted at: the session workspace, or one the user opened. */
  async function rootFor(payload, session, signal) {
    const workspaceRoot = session.header?.cwd
    const requested = typeof payload?.root === 'string' && payload.root ? payload.root : workspaceRoot
    if (!requested) fail('这个会话还没有工作目录，先打开一个文件夹。', 'FS_NO_WORKSPACE')
    const root = await fs.resolve(requested, { cwd: workspaceRoot, signal })
    const info = await fs.stat(root, signal)
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
    const rootDir = fs.processPath(root)
    const entry = await fs.lstat(payload.path, { cwd: rootDir }, signal)
    if (!entry) fail('路径不存在。', 'FS_NOT_FOUND')
    const target = await fs.resolve(payload.path, { cwd: rootDir, signal })
    if (!fs.contains(root, target)) fail('路径不在当前打开的文件夹里。', 'FS_SANDBOX_DENIED')
    return { session, target, entry }
  }

  async function locate(payload, signal) {
    const located = await locateExisting(payload, signal)
    if (located.entry?.type !== 'file') fail('只能打开已存在的普通文件。', 'FS_NOT_REGULAR_FILE')
    return located
  }

  async function read(target, signal) {
    const before = await fs.stat(target, signal)
    if (!before) fail('文件已不存在。', 'FS_NOT_FOUND')
    const bytes = await fs.readBytes(target, signal, MAX_SOURCE_BYTES)
    const after = await fs.stat(target, signal)
    if (after?.version !== before.version) fail('读取时文件被改动，请重试。', 'FS_STALE_VERSION')
    let raw, encoding = 'UTF-8'
    try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
    catch (error) {
      if (!(error instanceof TypeError)) throw error
      try { raw = new TextDecoder('gbk', { fatal: true }).decode(bytes); encoding = 'GBK' }
      catch (cause) { if (!(cause instanceof TypeError)) throw cause; fail('文件不是有效的 UTF-8 或 GBK 文本。', 'FS_NOT_TEXT') }
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(raw)) fail('二进制文件不能当文本编辑。', 'FS_NOT_TEXT')
    const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : ''
    if (bom) raw = raw.slice(1)
    const endings = new Map()
    for (const [ending] of raw.matchAll(/\r\n|\r|\n/gu)) endings.set(ending, (endings.get(ending) ?? 0) + 1)
    const newline = [...endings].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '\n'
    return { mixedRaw: endings.size > 1 ? raw : null, source: raw.replace(/\r\n?/gu, '\n'), version: before.version, bom, newline, encoding }
  }

  /** Files and folders under one directory: the tree and the "open folder" dialog share this. */
  async function list(payload, signal) {
    const session = await sessionOf(payload, signal, 'FS_INVALID_PATH', true)
    const workspaceRoot = session.header?.cwd
    const requested = typeof payload.path === 'string' ? payload.path : ''
    if (!requested && !workspaceRoot) fail('这个会话还没有工作目录。', 'FS_NO_WORKSPACE')
    const target = await fs.resolve(requested || workspaceRoot, { cwd: workspaceRoot, signal })
    const info = await fs.stat(target, signal)
    if (!info) fail('文件夹不存在。', 'FS_NOT_FOUND')
    if (info.type !== 'directory') fail('只能打开文件夹。', 'FS_NOT_DIRECTORY')
    const entries = await fs.listDir(target, signal)
    const items = entries
      .filter(entry => (entry?.type === 'file' || entry?.type === 'directory') && typeof entry.name === 'string')
      .map(entry => ({ name: entry.name, type: entry.type }))
      .sort((left, right) => left.type === right.type
        ? left.name.localeCompare(right.name)
        : left.type === 'directory' ? -1 : 1)
    const path = fs.processPath(target)
    const parent = dirname(path)
    return {
      path,
      parent: !parent || parent === path ? '' : parent,
      // Rank the whole library index before the normal alphabetical listing is capped.
      ...(entries.some(e => Number.isFinite(e?.pbModifiedAt)) ? { recentObjects: entries
        .filter(e => e.type === 'file' && Number.isFinite(e.pbModifiedAt) && e.pbModifiedAt > 0)
        .sort((a, b) => b.pbModifiedAt - a.pbModifiedAt || a.name.localeCompare(b.name))
        .slice(0, 10).map(({ name }) => ({ name, type: 'file' })) } : {}),
      entries: items.slice(0, MAX_ENTRIES),
      truncated: items.length > MAX_ENTRIES,
    }
  }

  async function probe(payload, signal) {
    if (typeof payload?.path !== 'string' || !payload.path) fail('请先选择文件或文件夹。', 'FS_INVALID_PATH')
    const session = await sessionOf(payload, signal, 'FS_INVALID_PATH')
    const target = await fs.resolve(payload.path, { cwd: session.header?.cwd, signal })
    const info = await fs.stat(target, signal)
    if (!info) fail('路径不存在。', 'FS_NOT_FOUND')
    const path = fs.processPath(target)
    return { path, type: info.type === 'directory' ? 'directory' : 'file', name: path.split(/[\\/]/u).filter(Boolean).at(-1) || path }
  }

  /** 一次批量取版本号：对话里的工具改了文件后，编辑器靠它判断哪些标签需要重读。 */
  async function versions(payload, signal) {
    if (!Array.isArray(payload?.paths) || !payload.paths.length) return { versions: [] }
    const session = await sessionOf(payload, signal, 'FS_INVALID_PATH', true)
    const root = await rootFor(payload, session, signal)
    const rootDir = fs.processPath(root)
    const result = []
    for (const path of payload.paths.slice(0, 64)) {
      if (typeof path !== 'string' || !path) continue
      try {
        const target = await fs.resolve(path, { cwd: rootDir, signal })
        if (!fs.contains(root, target)) continue
        const info = await fs.stat(target, signal)
        if (info?.type === 'file') result.push({ path, version: info.version })
      } catch { /* 已删除或读不到：留给标签自己报错 */ }
    }
    return { versions: result }
  }

  async function call(operation, payload, signal) {
    const active = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    const task = (async () => {
      active.throwIfAborted()
      if (operation === 'open-zip') {
        await sessionOf(payload, active, 'FS_INVALID_PATH', true)
        if (!zip || typeof payload.path !== 'string') fail('请选择 ZIP 文件。', 'FS_INVALID_PATH')
        return zip.mount(payload.path, active)
      }
      if (operation === 'probe') return probe(payload, active)
      if (operation === 'versions') return versions(payload, active)
      if (operation === 'list') return list(payload, active)
      if (operation === 'reveal') {
        if (typeof reveal !== 'function') fail('当前宿主不支持在资源管理器中显示。', 'WORLD_REVEAL_UNAVAILABLE')
        const located = await locateExisting(payload, active)
        if (located.entry?.type !== 'file' && located.entry?.type !== 'directory')
          fail('只能显示已存在的文件或文件夹。', 'FS_NOT_REGULAR_FILE')
        await reveal(zip?.isMember(located.target) ? zip.physical(located.target) : fs.processPath(located.target), active)
        return { path: fs.processPath(located.target) }
      }
      const { session, target } = await locate(payload, active)
      if (operation === 'open' || operation === 'pbtest') {
        if (operation === 'pbtest') {
          if (zip?.isMember(target)) fail('运行前请先将文件解压到普通目录。', 'FS_INVALID_PATH')
          const policy = ctx.sandboxPolicy.resolve({ session })
          if (policy.mode === 'read-only') fail('只读会话不能运行 PBTest。', 'FS_SANDBOX_DENIED')
          if (policy.mode === 'workspace-write') {
            const roots = await Promise.all(writableRoots(policy).map(path => fs.resolve(path, { signal: active })))
            if (!roots.some(root => fs.contains(root, target))) fail('不能运行可写工作区以外的 PBTest。', 'FS_SANDBOX_DENIED')
          }
        }
        const opened = await read(target, active)
        return {
          path: fs.processPath(target), source: opened.source, version: opened.version,
          // 状态栏要显示真实换行符/BOM：保存时会按原样写回，不是假装统一成 LF
          eol: opened.newline === '\r\n' ? 'CRLF' : opened.newline === '\r' ? 'CR' : 'LF',
          bom: Boolean(opened.bom),
          encoding: opened.encoding, readOnly: opened.encoding !== 'UTF-8',
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
        const roots = await Promise.all(writableRoots(policy).map(path => fs.resolve(path, { signal: active })))
        if (!roots.some(root => fs.contains(root, target))) fail('文件在会话可写目录之外，保存已被拦截。', 'FS_SANDBOX_DENIED')
      }
      const current = await read(target, active)
      if (current.version !== payload.version) fail('文件在打开后被改动过，请重新打开再保存。', 'FS_STALE_VERSION')
      if (current.encoding !== 'UTF-8') fail('GBK 文件当前仅供查看；宿主不支持按原编码写入，已保留原文件。', 'FS_ENCODING_READ_ONLY')
      const normalized = payload.source.replace(/\r\n?/gu, '\n')
      const content = current.bom + (current.mixedRaw != null ? restoreMixed(current.source, normalized, current.mixedRaw, current.newline, payload.spans) : normalized.replace(/\n/gu, current.newline))
      if (Buffer.byteLength(content, 'utf8') > MAX_SOURCE_BYTES) fail('文件超过 16 MiB，编辑器打不开。', 'FS_TOO_LARGE')
      const saved = await fs.writeText(target, content, { kind: 'replaceIfVersion', version: payload.version }, active, policy)
      return {
        path: fs.processPath(target), source: (saved.after ?? normalized).replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n'),
        version: saved.version,
        eol: current.newline === '\r\n' ? 'CRLF' : current.newline === '\r' ? 'CR' : 'LF',
        bom: Boolean(current.bom),
        encoding: current.encoding, readOnly: false,
      }
    })()
    pending.add(task)
    return task.finally(() => pending.delete(task))
  }

  return { call, sessionOf, async dispose() { lifetime.abort(); await Promise.allSettled([...pending]) } }
}
