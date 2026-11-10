/** Session-scoped Git operations for the built-in editor. */
import { isAbsolute } from 'node:path'

const MAX_OUTPUT = 256 * 1024
const MAX_STATUS = 400
const MAX_MESSAGE = 4000
const MAX_PATH = 1024

const TIMEOUT = { status: 20_000, stage: 30_000, unstage: 30_000, commit: 60_000, pull: 180_000, push: 300_000 }
const MUTATIONS = new Set(['stage', 'unstage', 'commit', 'pull', 'push'])

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

export function createVscodeGit(ctx, { FsError, writableRoots, subprocess }) {
  const lifetime = new AbortController()
  const running = new Set()
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

  async function run(argv, { cwd, signal, timeout }) {
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
        stdio: { stdin: 'ignore', stdout: { maxBytes: MAX_OUTPUT }, stderr: { maxBytes: MAX_OUTPUT } },
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

  async function assertWritable(session, root, signal) {
    const policy = ctx.sandboxPolicy.resolve({ session })
    if (!policy) return
    if (policy.mode === 'read-only') fail('只读模式下不能执行 Git 写操作。', 'FS_SANDBOX_DENIED')
    if (policy.mode !== 'workspace-write') return
    const target = await ctx.fs.resolve(root, { signal })
    const roots = await Promise.all(writableRoots(policy).map(path => ctx.fs.resolve(path, { signal })))
    if (!roots.some(candidate => ctx.fs.contains(candidate, target)))
      fail('Git 仓库位于会话可写目录之外，写操作已被拦截。', 'FS_SANDBOX_DENIED')
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

  async function call(operation, payload, signal) {
    if (operation !== 'status' && !MUTATIONS.has(operation)) fail('不支持的 Git 操作。', 'GIT_FAILED')
    const active = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    const task = (async () => {
      active.throwIfAborted()
      const { session, cwd } = await scopeFor(payload, active)
      if (operation === 'status') return readStatus(cwd, active)
      const root = await requireRoot({ signal: active, cwd })
      await assertWritable(session, root, active)
      const timeout = TIMEOUT[operation]

      if (operation === 'stage' || operation === 'unstage') {
        const paths = normalizePaths(payload?.paths)
        if (operation === 'stage') {
          await must(['git', 'add', '--', ...paths], { cwd: root, signal: active, timeout })
        } else {
          const result = await run(['git', 'reset', '-q', 'HEAD', '--', ...paths], { cwd: root, signal: active, timeout })
          if (result.code !== 0 && /ambiguous argument 'HEAD'/u.test(result.stderr)) {
            // 还没有第一个提交时 HEAD 不存在，改用从索引里移除
            await must(['git', 'rm', '--cached', '-q', '-r', '--', ...paths], { cwd: root, signal: active, timeout })
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
