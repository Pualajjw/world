/** The built-in Git panel only touches repositories inside the session workspace. */
import assert from 'node:assert/strict'
import { spawn as spawnProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import { registerHooks } from 'node:module'
import { createVscodeGit, gitFailure, parseStatus } from '../git.js'

const harness = process.env.DSH_SOURCE ?? 'E:/deepseek-harness'
const modules = {
  '@deepseek-ai/dsh-fs': 'packages/fs/fs/lib/index.js',
  '@deepseek-ai/dsh-sandbox': 'packages/sandbox/sandbox/lib/index.js',
}
const hooks = registerHooks({ resolve(name, context, next) {
  return modules[name] ? { url: pathToFileURL(join(harness, modules[name])).href, shortCircuit: true } : next(name, context)
} })
const load = path => import(pathToFileURL(join(harness, path)))
const { Context } = await load('vendor/cordis/lib/index.js')
const { default: LocalFs } = await load('packages/fs/fs-local/lib/index.js')
const { FsError } = await load('packages/fs/fs/lib/index.js')
const { writableRoots } = await load('packages/sandbox/sandbox/lib/index.js')

/** Same contract as the Host subprocess service, backed by node:child_process. */
function createSubprocess() {
  return {
    spawn(spec) {
      const child = spawnProcess(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(spec.env ?? {}) },
      })
      // Decode only after collection: UTF-8 codepoints may cross pipe chunks.
      const collect = (stream, maxBytes) => {
        let bytes = Buffer.alloc(0), lossy = false
        stream?.on('data', chunk => {
          const combined = Buffer.concat([bytes, chunk])
          lossy ||= combined.length > maxBytes
          bytes = combined.subarray(0, maxBytes)
        })
        return { readFrom: () => ({ text: bytes.toString('utf8'), lossy }) }
      }
      const stdout = collect(child.stdout, spec.stdio.stdout.maxBytes)
      const stderr = collect(child.stderr, spec.stdio.stderr.maxBytes)
      const done = new Promise(resolve => {
        child.on('error', error => resolve({ exitCode: null, signal: 'error', error }))
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
      })
      const handle = {
        done,
        collected: {
          stdout, stderr,
        },
        terminate() { if (!child.killed) child.kill() },
        waitForExit: () => done.then(() => {}, () => {}),
      }
      if (spec.signal) spec.signal.addEventListener('abort', () => handle.terminate(), { once: true })
      return handle
    },
  }
}

const git = (argv, env = {}) => new Promise(resolve => {
  const child = spawnProcess('git', argv, { windowsHide: true, stdio: 'ignore', env: { ...process.env, ...env } })
  child.on('close', code => resolve(code))
})

test('status parsing keeps index/worktree letters, renames and upstream counts', () => {
  const parsed = parseStatus([
    '## main...origin/main [ahead 2, behind 1]',
    'M  staged.js',
    ' M dirty.js',
    'AM both.js',
    '?? new.txt',
    'R  renamed.js',
    'old.js',
    'UD conflict.txt',
    '',
  ].join('\0'))
  assert.equal(parsed.branch, 'main')
  assert.equal(parsed.upstream, 'origin/main')
  assert.equal(parsed.ahead, 2)
  assert.equal(parsed.behind, 1)
  assert.deepEqual(parsed.files.map(file => file.path),
    ['staged.js', 'dirty.js', 'both.js', 'new.txt', 'renamed.js', 'conflict.txt'])
  const [staged, dirty, both, untracked, renamed, conflict] = parsed.files
  assert.deepEqual([staged.staged, staged.unstaged], [true, false])
  assert.deepEqual([dirty.staged, dirty.unstaged], [false, true])
  assert.deepEqual([both.staged, both.unstaged], [true, true])
  assert.equal(untracked.untracked, true)
  assert.equal(untracked.staged, false)
  assert.equal(renamed.from, 'old.js')
  assert.equal(conflict.conflicted, true)
  assert.equal(gitFailure('fatal: not a git repository\n'), 'not a git repository')
})

