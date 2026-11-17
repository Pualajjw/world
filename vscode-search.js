/** Project-wide text search behind the editor's search view. */
const MAX_QUERY = 300
const MAX_FILE_BYTES = 1_200_000
const MAX_FILES_SCANNED = 20_000
const MAX_MATCHES = 1_000
const MAX_MATCH_FILES = 200
const MAX_MATCHES_PER_FILE = 50
const MAX_LINE_CHARS = 400
const MAX_RANGES = 30
const TIME_BUDGET = 12_000
const MAX_REPLACE_FILES = 200
const MAX_REPLACEMENT_CHARS = 20_000

/** Directories that never carry hand-written source worth searching. */
export const SKIPPED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.sl', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '.turbo', '.parcel-cache', '__pycache__', '.venv', 'venv',
  '.idea', '.vs', 'target', 'obj', 'bin', '.gradle', '.mypy_cache', '.pytest_cache',
])

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'pdf', 'zip', 'gz', 'tgz',
  'bz2', 'xz', '7z', 'rar', 'tar', 'exe', 'dll', 'so', 'dylib', 'node', 'wasm', 'woff',
  'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'flac', 'ogg',
  'webm', 'class', 'jar', 'pyc', 'pyd', 'db', 'sqlite', 'sqlite3', 'pdb', 'ilk', 'o', 'a', 'lib',
])

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** `*.js`, `src/**`, `*.{ts,tsx}` → a matcher over '/'-separated relative paths. */
export function compileGlob(pattern) {
  const raw = String(pattern || '').trim().replace(/\\/gu, '/').replace(/^\.\//u, '')
  if (!raw) return null
  let source = ''
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    if (char === '*') {
      if (raw[index + 1] === '*') {
        index++
        if (raw[index + 1] === '/') { index++; source += '(?:[^/]+/)*' } else source += '.*'
      } else source += '[^/]*'
    } else if (char === '?') source += '[^/]'
    else if (char === '{') {
      const end = raw.indexOf('}', index)
      if (end < 0) { source += '\\{'; continue }
      source += `(?:${raw.slice(index + 1, end).split(',').map(escapeRegExp).join('|')})`
      index = end
    } else source += escapeRegExp(char)
  }
  return { re: new RegExp(`^${source}$`, 'iu'), basenameOnly: !raw.includes('/') }
}

/** Split a comma-separated include/exclude field into matchers. */
export function parseGlobList(value) {
  if (value === undefined || value === null || value === '') return []
  if (typeof value !== 'string' || value.length > 1000) return []
  return value.split(',').map(compileGlob).filter(Boolean)
}

function passes(filters, path, basename) {
  return filters.some(filter => filter.re.test(filter.basenameOnly ? basename : path))
}

/** Build the matcher for one query; thrown SyntaxErrors become a readable failure. */
export function buildMatcher({ query, regex = false, caseSensitive = false }) {
  const flags = caseSensitive ? 'gu' : 'giu'
  if (regex) {
    try { return new RegExp(query, flags) }
    catch (error) { throw Object.assign(new Error(`正则表达式无效：${String(error?.message || error)}`), { code: 'SEARCH_INVALID_PATTERN' }) }
  }
  return new RegExp(escapeRegExp(query), flags)
}

/** Keep a very long line readable around its first hit. */
export function clipLine(line, ranges) {
  if (line.length <= MAX_LINE_CHARS) return { text: line, ranges, prefix: false, suffix: false }
  const first = ranges[0]?.[0] ?? 0
  const left = Math.max(0, Math.min(first - 60, line.length - MAX_LINE_CHARS))
  const right = Math.min(line.length, left + MAX_LINE_CHARS)
  return {
    text: line.slice(left, right),
    ranges: ranges
      .map(([start, end]) => [Math.max(0, start - left), Math.min(right - left, end - left)])
      .filter(([start, end]) => end > start && start < right - left),
    prefix: left > 0,
    suffix: right < line.length,
  }
}

/** Every match in one text blob, capped per file. */
export function matchText(text, matcher) {
  const hits = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!line) continue
    matcher.lastIndex = 0
    const ranges = []
    let match
    while ((match = matcher.exec(line))) {
      if (!match[0].length) {
        // With /u, an index inside a surrogate pair is rounded back by exec().
        // Advance one complete code point so empty matches always make progress.
        const code = line.codePointAt(matcher.lastIndex)
        matcher.lastIndex += matcher.unicode && code > 0xffff ? 2 : 1
        continue
      }
      ranges.push([match.index, match.index + match[0].length])
      if (ranges.length >= MAX_RANGES) break
    }
    if (ranges.length === 0) continue
    const clipped = clipLine(line, ranges)
    hits.push({ line: index + 1, column: ranges[0][0], ...clipped })
    if (hits.length >= MAX_MATCHES_PER_FILE) break
  }
  return hits
}

