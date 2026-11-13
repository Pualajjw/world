/**
 * world 桌面里的「终端」：真正跑命令的那一头。
 *
 * 每敲一行就起一个子进程（`cmd /c` 或 `sh -c`），而不是维持一个长活的伪终端——
 * 宿主只提供了管道子进程，没有 PTY；换来的好处是每条命令都能单独取消、单独限流，
 * 挂掉的命令不会把整个窗口带走。代价是 `cd`、交互式程序（vim/top/ssh 密码）跑不了：
 * `cd` 由窗口自己记，交互式程序会报「不支持」。
 *
 * 输出把 stderr 并进 stdout（`2>&1`）再按字节增量读，客户端才能看到真实的先后顺序；
 * 分开收集再拼会在慢命令上把两股输出搅成一团。
 *
 * Windows 上不直接把命令行塞给 `cmd /c`：`cmd` 会吃掉参数里的引号（`node -e "a(b)"`
 * 会被截断成 `node -e`），而宿主只能按 argv 传参，改不了这层引号规则。所以每条命令
 * 先落成临时 .cmd 再整份执行——引号、括号、`&&`、中文都能原样活下来，顺带 `chcp 65001`
 * 把输出固定成 UTF-8。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJobRunner } from './job-runner.js'

const MAX_LINE = 4096
/** 单条命令保留的输出上限：超了只留尾部，并告诉窗口「前面被截断了」。 */
const MAX_OUTPUT = 2 * 1024 * 1024
const COMPLETE_LIMIT = 200

const isWindows = () => process.platform === 'win32'

function expandHome(path, home) {
  const text = String(path ?? '').trim()
  if (!text) return home
  if (text === '~') return home
  if (text.startsWith('~/') || text.startsWith('~\\')) return `${home}${text.slice(1)}`
  return text
}

/** 路径最后一段的切点：Windows 上反斜杠正斜杠都算。 */
function splitPrefix(prefix) {
  const text = String(prefix ?? '')
  const index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  return index < 0
    ? { dir: '', stem: text }
    : { dir: text.slice(0, index + 1), stem: text.slice(index + 1) }
}

/**
 * 批处理里 `%` 是变量展开符，单独一个 `%` 会被吃掉——`进度 100%` 打出来就变成 `进度 100`，
 * JS 的取模 `7 % 2` 也会变形。所以在写进 .cmd 之前，把「不是变量引用」的 `%` 变成 `%%`
 * （批处理里 `%%` 还原成一个字面量 `%`）；`%PATH%`、`%1` 这类真变量仍然让它展开。
 */
export function escapePercentForBatch(line) {
  const text = String(line ?? '')
  let out = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char !== '%') { out += char; continue }
    const rest = text.slice(index + 1)
    const variable = /^[A-Za-z_][A-Za-z0-9_]*%/u.exec(rest)
    if (variable) { out += `%${variable[0]}`; index += variable[0].length; continue }
    const positional = /^[0-9*]/u.exec(rest)
    if (positional) { out += `%${positional[0]}`; index += positional[0].length; continue }
    out += '%%'
  }
  return out
}

