/** The world terminal runs real commands in the session folder; these tests drive a real shell. */
import assert from 'node:assert/strict'
import { spawn as spawnProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import { registerHooks } from 'node:module'
import { createWorldTerminal, escapePercentForBatch } from '../terminal.js'

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

/** Node-backed stand-in for the Host subprocess service, with byte-offset reads. */
function createSubprocess() {
  const spawns = []
  return {
    spawns,
    spawn(spec) {
      spawns.push(spec)
      const child = spawnProcess(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(spec.env ?? {}) },
      })
      const chunks = []
      child.stdout?.on('data', chunk => chunks.push(chunk))
      child.stderr?.on('data', chunk => chunks.push(chunk))
      const done = new Promise(resolve => {
        child.on('error', error => resolve({ exitCode: null, signal: 'error', error }))
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
      })
      const handle = {
        done,
        collected: {
          stdout: {
            readFrom(from) {
              const all = Buffer.concat(chunks)
              const start = Math.min(from, all.length)
              return { text: all.subarray(start).toString('utf8'), nextOffset: all.length, lossy: false }
            },
          },
        },
        terminate() { if (!child.killed) child.kill() },
        waitForExit: () => done.then(() => {}, () => {}),
      }
      if (spec.signal) spec.signal.addEventListener('abort', () => handle.terminate(), { once: true })
      return handle
    },
  }
}

async function setup(t, options = {}) {
  // mkdtemp 返回的是 8.3 短路径（ADMINI~1），fs 服务会把它规范成长路径，比较前先对齐
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'world-term-')))
  await mkdir(join(workspace, 'sub'))
  await writeFile(join(workspace, 'readme.txt'), 'hi\n')
  await writeFile(join(workspace, 'sub', 'inner.txt'), 'inner\n')
  const context = new Context()
  await context.plugin(LocalFs, { cwd: workspace })
  const subprocess = createSubprocess()
  const service = createWorldTerminal({ fs: context.fs }, {
    FsError, subprocess,
    ...(options.toolDirs ? { toolDirs: options.toolDirs } : {}),
  })
  t.after(async () => {
    await service.dispose()
    await context.fiber.dispose()
    await rm(workspace, { recursive: true, force: true })
  })
  return { workspace, service, subprocess }
}

