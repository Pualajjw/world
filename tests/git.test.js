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
      let stdout = '', stderr = ''
      child.stdout?.on('data', chunk => { stdout += chunk })
      child.stderr?.on('data', chunk => { stderr += chunk })
      const done = new Promise(resolve => {
        child.on('error', error => resolve({ exitCode: null, signal: 'error', error }))
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
      })
      const handle = {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
        },
        terminate() { if (!child.killed) child.kill() },
        waitForExit: () => done.then(() => {}, () => {}),
      }
      if (spec.signal) spec.signal.addEventListener('abort', () => handle.terminate(), { once: true })
      return handle
    },
  }
}

const git = argv => new Promise(resolve => {
  const child = spawnProcess('git', argv, { windowsHide: true, stdio: 'ignore' })
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

  // 打开子文件夹：Git 在子目录里运行，能打开的文件路径相对子文件夹，仓库根的同级文件不能打开
  await writeFile(join(workspace, 'sub', 'b.txt'), 'b changed\n')
  const scoped = await service.call('status', { sessionId: 'session', root: join(workspace, 'sub') })
  assert.equal(scoped.repo, true)
  assert.equal(scoped.files.find(file => file.path === 'sub/b.txt').open, 'b.txt')
  assert.equal(scoped.files.find(file => file.path === 'c.txt').open, '')
  await assert.rejects(service.call('status', { sessionId: 'session', root: join(workspace, 'nope') }), { code: 'GIT_NO_WORKSPACE' })
})

after(() => hooks.deregister())
