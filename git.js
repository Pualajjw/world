/** Session-scoped Git operations for the built-in editor. */
import { isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { parseGitDiff } from './git-diff.js'

const MAX_OUTPUT = 256 * 1024
const MAX_STATUS = 400
const MAX_COMMITS = 20
const MAX_MESSAGE = 4000
const MAX_PATH = 1024

const TIMEOUT = { status: 20_000, diff: 20_000, stage: 30_000, unstage: 30_000, 'stage-hunk': 30_000, 'unstage-hunk': 30_000, discard: 30_000, commit: 60_000, pull: 180_000, push: 300_000 }
const MUTATIONS = new Set(['stage', 'unstage', 'stage-hunk', 'unstage-hunk', 'discard', 'commit', 'pull', 'push'])
const DIFF_OPTIONS = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--no-relative', '--unified=3', '--inter-hunk-context=0']

/** Split `git status --porcelain=v1 -z --branch` into a branch header and file entries. */
export function parseStatus(raw) {
  const records = raw.split('\0')
  const header = records[0]?.startsWith('## ') ? records.shift() : ''
  const files = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!record) continue
    const x = record[0], y = record[1]
    const path = record.slice(3)
    if (!path) continue
    let from = ''
    if (x === 'R' || x === 'C') { from = records[index + 1] ?? ''; index++ }
    const untracked = x === '?'
    const conflicted = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
    files.push({
      path, from, index: x, worktree: y, untracked, conflicted,
      staged: !untracked && x !== ' ',
      unstaged: !untracked && (y !== ' ' || conflicted),
    })
  }
  return { ...parseHeader(header), files }
}