test('git service stages, commits and guards its inputs', async t => {
  // 必须建在任何仓库之外，否则 rev-parse 会往上找到宿主仓库
  const workspace = await mkdtemp(join(tmpdir(), 'world-git-'))
  const context = new Context()
  await context.plugin(LocalFs, { cwd: workspace })
  const session = { header: { cwd: workspace } }
  let mode = 'workspace-write'
  const service = createVscodeGit({
    fs: context.fs,
    sessions: { get: id => id === 'session' ? session : undefined },
    get: () => undefined,
    sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: workspace }) },
  }, { FsError, writableRoots, subprocess: createSubprocess() })
  t.after(async () => {
    await service.dispose()
    await context.fiber.dispose()
    await rm(workspace, { recursive: true, force: true })
  })

  // 没有仓库时 status 不报错，只说明情况
  const empty = await service.call('status', { sessionId: 'session' })
  assert.equal(empty.repo, false)
  assert.deepEqual(empty.files, [])

  assert.equal(await git(['init', '-b', 'main', workspace]), 0)
  assert.equal(await git(['-C', workspace, 'config', 'user.name', 'World Test']), 0)
  assert.equal(await git(['-C', workspace, 'config', 'user.email', 'world@example.invalid']), 0)
  await writeFile(join(workspace, 'a.txt'), 'a\n')
  await mkdir(join(workspace, 'sub'))
  await writeFile(join(workspace, 'sub', 'b.txt'), 'b\n')

  const dirty = await service.call('status', { sessionId: 'session' })
  assert.equal(dirty.repo, true)
  assert.equal(dirty.branch, 'main')
  assert.equal(dirty.unborn, true)
  assert.deepEqual(dirty.files.map(file => file.path).sort(), ['a.txt', 'sub/b.txt'])
  assert.equal(dirty.files.find(file => file.path === 'sub/b.txt').open, 'sub/b.txt')
  assert.equal(dirty.identity.ok, true)
  assert.equal(dirty.staged, 0)

  const staged = await service.call('stage', { sessionId: 'session', paths: ['a.txt'] })
  assert.equal(staged.status.staged, 1)
  assert.equal(staged.status.files.find(file => file.path === 'a.txt').staged, true)

  const unstageAgain = await service.call('unstage', { sessionId: 'session', paths: ['a.txt'] })
  assert.equal(unstageAgain.status.staged, 0)

  await assert.rejects(service.call('commit', { sessionId: 'session', message: '   ' }), { code: 'GIT_EMPTY_MESSAGE' })
  await assert.rejects(service.call('commit', { sessionId: 'session', message: 'nothing staged' }), { code: 'GIT_NOTHING_STAGED' })

  await service.call('stage', { sessionId: 'session', paths: ['a.txt', 'sub/b.txt'] })
  const committed = await service.call('commit', { sessionId: 'session', message: '初始提交' })
  assert.equal(committed.status.files.length, 0)
  assert.match(committed.output, /初始提交/u)

  // 工作区外的路径、路径魔法、越界都必须在到达 git 之前被拦下
  await assert.rejects(service.call('stage', { sessionId: 'session', paths: ['../outside.txt'] }), { code: 'GIT_INVALID_PATH' })
  await assert.rejects(service.call('stage', { sessionId: 'session', paths: ['E:/Windows/win.ini'] }), { code: 'GIT_INVALID_PATH' })
  await assert.rejects(service.call('stage', { sessionId: 'session', paths: [':(exclude)*'] }), { code: 'GIT_INVALID_PATH' })
  await assert.rejects(service.call('stage', { sessionId: 'session', paths: [] }), { code: 'GIT_INVALID_PATH' })

  // 没有上游分支：拉取/推送给出明确原因，而不是让 git 自己报英文错
  await assert.rejects(service.call('pull', { sessionId: 'session' }), { code: 'GIT_NO_UPSTREAM' })
  const pushed = await service.call('push', { sessionId: 'session' }).then(() => '', error => error.code)
  assert.equal(pushed, 'GIT_NO_REMOTE')

  await writeFile(join(workspace, 'c.txt'), 'c\n')
  mode = 'read-only'
  await assert.rejects(service.call('stage', { sessionId: 'session', paths: ['c.txt'] }), { code: 'FS_SANDBOX_DENIED' })
  mode = 'workspace-write'
  assert.equal((await service.call('status', { sessionId: 'session' })).files.length, 1)

  // Diff：未跟踪按整份新增、工作区看磁盘、已暂存看索引，且只读模式下仍然可看
  const untrackedDiff = await service.call('diff', { sessionId: 'session', paths: ['c.txt'], untracked: true })
  assert.equal(untrackedDiff.untracked, true)
  assert.match(untrackedDiff.patch, /^\+\+\+ b\/c\.txt$/mu)
  assert.match(untrackedDiff.patch, /^\+c$/mu)

  await writeFile(join(workspace, 'a.txt'), 'a changed\n')
  const workDiff = await service.call('diff', { sessionId: 'session', paths: ['a.txt'] })
  assert.equal(workDiff.staged, false)
  assert.match(workDiff.patch, /^-a$/mu)
  assert.match(workDiff.patch, /^\+a changed$/mu)

  await service.call('stage', { sessionId: 'session', paths: ['a.txt'] })
  const indexDiff = await service.call('diff', { sessionId: 'session', paths: ['a.txt'], staged: true })
  assert.equal(indexDiff.staged, true)
  assert.match(indexDiff.patch, /^\+a changed$/mu)
  assert.equal((await service.call('diff', { sessionId: 'session', paths: ['a.txt'] })).patch, '')

  mode = 'read-only'
  assert.match((await service.call('diff', { sessionId: 'session', paths: ['a.txt'], staged: true })).patch, /^\+a changed$/mu)
  mode = 'workspace-write'

  // 打开子文件夹：Git 在子目录里运行，能打开的文件路径相对子文件夹，仓库根的同级文件不能打开
  await writeFile(join(workspace, 'sub', 'b.txt'), 'b changed\n')
  const scoped = await service.call('status', { sessionId: 'session', root: join(workspace, 'sub') })
  assert.equal(scoped.repo, true)
  assert.equal(scoped.files.find(file => file.path === 'sub/b.txt').open, 'b.txt')
  assert.equal(scoped.files.find(file => file.path === 'c.txt').open, '')
  await assert.rejects(service.call('status', { sessionId: 'session', root: join(workspace, 'nope') }), { code: 'GIT_NO_WORKSPACE' })
})