/** Replace every match; plain text stays literal so `$1` in the replacement is not special. */
export function replaceText(text, matcher, replacement, regex = false) {
  matcher.lastIndex = 0
  let count = 0
  let match
  while ((match = matcher.exec(text))) {
    if (!match[0].length) {
      throw Object.assign(new Error('这个正则能匹配空字符串，不能用于替换。'), { code: 'SEARCH_INVALID_PATTERN' })
    }
    count++
    if (matcher.lastIndex === match.index) matcher.lastIndex++
  }
  const next = regex ? text.replace(matcher, replacement) : text.replace(matcher, () => replacement)
  return { text: next, count }
}

export function createVscodeSearch(ctx, { FsError, writableRoots } = {}) {
  const lifetime = new AbortController()
  const fail = (message, code = 'SEARCH_FAILED') => { throw new FsError(message, code) }

  async function sessionFor(id, signal) {
    const live = ctx.sessions.get(id)
    if (live) return live
    const persistence = ctx.get('sessionPersistence')
    if (!persistence) fail('重新打开会话后才能搜索。', 'SEARCH_NO_SESSION')
    const handle = await persistence.open(id, 'read', { signal })
    try {
      const { events, eventState } = await handle.read(0, undefined, { signal })
      return ctx.sessions.get(id) ?? ctx.sessions.prepare(id, {
        seed: events, meta: handle.header, inheritedEventCount: handle.inheritedEventCount, eventState,
      })
    } finally { await handle.close() }
  }

  /** The folder to walk: the one the editor window has open, or the session workspace. */
  async function scopeFor(payload, signal) {
    if (!payload || typeof payload.sessionId !== 'string' || !payload.sessionId)
      fail('先打开一个会话再搜索。', 'SEARCH_NO_SESSION')
    const session = await sessionFor(payload.sessionId, signal)
    if (!session) fail('重新打开会话后才能搜索。', 'SEARCH_NO_SESSION')
    const cwd = session.header?.cwd
    const requested = typeof payload.root === 'string' && payload.root ? payload.root : ''
    if (!requested && !cwd) fail('这个会话还没有工作目录。', 'SEARCH_NO_WORKSPACE')
    const root = await ctx.fs.resolve(requested || cwd, { cwd, signal })
    const info = await ctx.fs.stat(root, signal)
    if (!info) fail('要搜索的文件夹不存在。', 'SEARCH_NO_WORKSPACE')
    if (info.type !== 'directory') fail('只能搜索文件夹。', 'SEARCH_NO_WORKSPACE')
    return root
  }

  async function find(payload, signal) {
    const query = typeof payload?.query === 'string' ? payload.query : ''
    if (!query) fail('请输入要搜索的内容。', 'SEARCH_EMPTY')
    if (query.length > MAX_QUERY) fail(`搜索内容不能超过 ${MAX_QUERY} 个字符。`, 'SEARCH_TOO_LONG')
    const matcher = buildMatcher({
      query,
      regex: payload?.regex === true,
      caseSensitive: payload?.caseSensitive === true,
    })
    const includes = parseGlobList(payload?.include)
    const excludes = parseGlobList(payload?.exclude)
    const root = await scopeFor(payload, signal)

    const started = Date.now()
    const deadline = started + TIME_BUDGET
    const queue = [{ path: '', target: root }]
    const files = []
    let cursor = 0
    let scanned = 0
    let skipped = 0
    let total = 0
    let truncated = false

    const pushMatch = (path, hits) => {
      files.push({ path, matches: hits })
      total += hits.length
    }

    while (cursor < queue.length) {
      if (signal.aborted) break
      if (Date.now() > deadline) { truncated = true; break }
      const directory = queue[cursor++]
      let entries
      try { entries = await ctx.fs.listDir(directory.target, signal) }
      catch { skipped++; continue }
      for (const entry of entries) {
        if (signal.aborted) break
        const path = directory.path ? `${directory.path}/${entry.name}` : entry.name
        if (entry.type === 'directory') {
          if (SKIPPED_DIRS.has(entry.name)) continue
          if (excludes.length && excludes.some(filter => filter.re.test(filter.basenameOnly ? entry.name : path))) continue
          queue.push({ path, target: entry.target })
          continue
        }
        if (entry.type !== 'file') continue
        if (scanned >= MAX_FILES_SCANNED || files.length >= MAX_MATCH_FILES) { truncated = true; break }
        if (includes.length && !passes(includes, path, entry.name)) continue
        if (excludes.length && passes(excludes, path, entry.name)) continue
        const dot = entry.name.lastIndexOf('.')
        if (dot > 0 && BINARY_EXT.has(entry.name.slice(dot + 1).toLowerCase())) continue
        if (typeof entry.size === 'number' && entry.size > MAX_FILE_BYTES) { skipped++; continue }
        scanned++
        let bytes
        try { bytes = await ctx.fs.readBytes(entry.target, signal, MAX_FILE_BYTES) }
        catch { skipped++; continue }
        if (bytes.includes(0)) { skipped++; continue }
        const text = new TextDecoder('utf-8').decode(bytes)
        const hits = matchText(text, matcher)
        if (!hits.length) continue
        pushMatch(path, hits)
        if (total >= MAX_MATCHES) { truncated = true; break }
      }
      if (total >= MAX_MATCHES) { truncated = true; break }
    }

    files.sort((left, right) => left.path.localeCompare(right.path))
    return {
      root: ctx.fs.processPath(root), query, files, total, fileCount: files.length,
      scanned, skipped, truncated, tookMs: Date.now() - started,
    }
  }

  /** File-name lookup reads directory metadata only, including binary and large files. */
  async function findFiles(payload, signal) {
    const query = typeof payload?.query === 'string' ? payload.query.trim() : ''
    if (!query) fail('请输入文件名或相对路径。', 'SEARCH_EMPTY')
    if (query.length > MAX_QUERY) fail(`文件名搜索不能超过 ${MAX_QUERY} 个字符。`, 'SEARCH_TOO_LONG')
    const term = query.replace(/\\/gu, '/').toLowerCase()
    const root = await scopeFor(payload, signal), started = Date.now()
    const queue = [{ path: '', target: root }], matches = []
    let cursor = 0, scanned = 0, skipped = 0, visited = 0, truncated = false
    walk: while (cursor < queue.length) {
      signal.throwIfAborted()
      if (Date.now() - started > TIME_BUDGET) { truncated = true; break }
      const directory = queue[cursor++]
      let entries
      try { entries = await ctx.fs.listDir(directory.target, signal) }
      catch { signal.throwIfAborted(); skipped++; continue }
      for (const entry of entries) {
        signal.throwIfAborted()
        if (++visited > MAX_FILES_SCANNED || Date.now() - started > TIME_BUDGET || matches.length >= MAX_MATCH_FILES) {
          truncated = true; break walk
        }
        if (!ctx.fs.contains(root, entry.target)) { skipped++; continue }
        const path = directory.path ? `${directory.path}/${entry.name}` : entry.name
        if (entry.type === 'directory') {
          if (!SKIPPED_DIRS.has(entry.name)) queue.push({ path, target: entry.target })
        } else if (entry.type === 'file') {
          scanned++
          const name = entry.name.toLowerCase(), full = path.toLowerCase()
          if (name.includes(term) || full.includes(term)) matches.push({ path,
            rank: name === term ? 0 : name.startsWith(term) ? 1 : name.includes(term) ? 2 : 3 })
        }
      }
    }
    signal.throwIfAborted()
    matches.sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path))
    return { root: ctx.fs.processPath(root), query, files: matches.map(({ path }) => ({ path })),
      fileCount: matches.length, scanned, skipped, truncated, tookMs: Date.now() - started }
  }

  /** Replace inside exactly the files the current result list shows, never a fresh rescan. */
  async function replace(payload, signal) {
    const query = typeof payload?.query === 'string' ? payload.query : ''
    if (!query) fail('请输入要搜索的内容。', 'SEARCH_EMPTY')
    if (query.length > MAX_QUERY) fail(`搜索内容不能超过 ${MAX_QUERY} 个字符。`, 'SEARCH_TOO_LONG')
    if (typeof payload?.replacement !== 'string') fail('请填写替换内容。', 'SEARCH_INVALID_REPLACEMENT')
    if (payload.replacement.length > MAX_REPLACEMENT_CHARS)
      fail(`替换内容不能超过 ${MAX_REPLACEMENT_CHARS} 个字符。`, 'SEARCH_INVALID_REPLACEMENT')
    const matcher = buildMatcher({
      query,
      regex: payload?.regex === true,
      caseSensitive: payload?.caseSensitive === true,
    })
    const paths = [...new Set((Array.isArray(payload?.paths) ? payload.paths : [])
      .filter(path => typeof path === 'string' && path))]
    if (!paths.length) fail('没有要替换的文件。', 'SEARCH_EMPTY')
    if (paths.length > MAX_REPLACE_FILES) fail(`一次最多替换 ${MAX_REPLACE_FILES} 个文件。`, 'SEARCH_TOO_MANY_FILES')

    const root = await scopeFor(payload, signal)
    const rootDir = ctx.fs.processPath(root)
    const session = await sessionFor(payload.sessionId, signal)
    const policy = ctx.sandboxPolicy.resolve({ session })
    if (policy.mode === 'read-only') fail('只读模式下不能替换文件。', 'FS_SANDBOX_DENIED')
    const writable = policy.mode === 'workspace-write' && typeof writableRoots === 'function'
      ? await Promise.all(writableRoots(policy).map(path => ctx.fs.resolve(path, { signal })))
      : null
    // 编辑器里有未保存修改的文件由前端点名跳过：盘上替换成功也会被下一次保存覆盖。
    const dirty = new Set()
    for (const value of Array.isArray(payload?.skip) ? payload.skip : []) {
      if (typeof value !== 'string' || !value) continue
      try { dirty.add(ctx.fs.processPath(await ctx.fs.resolve(value, { cwd: rootDir, signal }))) }
      catch { dirty.add(value) }
    }

    const started = Date.now()
    const files = [], skipped = []
    let total = 0
    const skip = (path, reason) => skipped.push({ path, reason })

    for (const path of paths) {
      if (signal.aborted) break
      try {
        const target = await ctx.fs.resolve(path, { cwd: rootDir, signal })
        if (!ctx.fs.contains(root, target)) { skip(path, '不在当前文件夹里'); continue }
        if (dirty.has(ctx.fs.processPath(target))) { skip(path, '有未保存的修改'); continue }
        if (writable && !writable.some(directory => ctx.fs.contains(directory, target))) {
          skip(path, '在会话可写目录之外'); continue
        }
        const before = await ctx.fs.stat(target, signal)
        if (!before) { skip(path, '文件已不存在'); continue }
        if (before.type !== 'file') { skip(path, '只能替换普通文件'); continue }
        if (typeof before.size === 'number' && before.size > MAX_FILE_BYTES) { skip(path, '文件过大'); continue }
        const bytes = await ctx.fs.readBytes(target, signal, MAX_FILE_BYTES)
        const after = await ctx.fs.stat(target, signal)
        if (!after || after.version !== before.version) { skip(path, '读取时文件被改动'); continue }
        if (bytes.includes(0)) { skip(path, '二进制文件不能替换'); continue }
        let raw
        try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
        catch { skip(path, '不是 UTF-8 文本'); continue }
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(raw)) { skip(path, '二进制文件不能替换'); continue }
        const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : ''
        const body = bom ? raw.slice(1) : raw
        const changed = replaceText(body, matcher, payload.replacement, payload.regex === true)
        if (!changed.count) { skip(path, '文件已变化，没有匹配'); continue }
        const content = bom + changed.text
        if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) { skip(path, '替换后文件过大'); continue }
        await ctx.fs.writeText(target, content, { kind: 'replaceIfVersion', version: before.version }, signal, policy)
        files.push({ path, replacements: changed.count })
        total += changed.count
      } catch (error) {
        if (error?.code === 'SEARCH_INVALID_PATTERN') throw error
        skip(path, String(error?.message || error))
      }
    }

    return {
      root: rootDir, query, replacement: payload.replacement,
      files, fileCount: files.length, replacements: total, skipped, tookMs: Date.now() - started,
    }
  }

  async function call(operation, payload, signal) {
    const active = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    active.throwIfAborted()
    if (operation === 'find') return find(payload, active)
    if (operation === 'files') return findFiles(payload, active)
    if (operation === 'replace') return replace(payload, active)
    fail('不支持的搜索操作。', 'SEARCH_FAILED')
  }

  return { call, dispose() { lifetime.abort() } }
}
