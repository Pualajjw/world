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
      if (!match[0].length) { matcher.lastIndex++; continue }
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

export function createVscodeSearch(ctx, { FsError }) {
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

  async function call(operation, payload, signal) {
    if (operation !== 'find') fail('不支持的搜索操作。', 'SEARCH_FAILED')
    const active = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    active.throwIfAborted()
    return find(payload, active)
  }

  return { call, dispose() { lifetime.abort() } }
}