function parseHeader(header) {
  const empty = { branch: '', upstream: '', ahead: 0, behind: 0, detached: false, unborn: false }
  if (!header) return empty
  const raw = header.slice(3).trim()
  if (raw.startsWith('HEAD (no branch)')) return { ...empty, branch: 'HEAD', detached: true }
  if (raw.startsWith('No commits yet on ')) return { ...empty, branch: raw.slice(18).trim(), unborn: true }
  const dots = raw.indexOf('...')
  const branch = dots >= 0 ? raw.slice(0, dots) : raw.replace(/ \[.*$/u, '')
  const rest = dots >= 0 ? raw.slice(dots + 3) : ''
  const bracket = rest.indexOf('[')
  const upstream = (bracket >= 0 ? rest.slice(0, bracket) : rest).trim()
  const tail = bracket >= 0 ? rest.slice(bracket) : ''
  return {
    branch, upstream, detached: false, unborn: false,
    ahead: Number(/ahead (\d+)/u.exec(tail)?.[1] ?? 0),
    behind: Number(/behind (\d+)/u.exec(tail)?.[1] ?? 0),
  }
}

/** The most informative single line of a failed git command. */
export function gitFailure(stderr, stdout) {
  const lines = String(stderr || '').replace(/\r/gu, '').split('\n').map(line => line.trim()).filter(Boolean)
  const notable = [...lines].reverse().find(line => /^(fatal|error|warning):/u.test(line)) ?? lines.at(-1)
  if (notable) return notable.replace(/^(fatal|error):\s*/u, '')
  return String(stdout || '').replace(/\r/gu, '').trim().split('\n').filter(Boolean).at(-1) || 'Git 命令执行失败。'
}

export function createVscodeGit(ctx, { FsError, subprocess }) {
  const lifetime = new AbortController()
  const running = new Set()
  const mutating = new Set()
  const fail = (message, code = 'GIT_FAILED') => { throw new FsError(message, code) }

  async function sessionFor(id, signal) {
    const live = ctx.sessions.get(id)
    if (live) return live
    const persistence = ctx.get('sessionPersistence')
    if (!persistence) fail('重新打开会话后才能使用 Git。', 'GIT_NO_SESSION')
    const handle = await persistence.open(id, 'read', { signal })
    try {
      const { events, eventState } = await handle.read(0, undefined, { signal })
      return ctx.sessions.get(id) ?? ctx.sessions.prepare(id, {
        seed: events, meta: handle.header, inheritedEventCount: handle.inheritedEventCount, eventState,
      })
    } finally { await handle.close() }
  }

  async function run(argv, { cwd, signal, timeout, input }) {
    const active = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    active.throwIfAborted()
    let timedOut = false
    let handle
    try {
      handle = subprocess.spawn({
        argv, cwd, signal: active, graceMs: 1500,
        // Never block on a terminal or a credential dialog: a headless window cannot answer either.
        env: {
          GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_PAGER: 'cat',
          GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C',
        },
        stdio: { stdin: input === undefined ? 'ignore' : { data: input }, stdout: { maxBytes: MAX_OUTPUT }, stderr: { maxBytes: MAX_OUTPUT } },
      })
    } catch (error) {
      fail(`无法启动 git：${String(error?.message || error)}`, 'GIT_UNAVAILABLE')
    }
    running.add(handle)
    const timer = setTimeout(() => { timedOut = true; handle.terminate() }, timeout)
    try {
      const result = await handle.done
      return {
        code: result.exitCode, signal: result.signal,
        stdout: handle.collected.stdout.readFrom(0).text,
        stderr: handle.collected.stderr.readFrom(0).text,
        lossy: handle.collected.stdout.readFrom(0).lossy,
        timedOut,
      }
    } finally {
      clearTimeout(timer)
      handle.terminate()
      await handle.waitForExit()
      running.delete(handle)
    }
  }

  /** Run a command that must succeed, or fail with git's own wording. */
  async function must(argv, options) {
    const result = await run(argv, options)
    if (result.signal || result.timedOut) fail(`Git 命令超时（${Math.round((options.timeout ?? 0) / 1000)}s）。`, 'GIT_TIMEOUT')
    if (result.code !== 0) fail(gitFailure(result.stderr, result.stdout), 'GIT_FAILED')
    return result
  }

  /** The folder this window has open, falling back to the session workspace. */
  async function scopeFor(payload, signal) {
    if (!payload || typeof payload.sessionId !== 'string' || !payload.sessionId)
      fail('先打开一个会话再使用 Git。', 'GIT_NO_SESSION')
    const session = await sessionFor(payload.sessionId, signal)
    if (!session) fail('重新打开会话后才能使用 Git。', 'GIT_NO_SESSION')
    const cwd = session.header?.cwd
    const requested = typeof payload.root === 'string' && payload.root ? payload.root : ''
    if (!requested && !cwd) fail('这个会话还没有工作目录。', 'GIT_NO_WORKSPACE')
    const target = await ctx.fs.resolve(requested || cwd, { cwd, signal })
    const info = await ctx.fs.stat(target, signal)
    if (!info) fail('这个文件夹不存在。', 'GIT_NO_WORKSPACE')
    if (info.type !== 'directory') fail('只能对文件夹使用 Git。', 'GIT_NO_WORKSPACE')
    return { session, cwd: ctx.fs.processPath(target) }
  }

  /** Repo root + path from the root down to the working directory, or null outside a repository. */
  async function findRoot({ signal, cwd }) {
    const result = await run(['git', 'rev-parse', '--show-toplevel', '--show-prefix'], { cwd, signal, timeout: TIMEOUT.status })
    if (result.signal || result.timedOut) fail('读取 Git 仓库信息超时。', 'GIT_TIMEOUT')
    if (result.code !== 0) return null
    const [root = '', prefix = ''] = result.stdout.replace(/\r/gu, '').split('\n')
    if (!root.trim()) return null
    return { root: root.trim().replace(/\\/gu, '/'), prefix: prefix.trim().replace(/\\/gu, '/') }
  }

  /**
   * 只读模式仍然拦住写操作。其余情况不再自己判「仓库根必须在会话可写目录内」：
   *
   * git 是宿主 subprocess 跑的，真正的写入边界由它的沙箱策略决定 —— 越界时 git 会直接
   * 报 permission denied，原因清楚。业务层拿仓库根再判一次，只会在「工作区是仓库的子
   * 目录」这种最常见的情况下误拦：仓库根在会话工作区的上一层，而 .git 本身完全可写。
   * 用户打开的就是自己的盘，能不能写由文件系统说了算，不由会话工作目录推算。
   */
  async function assertWritable(session) {
    const policy = ctx.sandboxPolicy.resolve({ session })
    if (policy?.mode === 'read-only') fail('只读模式下不能执行 Git 写操作。', 'FS_SANDBOX_DENIED')
  }

  /** Reject anything that could escape the repository or act as a pathspec magic. */
  function normalizePaths(value) {
    if (!Array.isArray(value) || value.length === 0) fail('请先选择要操作的文件。', 'GIT_INVALID_PATH')
    if (value.length > 2000) fail('一次操作的文件过多。', 'GIT_INVALID_PATH')
    return value.map(item => {
      if (typeof item !== 'string' || !item || item.length > MAX_PATH) fail('文件路径无效。', 'GIT_INVALID_PATH')
      if (item.includes('\0')) fail('文件路径无效。', 'GIT_INVALID_PATH')
      const path = item.replace(/\\/gu, '/').replace(/^\.\//u, '')
      if (path.startsWith('/') || isAbsolute(path) || /^[a-zA-Z]:/u.test(path)) fail('文件路径必须是仓库内的相对路径。', 'GIT_INVALID_PATH')
      if (path.split('/').includes('..')) fail('文件路径不能跳出仓库。', 'GIT_INVALID_PATH')
      if (path.startsWith(':')) fail('文件路径无效。', 'GIT_INVALID_PATH')
      return path
    })
  }

  /** 一个文件的 unified patch：已暂存看索引、工作区看磁盘、未跟踪与 /dev/null 对比。 */
  async function readDiff(root, payload, signal) {
    const paths = normalizePaths(payload?.paths)
    if (paths.length > 2) fail('一次只能查看一个文件的 Diff。', 'GIT_INVALID_PATH')
    const staged = payload?.staged === true
    const untracked = !staged && payload?.untracked === true
    let result
    if (untracked) {
      if (paths.length !== 1) fail('一次只能查看一个文件的 Diff。', 'GIT_INVALID_PATH')
      // --no-index 把未跟踪文件当成「从空文件新增」；有差异时退出码是 1，不是失败
      result = await run(['git', '--literal-pathspecs', 'diff', '--no-index', ...DIFF_OPTIONS, '--', '/dev/null', paths[0]],
        { cwd: root, signal, timeout: TIMEOUT.diff })
      if (result.signal || result.timedOut) fail('读取 Diff 超时。', 'GIT_TIMEOUT')
      if (result.code !== 0 && result.code !== 1) fail(gitFailure(result.stderr, result.stdout), 'GIT_FAILED')
    } else {
      result = await run(['git', '--literal-pathspecs', 'diff', ...(staged ? ['--cached'] : []), ...DIFF_OPTIONS, '--', ...paths],
        { cwd: root, signal, timeout: TIMEOUT.diff })
      if (result.signal || result.timedOut) fail('读取 Diff 超时。', 'GIT_TIMEOUT')
      if (result.code !== 0) fail(gitFailure(result.stderr, result.stdout), 'GIT_FAILED')
    }
    const patch = result.stdout, parsed = parseGitDiff(patch)
    return {
      paths, staged, untracked,
      patch,
      snapshot: createHash('sha256').update(JSON.stringify({ paths, staged, patch })).digest('hex'),
      canStageHunks: !result.lossy && !untracked && parsed.canApply,
      hunkCount: parsed.hunks.length,
      truncated: Boolean(result.lossy),
    }
  }

  /**
   * Current HEAD only, in Git date order (descendants before ancestors), at most 20.
   * body is %B: the complete message INCLUDING its subject and original newlines.
   * author is the author name; date is the committer's strict ISO 8601 timestamp.
   * Never expose partial records: a lossy subprocess buffer invalidates the batch.
   */
  async function readLog(root, signal) {
    const options = { cwd: root, signal, timeout: TIMEOUT.status }
    const head = await run(['git', 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], options)
    if (head.signal || head.timedOut) fail('读取 Git 历史超时。', 'GIT_TIMEOUT')
    if (head.code !== 0) {
      const status = await must(['git', 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=no'], options)
      if (parseStatus(status.stdout).unborn) return { commits: [], truncated: false }
      fail(gitFailure(head.stderr, head.stdout), 'GIT_FAILED')
    }
    // Pin HEAD once, so concurrent branch switches cannot change this request.
    const revision = head.stdout.trim()
    if (head.lossy || !/^[a-f0-9]{40,64}$/u.test(revision)) fail('无法读取 Git HEAD。', 'GIT_FAILED')
    const result = await must(['git', '-c', 'i18n.logOutputEncoding=UTF-8', 'log',
      '--no-show-signature', '--no-notes', '--no-decorate', '--date-order', '-z',
      '--max-count=' + (MAX_COMMITS + 1), '--format=%H%x00%h%x00%s%x00%B%x00%an%x00%cI', revision, '--'], options)
    // A capped host buffer may retain a prefix OR suffix; never guess alignment.
    if (result.lossy || Buffer.byteLength(result.stdout, 'utf8') > MAX_OUTPUT)
      return { commits: [], truncated: true }
    const fields = result.stdout.split('\0')
    if (fields.pop() !== '' || fields.length % 6 !== 0) fail('Git 历史记录不完整。', 'GIT_FAILED')
    const commits = []
    for (let index = 0; index < fields.length; index += 6) {
      const [hash, shortHash, subject, body, author, date] = fields.slice(index, index + 6)
      if (!/^[a-f0-9]{40,64}$/u.test(hash) || !/^[a-f0-9]+$/u.test(shortHash) || !Number.isFinite(Date.parse(date)))
        fail('Git 历史记录无效。', 'GIT_FAILED')
      commits.push({ hash, shortHash, subject, body, author, date })
    }
    return { commits: commits.slice(0, MAX_COMMITS), truncated: commits.length > MAX_COMMITS }
  }

  async function readStatus(cwd, signal) {
    const repo = await findRoot({ signal, cwd })
    if (!repo) {
      return {
        repo: false, root: '', branch: '', upstream: '', ahead: 0, behind: 0, detached: false, unborn: false,
        files: [], staged: 0, changed: 0, remotes: [], identity: null, truncated: false,
        message: '当前工作目录不在 Git 仓库中。',
      }
    }
    const { root, prefix } = repo
    const status = await must(['git', 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'],
      { cwd: root, signal, timeout: TIMEOUT.status })
    const parsed = parseStatus(status.stdout)
    const remotes = (await run(['git', 'remote'], { cwd: root, signal, timeout: TIMEOUT.status }))
      .stdout.replace(/\r/gu, '').split('\n').map(name => name.trim()).filter(Boolean)
    const config = await run(['git', 'config', '--get-regexp', '^user\\.(name|email)$'], { cwd: root, signal, timeout: TIMEOUT.status })
    const identity = { name: '', email: '' }
    for (const line of config.stdout.replace(/\r/gu, '').split('\n')) {
      const match = /^user\.(name|email)\s+(.*)$/u.exec(line.trim())
      if (match) identity[match[1]] = match[2]
    }
    const truncated = parsed.files.length > MAX_STATUS
    const files = parsed.files.slice(0, MAX_STATUS).map(file => ({
      ...file,
      open: openablePath(prefix, file.path),
    }))
    const staged = files.filter(file => file.staged && !file.conflicted).length
    const conflicted = files.filter(file => file.conflicted).length
    return {
      repo: true, root, branch: parsed.branch, upstream: parsed.upstream,
      ahead: parsed.ahead, behind: parsed.behind, detached: parsed.detached, unborn: parsed.unborn,
      files, staged, conflicted, changed: files.length - staged,
      remotes, identity: { ...identity, ok: Boolean(identity.name && identity.email) }, truncated,
      message: '',
    }
  }

  /**
   * Repo-relative name → workspace-relative name the editor can open.
   * `prefix` comes from `git rev-parse --show-prefix`, so this never depends on how the
   * host spells the workspace path (8.3 short names, symlinks, drive casing).
   */
  function openablePath(prefix, path) {
    if (!prefix) return path
    return path.startsWith(prefix) ? path.slice(prefix.length) : ''
  }

  async function requireRoot({ signal, cwd }) {
    const repo = await findRoot({ signal, cwd })
    if (!repo) fail('当前工作目录不在 Git 仓库中。', 'GIT_NO_REPO')
    return repo.root
  }

  async function upstreamOf(root, signal) {
    const result = await run(['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      { cwd: root, signal, timeout: TIMEOUT.status })
    return result.code === 0 ? result.stdout.replace(/\r/gu, '').trim() : ''
  }

  async function commitInfo(root, hash, signal) {
    if (typeof hash !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/u.test(hash)) fail('提交 Hash 无效。', 'GIT_INVALID_COMMIT')
    const result = await must(['git', 'rev-list', '--parents', '-n', '1', hash, '--'], { cwd: root, signal, timeout: TIMEOUT.status })
    const [commit, ...parents] = result.stdout.trim().split(' ')
    if (result.lossy || commit !== hash || parents.some(parent => !/^(?:[a-f\d]{40}|[a-f\d]{64})$/u.test(parent)))
      fail('提交记录无效或不完整。', 'GIT_INVALID_COMMIT')
    return { commit, parent: parents[0] || null, merge: parents.length > 1 }
  }

  async function commitFiles(root, payload, signal) {
    const info = await commitInfo(root, payload.commit, signal)
    const argv = info.parent ? ['git', 'diff', '--name-status', '-z', '--find-renames', info.parent, info.commit, '--']
      : ['git', 'diff-tree', '--root', '--no-commit-id', '-r', '--name-status', '-z', '--find-renames', info.commit, '--']
    const result = await must(argv, { cwd: root, signal, timeout: TIMEOUT.diff })
    if (result.lossy) return { ...info, files: [], truncated: true }
    const fields = result.stdout.split('\0'), files = []
    if (fields.pop() !== '') fail('提交文件列表不完整。', 'GIT_FAILED')
    for (let i = 0; i < fields.length;) {
      const status = fields[i++], first = fields[i++], moved = /^[RC]\d*$/u.test(status)
      const path = moved ? fields[i++] : first
      if (!/^[ACDMRTUXB]\d*$/u.test(status) || !first || !path) fail('提交文件列表不完整。', 'GIT_FAILED')
      files.push({ path, from: moved ? first : '', status: status[0] })
    }
    return { ...info, files: files.slice(0, MAX_STATUS), truncated: files.length > MAX_STATUS }
  }

  async function commitDiff(root, payload, signal) {
    const paths = normalizePaths(payload.paths)
    if (paths.length > 2) fail('一次只能查看一个文件的 Diff。', 'GIT_INVALID_PATH')
    const info = await commitInfo(root, payload.commit, signal)
    const argv = info.parent ? ['git', '--literal-pathspecs', 'diff', ...DIFF_OPTIONS, '--find-renames', info.parent, info.commit, '--', ...paths]
      : ['git', '--literal-pathspecs', 'diff-tree', '--root', '--no-commit-id', '-r', '-p', ...DIFF_OPTIONS, '--find-renames', info.commit, '--', ...paths]
    const result = await must(argv, { cwd: root, signal, timeout: TIMEOUT.diff })
    return { ...info, paths, patch: result.stdout, truncated: Boolean(result.lossy), canStageHunks: false }
  }

  async function discardPlan(root, payload, signal) {
    const paths = [...new Set(normalizePaths(payload.paths))]
    const options = { cwd: root, signal, timeout: TIMEOUT.discard }
    const status = await must(['git', '--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths], options)
    if (status.lossy) fail('文件状态过多，请减少选择后重试。', 'GIT_STALE_DIFF')
    const files = parseStatus(status.stdout).files
    const selected = paths.map(path => files.find(file => file.path === path))
    if (selected.some(file => !file || file.conflicted || (!file.untracked && !file.unstaged)))
      fail('文件状态已变化或包含冲突，请刷新后重试；冲突文件需先解决冲突。', 'GIT_STALE_DIFF')
    const index = await must(['git', '--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...paths], options)
    if (index.lossy) fail('暂存区状态过长，请减少选择后重试。', 'GIT_STALE_DIFF')
    const entries = []
    for (const file of selected) {
      const entry = await ctx.fs.lstat(join(root, file.path), { cwd: root }, signal)
      if ((entry && (!entry.version || !['file', 'symlink'].includes(entry.type))) || (!entry && file.worktree !== 'D'))
        fail('文件状态已变化，不能放弃更改。', 'GIT_STALE_DIFF')
      entries.push([file.path, file.index, file.worktree, entry?.type, entry?.version])
    }
    const snapshot = createHash('sha256').update(JSON.stringify([root, payload.sessionId, index.stdout, entries])).digest('hex')
    return { snapshot, files: selected.map(file => ({ path: file.path, removed: file.untracked })) }
  }

  async function discard(root, payload, signal) {
    if (payload.confirmed !== true) fail('放弃更改需要先确认。', 'GIT_CONFIRM_REQUIRED')
    const { snapshot, files } = await discardPlan(root, payload, signal)
    if (snapshot !== payload.snapshot) fail('文件或暂存区在确认前后发生了变化，未放弃更改。请刷新后重新确认。', 'GIT_STALE_DIFF')
    const options = { cwd: root, signal, timeout: TIMEOUT.discard }
    const tracked = files.filter(file => !file.removed).map(file => file.path)
    const untracked = files.filter(file => file.removed).map(file => file.path)
    if (tracked.length) await must(['git', '--literal-pathspecs', 'restore', '--worktree', '--', ...tracked], options)
    // Only exact untracked file paths from status; no directory, ignored-file or nested-repo deletion flags.
    if (untracked.length) await must(['git', '--literal-pathspecs', 'clean', '-f', '--', ...untracked], options)
    return { discarded: files }
  }

  async function call(operation, payload, signal) {
    if (!['status', 'diff', 'log', 'commit-files', 'commit-diff', 'prepare-discard'].includes(operation) && !MUTATIONS.has(operation)) fail('不支持的 Git 操作。', 'GIT_FAILED')
    const active = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    const task = (async () => {
      active.throwIfAborted()
      const { session, cwd } = await scopeFor(payload, active)
      if (operation === 'status') return readStatus(cwd, active)
      const root = await requireRoot({ signal: active, cwd })
      // Diff 是只读的：只读模式下也能看，不经过 assertWritable
      if (operation === 'diff') return readDiff(root, payload, active)
      if (operation === 'log') return readLog(root, active)
      if (operation === 'commit-files') return commitFiles(root, payload, active)
      if (operation === 'commit-diff') return commitDiff(root, payload, active)
      await assertWritable(session)
      if (operation === 'prepare-discard') return discardPlan(root, payload, active)
      if (mutating.has(root)) fail('该仓库有 Git 操作正在执行，请稍后重试。', 'GIT_BUSY')
      mutating.add(root)
      try {
      const timeout = TIMEOUT[operation]

      if (operation === 'stage-hunk' || operation === 'unstage-hunk') {
        const paths = normalizePaths(payload.paths)
        if (paths.length !== 1) fail('一次只能操作一个文件的更改块。', 'GIT_INVALID_PATH')
        const staged = operation === 'unstage-hunk'
        const diff = await readDiff(root, { paths, staged }, active)
        if (typeof payload.snapshot !== 'string' || payload.snapshot !== diff.snapshot)
          fail('差异已变化，请刷新 Diff 后重试，未修改暂存区。', 'GIT_STALE_DIFF')
        const input = diff.canStageHunks && parseGitDiff(diff.patch).hunkPatch(payload.hunk, staged)
        if (!input) fail('这个差异不能逐块操作，请使用整文件暂存或取消暂存。', 'GIT_HUNK_UNSUPPORTED')
        const argv = ['git', 'apply', '--cached', '--whitespace=nowarn', ...(staged ? ['--reverse'] : [])]
        await must([...argv, '--check', '-'], { cwd: root, signal: active, timeout, input })
        await must([...argv, '-'], { cwd: root, signal: active, timeout, input })
        return { status: await readStatus(cwd, active), output: '' }
      }
      if (operation === 'discard') return { ...await discard(root, payload, active), status: await readStatus(cwd, active), output: '' }

      if (operation === 'stage' || operation === 'unstage') {
        const paths = [...new Set(normalizePaths(payload?.paths))]
        // Large multi-directory selections can exceed the Windows command-line limit.
        const batch = paths.length > 1
        const args = batch ? ['--pathspec-from-file=-', '--pathspec-file-nul'] : ['--', ...paths]
        const options = { cwd: root, signal: active, timeout, ...(batch ? { input: paths.join('\0') + '\0' } : {}) }
        if (operation === 'stage') {
          await must(['git', '--literal-pathspecs', 'add', ...args], options)
        } else {
          const result = await run(['git', '--literal-pathspecs', 'reset', '-q', 'HEAD', ...args], options)
          if (result.code !== 0 && /ambiguous argument 'HEAD'/u.test(result.stderr)) {
            // 还没有第一个提交时 HEAD 不存在，改用从索引里移除
            await must(['git', '--literal-pathspecs', 'rm', '--cached', '-q', '-r', ...args], options)
          } else if (result.code !== 0) {
            fail(gitFailure(result.stderr, result.stdout), 'GIT_FAILED')
          }
        }
        return { status: await readStatus(cwd, active), output: '' }
      }

      if (operation === 'commit') {
        const message = String(payload?.message ?? '').replace(/\r\n?/gu, '\n').trim()
        if (!message) fail('提交信息不能为空。', 'GIT_EMPTY_MESSAGE')
        if (message.length > MAX_MESSAGE) fail('提交信息过长。', 'GIT_EMPTY_MESSAGE')
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(message)) fail('提交信息含有控制字符。', 'GIT_EMPTY_MESSAGE')
        const result = await run(['git', 'commit', '-m', message], { cwd: root, signal: active, timeout })
        if (result.signal || result.timedOut) fail('提交超时。', 'GIT_TIMEOUT')
        if (result.code !== 0) {
          const detail = gitFailure(result.stderr, result.stdout)
          if (/nothing (added to commit|to commit)/iu.test(result.stdout + result.stderr))
            fail('没有已暂存的更改，先暂存文件再提交。', 'GIT_NOTHING_STAGED')
          if (/Please tell me who you are|Author identity unknown/iu.test(result.stderr))
            fail('尚未配置 Git 身份，请先设置 user.name 和 user.email。', 'GIT_NO_IDENTITY')
          fail(detail, 'GIT_FAILED')
        }
        // 提交输出的第一行是 `[main 1a2b3c4] 标题`，比末尾的统计行更值得回显
        return { status: await readStatus(cwd, active), output: firstLine(result.stdout) }
      }

      if (operation === 'pull') {
        if (!await upstreamOf(root, active)) fail('当前分支没有上游分支，无法拉取。', 'GIT_NO_UPSTREAM')
        const result = await run(['git', '-c', 'pull.rebase=false', 'pull', '--no-edit'], { cwd: root, signal: active, timeout })
        if (result.signal || result.timedOut) fail('拉取超时。', 'GIT_TIMEOUT')
        if (result.code !== 0) fail(gitFailure(result.stderr, result.stdout), 'GIT_FAILED')
        return { status: await readStatus(cwd, active), output: lastLines(result.stdout) }
      }

      if (operation === 'push') {
        const tracked = await upstreamOf(root, active)
        const argv = tracked ? ['git', 'push'] : ['git', 'push', '-u', 'origin', 'HEAD']
        const result = await run(argv, { cwd: root, signal: active, timeout })
        if (result.signal || result.timedOut) fail('推送超时。', 'GIT_TIMEOUT')
        if (result.code !== 0) {
          const detail = gitFailure(result.stderr, result.stdout)
          if (/No configured push destination|does not appear to be a git repository/iu.test(result.stderr))
            fail('没有配置可推送的远端仓库。', 'GIT_NO_REMOTE')
          if (/Authentication failed|could not read Username|Permission denied/iu.test(result.stderr))
            fail('推送需要凭据，请先在终端里登录一次远端仓库。', 'GIT_AUTH')
          fail(detail, 'GIT_FAILED')
        }
        return { status: await readStatus(cwd, active), output: lastLines(result.stderr || result.stdout) }
      }

      fail('不支持的 Git 操作。', 'GIT_FAILED')
      } finally { mutating.delete(root) }
    })()
    return task
  }

  return {
    call,
    async dispose() {
      lifetime.abort()
      await Promise.allSettled([...running].map(handle => handle.waitForExit()))
    },
  }
}

function lastLines(text, count = 3) {
  return String(text || '').replace(/\r/gu, '').split('\n').map(line => line.trim()).filter(Boolean).slice(-count).join('\n')
}

function firstLine(text) {
  return String(text || '').replace(/\r/gu, '').split('\n').map(line => line.trim()).filter(Boolean)[0] ?? ''
}