export function createWorldTerminal(ctx, { subprocess, FsError, toolDirs = () => [] }) {
  const fail = (message, code = 'WORLD_TERMINAL') => { throw new FsError(message, code) }
  const runner = createJobRunner({
    spawn: spec => subprocess.spawn(spec), fail,
    goneCode: 'WORLD_TERMINAL_GONE', busyCode: 'WORLD_TERMINAL_BUSY', spawnCode: 'WORLD_TERMINAL_SPAWN',
  })
  const lifetime = new AbortController()

  const home = homedir()
  let cachedShell = null

  /** 宿主如果没有终端环境信息，就按平台给一个最保守的壳。 */
  async function shellInfo(signal) {
    if (cachedShell) return cachedShell
    let platform = isWindows() ? 'windows' : 'posix'
    try {
      const env = await subprocess.terminalEnvironment?.(signal)
      if (env?.platform) platform = env.platform
    } catch { /* 拿不到就问平台默认值，不因此拦下整个终端 */ }
    // Windows 走的始终是 cmd 批处理（见 argvFor），所以这里不采用宿主默认的 PowerShell：
    // 显示成 powershell 但执行的是 cmd，比直接写 cmd 更容易骗人。
    const shell = platform === 'windows'
      ? (process.env.ComSpec || process.env.COMSPEC || 'cmd.exe')
      : (process.env.SHELL || '/bin/sh')
    const name = shell.replace(/\\/gu, '/').split('/').at(-1) || shell
    cachedShell = { path: shell, name: name.replace(/\.exe$/iu, ''), platform }
    return cachedShell
  }

  /**
   * 一条命令行 → argv。
   * POSIX：整条丢给 `sh -c`，引号由 sh 自己解释。
   * Windows：写成两个临时批处理——外层 `call "<id>-body.cmd" 2>&1` 把 stdout/stderr
   * 汇成一股（窗口里才看得到真实先后顺序）并带回退出码，命令正文在子文件里执行。
   * 正文不能直接写在 `:dsh_cmd` 子程序里：命令一旦命中 PATH 里的 `.cmd` 垫片
   * （`pbnpm` 就是），cmd 会丢掉子程序的返回位置并报「找不到批处理标签」。
   */
  async function argvFor(shell, line, id) {
    if (shell.platform === 'windows') {
      const dir = await scriptDir()
      const script = join(dir, `${id}.cmd`)
      // 命令本身再落一个批处理，外层只负责 `call` 它。原因：`call :dsh_cmd` 这种子程序
      // 一旦被执行到的命令命中 `.cmd` 垫片（PATH 里的 pbnpm.cmd 就是），cmd 会丢掉
      // 子程序的返回位置，直接报「找不到批处理标签 dsh_cmd」——用户的 pbnpm 就是这么废掉的。
      // 换成 `call <文件>` 之后，垫片在子文件里怎么跑都不影响外层。
      const body = join(dir, `${id}-body.cmd`)
      await writeFile(body, [
        '@echo off',
        escapePercentForBatch(line),
        'exit /b %ERRORLEVEL%',
        '',
      ].join('\r\n'), 'utf8')
      await writeFile(script, [
        '@echo off',
        'chcp 65001 >nul',
        `call "${body}" 2>&1`,
        'exit /b %ERRORLEVEL%',
        '',
      ].join('\r\n'), 'utf8')
      return { argv: [shell.path, '/d', '/s', '/c', script], script, scripts: [script, body] }
    }
    return { argv: [shell.path, '-c', `${line} 2>&1`], script: '' }
  }

  let scriptsDir = ''
  /** 临时脚本放一个进程内固定目录，退出时整目录删掉，不留一地 .cmd。 */
  async function scriptDir() {
    if (!scriptsDir) {
      scriptsDir = join(tmpdir(), `dsh-world-terminal-${process.pid}`)
      await mkdir(scriptsDir, { recursive: true })
    }
    return scriptsDir
  }

  /**
   * 把 pbnpm 的 bin 目录接到 PATH 最前面，`cmd` 里直接敲 `pbnpm` 就能用。
   * 另外在临时目录放一个同名 `pbnpm.cmd`：pbnpm 的中文输出是 GBK，转码后终端才不会
   * 满屏乱码（见 pbnpm-run.mjs）。包装目录在前，真实 bin 在后——想直接调 exe 也还在。
   */
  let wrapperDir = ''
  async function toolEnv() {
    const dirs = toolDirs()
    if (!dirs.length || !isWindows()) return { dirs, path: '' }
    if (!wrapperDir) {
      wrapperDir = join(await scriptDir(), 'bin')
      await mkdir(wrapperDir, { recursive: true })
      // 宿主的 process.execPath 是 `DeepSeek Harness.exe`。不显式把 ELECTRON_RUN_AS_NODE
      // 写进包装里，它会以 GUI 身份启动（参数里的 .mjs 被当成要打开的东西），
      // 包装看起来「跑了」，其实什么都没做——pbnpm 只会在窗口里留一句报错。
      await writeFile(join(wrapperDir, 'pbnpm.cmd'), [
        '@echo off',
        'setlocal',
        'set "ELECTRON_RUN_AS_NODE=1"',
        `"${process.execPath}" "${join(import.meta.dirname, 'pbnpm-run.mjs')}" "${join(dirs[0], 'pbnpm.exe')}" %*`,
        '',
      ].join('\r\n'), 'utf8')
    }
    const base = process.env.PATH || process.env.Path || ''
    return { dirs, path: [wrapperDir, ...dirs, base].filter(Boolean).join(';') }
  }

  async function directoryOf(requested, base, signal) {
    const target = await ctx.fs.resolve(expandHome(requested || base, home), { cwd: base || home, signal })
    const info = await ctx.fs.stat(target, signal)
    if (!info) fail('这个文件夹不存在。', 'WORLD_TERMINAL_CWD')
    if (info.type !== 'directory') fail('只能在工作目录上执行命令。', 'WORLD_TERMINAL_CWD')
    return ctx.fs.processPath(target)
  }

  /** 忘掉一个任务：连它的临时批处理一起删，别在 %TEMP% 里堆一地的 .cmd。 */
  function forgetScript(script) {
    for (const file of [script].flat().filter(Boolean)) void rm(file, { force: true }).catch(() => {})
  }

  return {
    async call(operation, payload = {}, signal) {
      const active = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
      active.throwIfAborted()
      runner.prune()
      const shell = await shellInfo(active)

      if (operation === 'info') {
        const base = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : home
        let cwd = base
        try {
          cwd = await directoryOf(base, '', active)
        } catch {
          // 上次的目录可能已经被删了：退回 home，而不是让窗口打不开
          cwd = await directoryOf(home, '', active).catch(() => home)
        }
        return { cwd, home, shell: shell.name, shellPath: shell.path, platform: shell.platform,
          maxLine: MAX_LINE, maxJobs: runner.maxJobs,
          // 「pbnpm 已经在 PATH 里」这件事要能被窗口看见，否则用户不知道从哪里开始
          tools: (await toolEnv()).dirs.map(dir => ({ name: 'pbnpm', dir })) }
      }

      if (operation === 'chdir') {
        const base = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : home
        if (typeof payload.target !== 'string') fail('cd 需要目标目录。', 'WORLD_TERMINAL_CD')
        // `cd /d D:\x` 是 cmd 里换盘的写法，这里本来就跨盘，把 /d 吃掉就行
        const target = payload.target.replace(/^\s*\/[dD]\s+/u, '')
        return { cwd: await directoryOf(target, base, active) }
      }

      if (operation === 'complete') {
        const base = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : home
        const { dir, stem } = splitPrefix(payload.prefix)
        const target = await ctx.fs.resolve(expandHome(dir || '.', home), { cwd: base, signal: active })
        let entries = []
        try { entries = await ctx.fs.listDir(target, active) }
        catch { return { dir, items: [] } } // 目录不可读就等于没有补全项，不用报错打断输入
        const needle = stem.toLowerCase()
        const showHidden = needle.startsWith('.')
        const items = entries
          .filter(entry => entry.type === 'file' || entry.type === 'directory')
          .filter(entry => showHidden || !entry.name.startsWith('.'))
          .filter(entry => entry.name.toLowerCase().startsWith(needle))
          .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))
          .slice(0, COMPLETE_LIMIT)
          .map(entry => ({ name: entry.name, type: entry.type }))
        return { dir, items }
      }

      if (operation === 'run') {
        const line = typeof payload.line === 'string' ? payload.line.trim() : ''
        if (!line) fail('命令是空的。', 'WORLD_TERMINAL_EMPTY')
        if (line.length > MAX_LINE) fail(`命令太长（上限 ${MAX_LINE} 个字符）。`, 'WORLD_TERMINAL_TOO_LONG')
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(line)) fail('命令里有控制字符。', 'WORLD_TERMINAL_EMPTY')
        if (runner.full()) fail(`一次最多同时跑 ${runner.maxJobs} 条命令，等前面的结束再试。`, 'WORLD_TERMINAL_BUSY')
        const cwd = await directoryOf(payload.cwd, home, active)
        const { path: toolPath } = await toolEnv()
        const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        const { argv, scripts } = await argvFor(shell, line, id)
        // 分页器/凭据弹窗在无头窗口里没人能应答，直接关掉；颜色则强制打开，否则
        // git / ls 会因为「不是终端」而退回无色输出，窗口里看着像坏了。
        const started = runner.start({
          id, argv, cwd, signal: active, line,
          code: 'WORLD_TERMINAL_SPAWN',
          cleanup: () => forgetScript(scripts),
          env: {
            TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '1', CLICOLOR_FORCE: '1',
            GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
            GIT_OPTIONAL_LOCKS: '0', PYTHONIOENCODING: 'utf-8',
            ...(toolPath ? { PATH: toolPath } : {}),
          },
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: MAX_OUTPUT },
            stderr: { maxBytes: 4096 },
          },
        })
        return { jobId: started.jobId, cwd, startedAt: started.startedAt, shell: shell.name }
      }

      if (operation === 'poll') {
        const polled = runner.poll(payload.jobId, payload.offset)
        if (!polled) fail('这条命令已经结束并回收了。', 'WORLD_TERMINAL_GONE')
        return polled
      }

      if (operation === 'cancel') {
        return { cancelled: runner.cancel(payload.jobId) }
      }

      fail('不支持的终端操作。', 'WORLD_TERMINAL_OP')
    },

    async dispose() {
      lifetime.abort()
      await runner.dispose()
      if (scriptsDir) await rm(scriptsDir, { recursive: true, force: true }).catch(() => {})
    },
  }
}