/** Run one line and drain it the way the window does: poll until the job reports an exit. */
async function run(service, workspace, line) {
  const started = await service.call('run', { cwd: workspace, line })
  let offset = 0, output = '', state = null
  for (let attempt = 0; attempt < 400; attempt += 1) {
    state = await service.call('poll', { jobId: started.jobId, offset })
    output += state.chunk
    offset = state.offset
    if (!state.running) return { ...state, output, jobId: started.jobId }
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  throw new Error(`command did not finish: ${line}`)
}

test('info reports the shell, home and a usable folder', async t => {
  const { workspace, service, subprocess } = await setup(t)
  const info = await service.call('info', { cwd: workspace })
  assert.equal(info.cwd, workspace)
  assert.equal(info.home, homedir())
  assert.ok(info.shell)
  assert.ok(['windows', 'posix'].includes(info.platform))
  assert.equal(subprocess.spawns.length, 0, 'info must not spawn anything')

  // 上次的目录被删掉时退回 home，而不是让窗口打不开
  const missing = await service.call('info', { cwd: join(workspace, 'gone') })
  assert.equal(missing.cwd, homedir())
})

test('a command runs, streams output and reports its exit code', async t => {
  const { workspace, service } = await setup(t)
  const done = await run(service, workspace, 'node -e "console.log(42)"')
  assert.match(done.output, /42/u)
  assert.equal(done.exitCode, 0)
  assert.equal(done.running, false)
  assert.ok(done.durationMs >= 0)

  const failed = await run(service, workspace, 'node -e "process.exit(3)"')
  assert.equal(failed.exitCode, 3)
})

test('stderr is merged into the same stream so the order survives', async t => {
  const { workspace, service } = await setup(t)
  const done = await run(service, workspace, 'node -e "process.stdout.write(\'OUT\'); process.stderr.write(\'ERR\')"')
  assert.match(done.output, /OUT/u)
  assert.match(done.output, /ERR/u)
  assert.ok(done.output.indexOf('OUT') < done.output.indexOf('ERR'), done.output)
})

test('the working directory is the one the window asked for', async t => {
  const { workspace, service } = await setup(t)
  const done = await run(service, workspace, 'node -e "console.log(process.cwd())"')
  assert.ok(done.output.replace(/\\/gu, '/').includes(workspace.replace(/\\/gu, '/')), done.output)
})

test('a long command can be cancelled without leaving the job running', async t => {
  const { workspace, service } = await setup(t)
  const started = await service.call('run', { cwd: workspace, line: 'node -e "setTimeout(() => {}, 30000)"' })
  const cancelled = await service.call('cancel', { jobId: started.jobId })
  assert.equal(cancelled.cancelled, true)
  let state
  for (let attempt = 0; attempt < 200; attempt += 1) {
    state = await service.call('poll', { jobId: started.jobId, offset: 0 })
    if (!state.running) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(state.running, false)
  assert.equal(state.cancelled, true)
})

test('polling continues from a byte offset instead of resending everything', async t => {
  const { workspace, service } = await setup(t)
  const started = await service.call('run', { cwd: workspace, line: 'node -e "console.log(\'x\'.repeat(200000))"' })
  let offset = 0, seen = ''
  while (!seen) {
    const state = await service.call('poll', { jobId: started.jobId, offset })
    seen += state.chunk
    offset = state.offset
    if (!seen) await new Promise(resolve => setTimeout(resolve, 10))
  }
  const next = await service.call('poll', { jobId: started.jobId, offset })
  assert.ok(next.offset >= offset)
  // 偏移是整段输出的字节坐标：从 0 再读一次必须拿回同样的开头，而不是空
  const replay = await service.call('poll', { jobId: started.jobId, offset: 0 })
  assert.ok(replay.chunk.startsWith(seen.slice(0, 32)))
  assert.ok(next.chunk.length === 0 || next.chunk !== seen)
})

test('cd resolves relative paths, parents and home', async t => {
  const { workspace, service } = await setup(t)
  const toSub = await service.call('chdir', { cwd: workspace, target: 'sub' })
  assert.equal(toSub.cwd, join(workspace, 'sub'))
  const back = await service.call('chdir', { cwd: toSub.cwd, target: '..' })
  assert.equal(back.cwd, workspace)
  const home = await service.call('chdir', { cwd: workspace, target: '~' })
  assert.equal(home.cwd, homedir())
  // cmd 习惯的 `cd /d`：换盘符的写法在这里没有意义，但也不该报错
  const withDrive = await service.call('chdir', { cwd: workspace, target: '/d sub' })
  assert.equal(withDrive.cwd, join(workspace, 'sub'))
  await assert.rejects(service.call('chdir', { cwd: workspace, target: 'nope' }), { code: 'WORLD_TERMINAL_CWD' })
  await assert.rejects(service.call('chdir', { cwd: workspace, target: 'readme.txt' }), { code: 'WORLD_TERMINAL_CWD' })
})

test('path completion lists folders first and respects the typed prefix', async t => {
  const { workspace, service } = await setup(t)
  const all = await service.call('complete', { cwd: workspace, prefix: '' })
  assert.deepEqual(all.items.map(item => item.name), ['sub', 'readme.txt'])
  assert.equal(all.items[0].type, 'directory')

  const filtered = await service.call('complete', { cwd: workspace, prefix: 're' })
  assert.deepEqual(filtered.items.map(item => item.name), ['readme.txt'])

  const inside = await service.call('complete', { cwd: workspace, prefix: 'sub/' })
  assert.equal(inside.dir, 'sub/')
  assert.deepEqual(inside.items.map(item => item.name), ['inner.txt'])

  const nothing = await service.call('complete', { cwd: workspace, prefix: 'sub/missing' })
  assert.deepEqual(nothing.items, [])
})

test('bad input is rejected before it reaches a shell', async t => {
  const { workspace, service, subprocess } = await setup(t)
  await assert.rejects(service.call('run', { cwd: workspace, line: '   ' }), { code: 'WORLD_TERMINAL_EMPTY' })
  await assert.rejects(service.call('run', { cwd: workspace, line: 'x'.repeat(5000) }), { code: 'WORLD_TERMINAL_TOO_LONG' })
  await assert.rejects(service.call('run', { cwd: workspace, line: 'echo \u0001bad' }), { code: 'WORLD_TERMINAL_EMPTY' })
  await assert.rejects(service.call('run', { cwd: join(workspace, 'gone'), line: 'echo hi' }), { code: 'WORLD_TERMINAL_CWD' })
  await assert.rejects(service.call('poll', { jobId: 'nope' }), { code: 'WORLD_TERMINAL_GONE' })
  assert.deepEqual(subprocess.spawns, [], 'no rejected command may reach the shell')
})

test('only a few commands may run at once', async t => {
  const { workspace, service } = await setup(t)
  const started = []
  for (let index = 0; index < 4; index += 1) {
    started.push(await service.call('run', { cwd: workspace, line: 'node -e "setTimeout(() => {}, 5000)"' }))
  }
  await assert.rejects(service.call('run', { cwd: workspace, line: 'echo again' }), { code: 'WORLD_TERMINAL_BUSY' })
  for (const job of started) await service.call('cancel', { jobId: job.jobId })
})

test('percent signs that are not variables survive the batch layer', async t => {
  assert.equal(escapePercentForBatch('进度 100%'), '进度 100%%')
  assert.equal(escapePercentForBatch('node -e "console.log(7 % 2)"'), 'node -e "console.log(7 %% 2)"')
  assert.equal(escapePercentForBatch('echo %PATH%'), 'echo %PATH%')
  assert.equal(escapePercentForBatch('echo %1 %*'), 'echo %1 %*')
  assert.equal(escapePercentForBatch('bare %'), 'bare %%')

  const { workspace, service } = await setup(t)
  const done = await run(service, workspace, 'node -e "console.log(\'100%\', 7 % 2)"')
  // FORCE_COLOR 打开了，数字会带颜色；比内容前先剥掉 SGR
  assert.equal(done.output.replace(/\u001b\[[0-9;]*m/gu, '').trim(), '100% 1')
})

test('the shell argv uses the platform command switch and merges stderr', async t => {
  const { workspace, service, subprocess } = await setup(t)
  await run(service, workspace, 'echo hi')
  const [spec] = subprocess.spawns
  if (process.platform === 'win32') {
    // Windows 上命令落成临时批处理：引号和括号才不会被 cmd 吃掉
    assert.match(spec.argv.at(-1), /\.cmd$/u)
    const script = await readFile(spec.argv.at(-1), 'utf8')
    assert.match(script, /chcp 65001/u)
    // 命令在子文件里，外层只 `call` 它：这样 PATH 里的 .cmd 垫片（pbnpm.cmd）
    // 才不会把 `call :dsh_cmd` 的子程序返回位置弄丢
    const bodyPath = /call "([^"]+)"/u.exec(script)?.[1]
    assert.ok(bodyPath, `outer script should call a body file: ${script}`)
    assert.ok(!/:dsh_cmd/u.test(script), 'the label subroutine is gone')
    const body = await readFile(bodyPath, 'utf8')
    assert.match(body, /echo hi/u)
    assert.match(body, /exit \/b %ERRORLEVEL%/u)
  } else {
    assert.ok(spec.argv.at(-1).endsWith('echo hi 2>&1'), spec.argv.join(' '))
  }
  assert.equal(spec.cwd, workspace)
  assert.equal(spec.env.FORCE_COLOR, '1')
  assert.equal(spec.env.GIT_PAGER, 'cat')
  assert.equal(spec.stdio.stdin, 'ignore')
})

test('pbnpm is put on PATH with a wrapper that fixes its GBK output', async t => {
  if (process.platform !== 'win32') return
  const bin = await realpath(await mkdtemp(join(tmpdir(), 'world-pbnpm-bin-')))
  await writeFile(join(bin, 'pbnpm.exe'), '')
  t.after(() => rm(bin, { recursive: true, force: true }))
  const { workspace, service, subprocess } = await setup(t, { toolDirs: () => [bin] })

  const info = await service.call('info', { cwd: workspace })
  assert.deepEqual(info.tools, [{ name: 'pbnpm', dir: bin }])

  await run(service, workspace, 'echo hi')
  const path = subprocess.spawns.at(-1).env.PATH || ''
  const parts = path.split(';').filter(Boolean)
  // 包装目录在最前，真实 bin 紧随其后：先拿到转码版，想直接调 exe 也还在
  assert.ok(parts[0].endsWith('bin'), parts[0])
  assert.equal(parts[1], bin)
  assert.ok(path.includes(process.env.PATH || process.env.Path || ''), 'inherited PATH must survive')

  const wrapper = await readFile(join(parts[0], 'pbnpm.cmd'), 'utf8')
  assert.match(wrapper, /pbnpm-run\.mjs/u)
  assert.match(wrapper, /pbnpm\.exe.*%\*/u)
  // 宿主的 execPath 是 DeepSeek Harness.exe：必须显式进 node 模式，否则包装会当 GUI 启动
  assert.match(wrapper, /set "ELECTRON_RUN_AS_NODE=1"/u)
})

test('a .cmd shim on PATH still runs (the label subroutine is gone)', async t => {
  if (process.platform !== 'win32') return
  const shim = await realpath(await mkdtemp(join(tmpdir(), 'world-shim-')))
  await writeFile(join(shim, 'world-shim.cmd'), '@echo off\r\necho hi-from-shim\r\nexit /b 7\r\n')
  t.after(() => rm(shim, { recursive: true, force: true }))
  const previous = process.env.PATH
  process.env.PATH = `${shim};${previous}`
  t.after(() => { process.env.PATH = previous })
  const { workspace, service } = await setup(t)
  // 这条曾经会报「找不到批处理标签 dsh_cmd」：批处理垫片把 call :label 的返回位置弄丢了
  const done = await run(service, workspace, 'world-shim')
  assert.match(done.output, /hi-from-shim/u)
  assert.equal(done.exitCode, 7)
})

test('without pbnpm the terminal leaves PATH alone', async t => {
  const { workspace, service, subprocess } = await setup(t, { toolDirs: () => [] })
  const info = await service.call('info', { cwd: workspace })
  assert.deepEqual(info.tools, [])
  await run(service, workspace, 'echo hi')
  assert.equal(subprocess.spawns.at(-1).env.PATH, undefined)
})

after(() => hooks.deregister())