test('log reads real repositories without writes and scopes every request', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'world-git-log-'))
  const context = new Context()
  await context.plugin(LocalFs, { cwd: workspace })
  const session = { header: { cwd: workspace } }
  const service = createVscodeGit({
    fs: context.fs,
    sessions: { get: id => id === 'session' ? session : undefined },
    get: () => undefined,
    sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: workspace }) },
  }, { FsError, writableRoots, subprocess: createSubprocess() })
  const log = root => service.call('log', { sessionId: 'session', ...(root ? { root } : {}) })
  const command = async (root, ...args) => assert.equal(await git(['-C', root, ...args]), 0)
  const init = async root => {
    await mkdir(root, { recursive: true })
    await command(root, 'init', '-b', 'main')
    await command(root, 'config', 'user.name', '中文作者')
    await command(root, 'config', 'user.email', 'history@example.invalid')
    await command(root, 'config', 'commit.gpgsign', 'false')
    await command(root, 'config', 'i18n.logOutputEncoding', 'GBK')
  }
  const commit = async (root, message, env = {}) => {
    const file = join(root, 'message.txt')
    await writeFile(file, message)
    assert.equal(await git(['-C', root, 'commit', '--allow-empty', '--cleanup=verbatim', '-F', file], env), 0)
  }
  t.after(async () => {
    await service.dispose()
    await context.fiber.dispose()
    await rm(workspace, { recursive: true, force: true })
  })
  await t.test('non-repo, absent session and invalid roots are rejected', async () => {
    await assert.rejects(log(), { code: 'GIT_NO_REPO' })
    await assert.rejects(service.call('log', {}), { code: 'GIT_NO_SESSION' })
    await assert.rejects(log(join(workspace, 'missing')), { code: 'GIT_NO_WORKSPACE' })
  })
  const first = join(workspace, 'first')
  const second = join(workspace, 'second')
  await init(first)
  await init(second)
  await t.test('unborn HEAD returns the exact empty shape in read-only mode', async () => {
    assert.deepEqual(await log(first), { commits: [], truncated: false })
  })
  const message = '中文主题\n\n完整说明第一行\n第二行：中文、标点和空行\n\n最后一行\n'
  const committedAt = '2024-02-03T04:05:06+08:00'
  await commit(first, message, {
    GIT_AUTHOR_DATE: '2001-01-01T01:02:03+08:00', GIT_COMMITTER_DATE: committedAt,
  })
  let firstHash
  await t.test('UTF-8 multiline full message, author and ISO date are preserved', async () => {
    const result = await log(first)
    assert.equal(result.truncated, false)
    assert.equal(result.commits.length, 1)
    const row = result.commits[0]
    assert.deepEqual(Object.keys(row).sort(), ['author', 'body', 'date', 'hash', 'shortHash', 'subject'])
    assert.equal(row.subject, '中文主题')
    assert.equal(row.body, message)
    assert.equal(row.author, '中文作者')
    assert.match(row.hash, /^[a-f0-9]{40}$/u)
    assert.ok(row.hash.startsWith(row.shortHash))
    assert.match(row.date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/u)
    assert.ok(Number.isFinite(Date.parse(row.date)))
    assert.equal(row.date, committedAt) // Committer date, not the different author date.
    firstHash = row.hash
  })
  await t.test('newest descendant first, exactly 20 is not truncated, 21 is', async () => {
    for (let index = 1; index < 20; index++) await commit(first, '提交 ' + index + '\n')
    const exact = await log(first)
    assert.equal(exact.commits.length, 20)
    assert.equal(exact.truncated, false)
    assert.deepEqual(exact.commits.map(row => row.subject),
      [...Array.from({ length: 19 }, (_, i) => '提交 ' + (19 - i)), '中文主题'])
    await commit(first, '提交 20\n')
    const capped = await log(first)
    assert.equal(capped.commits.length, 20)
    assert.equal(capped.truncated, true)
    assert.deepEqual(capped.commits.map(row => row.subject), Array.from({ length: 20 }, (_, i) => '提交 ' + (20 - i)))
    // Optional client parameters cannot change the fixed HEAD / 20-commit query.
    assert.deepEqual(await service.call('log', { sessionId: 'session', root: first, limit: 1, ref: firstHash }), capped)
  })
  await t.test('root and session cwd switches never reuse another repository history', async () => {
    await commit(second, '另一个仓库\n')
    assert.equal((await log(second)).commits[0].subject, '另一个仓库')
    await mkdir(join(first, 'sub'))
    assert.equal((await log(join(first, 'sub'))).commits[0].subject, '提交 20')
    session.header.cwd = second
    assert.equal((await log()).commits[0].subject, '另一个仓库')
    session.header.cwd = first
    assert.equal((await log()).commits[0].subject, '提交 20')
    await command(first, 'checkout', '--detach', firstHash)
    assert.deepEqual((await log(first)).commits.map(row => row.hash), [firstHash])
  })
  await t.test('an oversized Chinese message returns no partial record', async () => {
    await commit(second, '大消息\n\n' + '多行中文正文\n'.repeat(20000))
    assert.deepEqual(await log(second), { commits: [], truncated: true })
  })
})

after(() => hooks.deregister())
