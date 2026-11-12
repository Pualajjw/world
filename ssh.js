/**
 * world 终端里的 SSH 会话：宿主端这半边。
 *
 * 和本地终端一样，没有 PTY——每条远程命令都是一次独立的 `ssh host <command>`。
 * 这不是偷懒，是宿主只给了管道子进程：`ssh` 拿不到本地终端就不会有交互式会话，
 * 密码提示也没人能应答。于是这个模块把「会话」做成它实际能做到的形状：
 *
 *   · 连一次做探测（`ssh -G` 拿生效配置，再跑一条 `printf` + `pwd` 验证真的通了）
 *   · 之后每条命令都是 `ssh -T host "cd <cwd> && <命令>"`，远程目录由窗口记着
 *   · `cd` 单独发一条 `cd … && pwd`，让远端 shell 自己解释 `~`、`..`、`-`
 *
 * 参数一律 `BatchMode=yes`：不能应答就早点失败，让窗口把「为什么连不上」讲清楚，
 * 而不是挂在那里等一个永远不会有人输入的密码。
 */
import { access, appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, normalize, resolve } from 'node:path'
import { expandTilde, parseSshConfig } from './ssh-config.js'
import { createJobRunner } from './job-runner.js'

const MAX_LINE = 4096
const MAX_OUTPUT = 2 * 1024 * 1024
const CONNECT_TIMEOUT = 8
const PROBE_TIMEOUT = CONNECT_TIMEOUT * 1000 + 6000
const EXEC_TIMEOUT = 25000
const CONFIG_CACHE_MS = 4000
const COMPLETE_LIMIT = 200

const SSH_ENV = {
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  PYTHONIOENCODING: 'utf-8',
}

/** 允许从命令行传进来的选项：会让窗口卡住的 `-t` 之类一律不放行。 */
const VALUED_OPTIONS = new Set(['-p', '-l', '-i', '-o', '-J', '-F', '-E'])
const FLAG_OPTIONS = new Set(['-4', '-6', '-A', '-C'])

const posixQuote = text => `'${String(text).replace(/'/gu, `'\\''`)}'`

/**
 * `cd` 的参数：`~`、`-` 必须不带引号，否则远端 shell 不会展开它们。
 * 其余一律单引号包起来，空格、`$`、反引号都原样交给远端。
 */
export function cdExpression(target) {
  const text = String(target ?? '').trim()
  if (!text || text === '~') return '~'
  if (text === '-') return '-'
  if (text.startsWith('~/')) return `~/${posixQuote(text.slice(2))}`
  return posixQuote(text)
}

/** 把 `prefix` 切成「目录部分（含结尾斜杠）」和「词干」。 */
export function splitRemotePrefix(prefix) {
  const text = String(prefix ?? '')
  const index = text.lastIndexOf('/')
  return index < 0 ? { dir: '', stem: text } : { dir: text.slice(0, index + 1), stem: text.slice(index + 1) }
}

export function createWorldSsh(ctx, { subprocess, FsError, home = homedir(), sshPath = '' }) {
  const fail = (message, code = 'WORLD_SSH') => { throw new FsError(message, code) }
  const lifetime = new AbortController()
  const runner = createJobRunner({
    spawn: spec => subprocess.spawn(spec), fail,
    goneCode: 'WORLD_SSH_GONE', busyCode: 'WORLD_SSH_BUSY', spawnCode: 'WORLD_SSH_SPAWN',
  })

  let binaryCache = ''
  let versionCache = null
  let configCache = null

  const sshDir = join(home, '.ssh')
  const configPath = join(sshDir, 'config')
  const knownHostsPath = join(sshDir, 'known_hosts')

  async function exists(path) {
    try { await access(path); return true } catch { return false }
  }

  /** Windows 上 PATH 里不一定有 OpenSSH，但系统那份几乎总在同一个位置。 */
  async function sshBinary() {
    if (binaryCache) return binaryCache
    if (sshPath) { binaryCache = sshPath; return binaryCache }
    if (process.env.DSH_WORLD_SSH) { binaryCache = process.env.DSH_WORLD_SSH; return binaryCache }
    if (process.platform === 'win32') {
      const candidate = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
      if (await exists(candidate)) { binaryCache = candidate; return binaryCache }
    }
    binaryCache = 'ssh'
    return binaryCache
  }

  function siblingBinary(name) {
    const binary = binaryCache || 'ssh'
    if (!/[\\/]/u.test(binary)) return name
    const suffix = process.platform === 'win32' ? '.exe' : ''
    return join(dirname(binary), `${name}${suffix}`)
  }

  /**
   * 一次性的子进程：探测、`ssh -G`、`ssh-keyscan`、远程 `cd` 都用它。
   * 和交互式任务分开，因为这些都要「等它跑完、把 stdout/stderr 一起拿回来」。
   */
  async function execOnce(argv, { signal, timeoutMs = EXEC_TIMEOUT, cwd = home, env = SSH_ENV, maxBytes = 512 * 1024 } = {}) {
    const clock = new AbortController()
    const timer = setTimeout(() => clock.abort(), timeoutMs)
    timer.unref?.()
    const active = signal ? AbortSignal.any([signal, clock.signal]) : clock.signal
    let handle
    try {
      handle = subprocess.spawn({
        argv, cwd, signal: active, graceMs: 1200, env,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes },
          stderr: { maxBytes: 64 * 1024 },
        },
      })
    } catch (error) {
      clearTimeout(timer)
      fail(`无法执行 ${argv[0]}：${String(error?.message || error)}`, 'WORLD_SSH_SPAWN')
    }
    try {
      const outcome = await handle.done
      // 宿主给的是「按偏移读」的读取器；一次性的调用直接从头读完整段
      const drain = stream => stream?.readFrom?.(0)?.text ?? stream?.text ?? ''
      return {
        exitCode: outcome?.exitCode ?? null,
        signal: outcome?.signal ?? null,
        stdout: drain(handle.collected?.stdout),
        stderr: drain(handle.collected?.stderr),
        timedOut: clock.signal.aborted,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  function sanitiseOptions(raw, sink = fail) {
    const list = Array.isArray(raw) ? raw : []
    const out = []
    for (let index = 0; index < list.length; index += 1) {
      const item = String(list[index] ?? '')
      if (FLAG_OPTIONS.has(item)) { out.push(item); continue }
      if (VALUED_OPTIONS.has(item)) {
        const value = String(list[index + 1] ?? '')
        if (!value) sink(`${item} 需要一个值。`, 'WORLD_SSH_ARGS')
        if (item === '-o' && !/^[A-Za-z][A-Za-z0-9]*=[^=]/u.test(value)) sink(`看不懂的 -o 参数：${value}`, 'WORLD_SSH_ARGS')
        // 交互式终端在这套「没有 PTY」的窗口里只会挂住
        if (item === '-i' || item === '-F' || item === '-E') out.push(item, normalize(expandTilde(value, home)))
        else out.push(item, value)
        index += 1
        continue
      }
      if (item === '-t' || item === '-tt') sink('world 的终端没有 PTY，ssh -t 用不了；直接 ssh <主机> 即可。', 'WORLD_SSH_ARGS')
      sink(`不支持的 ssh 参数：${item}`, 'WORLD_SSH_ARGS')
    }
    return out
  }

  function checkTarget(raw) {
    const text = String(raw ?? '').trim()
    if (!text) fail('要连哪台主机？（ssh <主机>，只敲 ssh 可以看配置里的主机列表）', 'WORLD_SSH_TARGET')
    if (text.startsWith('-')) fail(`主机名不能以 - 开头：${text}`, 'WORLD_SSH_TARGET')
    if (text.length > 255 || !/^[A-Za-z0-9_.@:%[\]-]+$/u.test(text)) fail(`主机名里有不认识的字符：${text}`, 'WORLD_SSH_TARGET')
    return text
  }

  const baseArgs = (options, extra = []) => ['-T', ...extra, ...options]

  /** `ssh -G` 是拿生效配置的正规办法：别名、通配、Include、命令行覆盖都由它算完。 */
  async function resolveTarget(binary, target, options, signal) {
    const attempt = await execOnce([binary, '-G', ...options, target], { signal, timeoutMs: 8000 })
    const fields = {}
    for (const line of attempt.stdout.split(/\r?\n/u)) {
      if (!line.trim()) continue
      const index = line.indexOf(' ')
      if (index < 0) continue
      const key = line.slice(0, index).toLowerCase()
      const value = line.slice(index + 1).trim()
      if (!(key in fields)) fields[key] = value
    }
    const [login, hostPart] = target.includes('@') ? target.split(/@(?=[^@]*$)/u) : ['', target]
    return {
      alias: hostPart,
      user: fields.user || login || '',
      hostName: fields.hostname || hostPart,
      port: Number(fields.port) || 22,
      identityFile: fields.identityfile || '',
      proxyJump: fields.proxyjump || '',
      options,
    }
  }

  function firstLine(text) {
    return String(text || '').split(/\r?\n/u).map(line => line.trim()).find(Boolean) || ''
  }

  function classify(stderr) {
    const text = String(stderr || '')
    if (/Permission denied|Authentication failed|no supported authentication methods|Too many authentication failures/iu.test(text)) return 'AUTH'
    if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key for .* has changed|No (?:ECDSA|ED25519|RSA) host key is known/iu.test(text)) return 'HOSTKEY'
    if (/Could not resolve hostname/iu.test(text)) return 'DNS'
    if (/Connection timed out|Connection refused|No route to host|Network is unreachable|Operation timed out|Connection reset by peer|Connection closed by/iu.test(text)) return 'NET'
    if (/kex_exchange_identification|banner exchange/iu.test(text)) return 'NET'
    if (/not recognized as an internal or external command|command not found|No such file or directory.*ssh/iu.test(text)) return 'NO_SSH'
    return 'OTHER'
  }

  function explain(code, { target, hostName, port, detail }) {
    const where = `${hostName || target}:${port || 22}`
    if (code === 'AUTH') {
      return `认证失败：${target} 拒绝了登录。\n`
        + 'world 的终端没有 PTY，输不了密码，所以只走密钥登录：\n'
        + '  · 生成密钥：ssh-keygen -t ed25519\n'
        + '  · 上传公钥：把 ~/.ssh/id_ed25519.pub 追加到服务器的 ~/.ssh/authorized_keys\n'
        + '  · 或先在系统终端里用密码 ssh 一次，把免密配好再回来'
    }
    if (code === 'HOSTKEY') {
      return `主机密钥没有记录：${where}。\n`
        + '输入 trust 查看指纹并写进 known_hosts —— 只在你确认这就是那台服务器时这么做。'
    }
    if (code === 'DNS') {
      return `解析不了主机名：${hostName || target}。\n`
        + '检查 ~/.ssh/config 里的 HostName，或先用 IP 连一次。'
    }
    if (code === 'NET') {
      return `连不上 ${where}：${detail || '连接被拒绝或超时'}\n`
        + '可能是服务器没开、端口不对，或者防火墙 / 安全组没放行。'
    }
    if (code === 'NO_SSH') {
      return '这台机器上找不到 ssh 客户端。\n'
        + 'Windows 可以在「设置 → 系统 → 可选功能」里添加 OpenSSH 客户端，装完重开 DSH。'
    }
    return `ssh 退出了：${detail || '没有更多信息'}`
  }

  /** 配置 + 密钥 + known_hosts：主机清单面板和补全都吃这一份数据。 */
  async function loadConfig(signal) {
    if (configCache && Date.now() - configCache.at < CONFIG_CACHE_MS) return configCache.value
    const hosts = []
    const seenFiles = new Set()
    const seenAlias = new Set()

    async function expandInclude(pattern, baseDir) {
      const full = resolve(baseDir, expandTilde(pattern, home))
      if (!/[*?]/u.test(full)) return [full]
      const dir = dirname(full)
      const name = full.slice(dir.length + 1)
      const rx = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*').replace(/\?/gu, '.')}$`, 'u')
      try { return (await readdir(dir)).filter(item => rx.test(item)).sort().map(item => join(dir, item)) } catch { return [] }
    }

    async function readOne(path, depth) {
      if (depth > 5 || seenFiles.has(path)) return
      seenFiles.add(path)
      let text = ''
      try { text = await readFile(path, 'utf8') } catch { return }
      const parsed = parseSshConfig(text)
      for (const host of parsed.hosts) {
        if (seenAlias.has(host.alias)) continue
        seenAlias.add(host.alias)
        hosts.push({ ...host, source: path })
      }
      for (const include of parsed.includes) {
        for (const file of await expandInclude(include, dirname(path))) await readOne(file, depth + 1)
      }
    }
    await readOne(configPath, 0)
    signal?.throwIfAborted()

    let keys = []
    try { keys = (await readdir(sshDir)).filter(name => /^id_[^/]*$/u.test(name) && !name.endsWith('.pub')).sort() } catch { /* 没有 ~/.ssh 就是还没配 */ }
    let knownCount = 0
    try {
      const text = await readFile(knownHostsPath, 'utf8')
      knownCount = text.split(/\r?\n/u).filter(line => line.trim() && !line.trim().startsWith('#')).length
    } catch { /* 文件不存在 */ }

    const value = {
      hosts: hosts.sort((a, b) => a.alias.localeCompare(b.alias)),
      configPath, knownHostsPath,
      configExists: await exists(configPath),
      keys, knownCount,
    }
    configCache = { at: Date.now(), value }
    return value
  }

  async function sshVersion(binary, signal) {
    if (versionCache) return versionCache
    const attempt = await execOnce([binary, '-V'], { signal, timeoutMs: 6000 })
    const text = `${attempt.stdout}${attempt.stderr}`.trim()
    versionCache = attempt.exitCode === 0 || /OpenSSH/iu.test(text)
      ? { available: true, version: firstLine(text), path: binary }
      : { available: false, version: '', path: binary }
    return versionCache
  }

  function fingerprint(blob) {
    return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/u, '')}`
  }

  /** `ssh-keyscan` 的输出里只挑真正的公钥行；注释和 banner 不要。 */
  function parseKeyscan(text) {
    const keys = []
    for (const raw of String(text || '').split(/\r?\n/u)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const match = /^(\S+)\s+(\S+)\s+(\S+)$/u.exec(line)
      if (!match || !/^(ssh|ecdsa)-/u.test(match[2])) continue
      let blob
      try { blob = Buffer.from(match[3], 'base64') } catch { continue }
      if (!blob?.length) continue
      keys.push({ host: match[1], type: match[2], key: match[3], fingerprint: fingerprint(blob), line })
    }
    return keys
  }

  async function scanHost(binary, hostName, port, signal) {
    const keyscan = siblingBinary('ssh-keyscan')
    const args = ['-T', '6', '-t', 'ed25519,ecdsa,rsa']
    if (port && Number(port) !== 22) args.push('-p', String(port))
    args.push(hostName)
    const attempt = await execOnce([keyscan, ...args], { signal, timeoutMs: 12000 })
    return { keys: parseKeyscan(attempt.stdout), stderr: attempt.stderr, exitCode: attempt.exitCode }
  }

  return {
    async call(operation, payload = {}, signal) {
      const active = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
      active.throwIfAborted()
      runner.prune()

      const binary = await sshBinary()

      if (operation === 'hosts') {
        const config = await loadConfig(active)
        let version = { available: false, version: '', path: binary }
        try { version = await sshVersion(binary, active) } catch { /* 没有 ssh 也要能列出配置 */ }
        return { ...config, ssh: version, home }
      }

      if (operation === 'open') {
        const target = checkTarget(payload.target)
        const options = sanitiseOptions(payload.options)
        const resolved = await resolveTarget(binary, target, options, active)
        // 用户按 Esc 就是不想等了：必须在「ssh 被信号杀掉」和「真的连不上」之间分开，
        // 否则取消会显示成一条莫名其妙的网络错误
        if (active.aborted) fail('已取消连接。', 'WORLD_SSH_CANCELLED')
        const started = Date.now()
        const probe = await execOnce(
          [binary, ...baseArgs(options, ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${CONNECT_TIMEOUT}`, '-o', 'NumberOfPasswordPrompts=0']),
            target, "printf 'world-ssh-ok\\n'; pwd"],
          { signal: active, timeoutMs: PROBE_TIMEOUT },
        )
        if (active.aborted) fail('已取消连接。', 'WORLD_SSH_CANCELLED')
        if (probe.exitCode !== 0) {
          const code = probe.timedOut ? 'NET' : classify(probe.stderr)
          fail(explain(code, { target, ...resolved, detail: probe.timedOut ? '连接超时' : firstLine(probe.stderr) }), `WORLD_SSH_${code}`)
        }
        const cwd = probe.stdout.split(/\r?\n/u).map(line => line.trim()).filter(line => line.startsWith('/')).at(-1) || '/'
        return {
          target, alias: resolved.alias, user: resolved.user, hostName: resolved.hostName,
          port: resolved.port, cwd, latencyMs: Date.now() - started, options, proxyJump: resolved.proxyJump,
        }
      }

      if (operation === 'run') {
        const target = checkTarget(payload.target)
        const options = sanitiseOptions(payload.options)
        const line = typeof payload.line === 'string' ? payload.line.trim() : ''
        if (!line) fail('命令是空的。', 'WORLD_SSH_EMPTY')
        if (line.length > MAX_LINE) fail(`命令太长（上限 ${MAX_LINE} 个字符）。`, 'WORLD_SSH_TOO_LONG')
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(line)) fail('命令里有控制字符。', 'WORLD_SSH_EMPTY')
        if (runner.full()) fail(`一次最多同时跑 ${runner.maxJobs} 条远端命令，等前面的结束再试。`, 'WORLD_SSH_BUSY')
        const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : '~'
        const command = `cd ${cdExpression(cwd)} && ${line}`
        const started = runner.start({
          argv: [binary, ...baseArgs(options, ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${CONNECT_TIMEOUT}`,
            '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4']), target, command],
          cwd: home, env: SSH_ENV, signal: active, line, code: 'WORLD_SSH_SPAWN',
          stdio: { stdin: 'ignore', stdout: { maxBytes: MAX_OUTPUT }, stderr: { maxBytes: 8192 } },
        })
        return { jobId: started.jobId, startedAt: started.startedAt, cwd, command }
      }

      if (operation === 'poll') {
        const polled = runner.poll(payload.jobId, payload.offset)
        if (!polled) fail('这条命令已经结束并回收了。', 'WORLD_SSH_GONE')
        return polled
      }

      if (operation === 'cancel') return { cancelled: runner.cancel(payload.jobId) }

      if (operation === 'cd') {
        const target = checkTarget(payload.target)
        const options = sanitiseOptions(payload.options)
        const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : '~'
        const dir = String(payload.dir ?? '').trim()
        if (!dir) fail('cd 需要目标目录。', 'WORLD_SSH_CD')
        const attempt = await execOnce(
          [binary, ...baseArgs(options, ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${CONNECT_TIMEOUT}`]),
            target, `cd ${cdExpression(dir)} && pwd`],
          { signal: active },
        )
        if (attempt.exitCode !== 0) {
          fail(`cd 失败：${firstLine(attempt.stderr) || `退出码 ${attempt.exitCode}`}`, 'WORLD_SSH_CD')
        }
        const next = attempt.stdout.split(/\r?\n/u).map(line => line.trim()).filter(line => line.startsWith('/')).at(-1)
        if (!next) fail('远端没有告诉我们 cd 之后的路径。', 'WORLD_SSH_CD')
        return { cwd: next }
      }

      if (operation === 'complete') {
        const target = checkTarget(payload.target)
        const options = sanitiseOptions(payload.options)
        const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : '~'
        const prefix = String(payload.prefix ?? '')
        const { dir, stem } = splitRemotePrefix(prefix)
        // 目录部分加引号、通配符留在引号外：远端 shell 仍然会展开它
        const head = !dir ? '' : dir.startsWith('~/') ? `~/${posixQuote(dir.slice(2))}` : posixQuote(dir)
        const attempt = await execOnce(
          [binary, ...baseArgs(options, ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${CONNECT_TIMEOUT}`]),
            target, `cd ${cdExpression(cwd)} && ls -1dpa ${head}${posixQuote(stem)}* 2>/dev/null`],
          { signal: active, timeoutMs: 15000 },
        )
        const showHidden = stem.startsWith('.')
        const items = attempt.stdout.split(/\r?\n/u)
          .map(line => line.replace(/\r/gu, '').trim())
          .filter(line => line && line !== '.' && line !== '..' && line !== './')
          .map(line => {
            const name = line.startsWith(dir) ? line.slice(dir.length) : line
            return { name, type: name.endsWith('/') ? 'directory' : 'file' }
          })
          .map(item => item.type === 'directory' ? { ...item, name: item.name.replace(/\/+$/u, '') } : item)
          .filter(item => item.name && (showHidden || !item.name.startsWith('.')))
          .filter((item, index, all) => all.findIndex(other => other.name === item.name) === index)
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, COMPLETE_LIMIT)
        return { dir, items }
      }

      if (operation === 'key' || operation === 'trust') {
        const target = checkTarget(payload.target)
        const options = sanitiseOptions(payload.options)
        const resolved = await resolveTarget(binary, target, options, active)
        const scan = await scanHost(binary, resolved.hostName, resolved.port, active)
        if (active.aborted) fail('已取消。', 'WORLD_SSH_CANCELLED')
        if (!scan.keys.length) {
          fail(`拿不到 ${resolved.hostName} 的主机密钥：${firstLine(scan.stderr) || 'ssh-keyscan 没有输出'}`, 'WORLD_SSH_KEYSCAN')
        }
        if (operation === 'key') {
          return { hostName: resolved.hostName, port: resolved.port, keys: scan.keys.map(({ type, fingerprint: value }) => ({ type, fingerprint: value })) }
        }
        // trust 只在用户亲手敲了 `trust` 之后才走到这里：这就是那次确认
        await mkdir(sshDir, { recursive: true })
        const lines = scan.keys.map(key => key.line).join('\n')
        await appendFile(knownHostsPath, `${lines}\n`, { encoding: 'utf8', mode: 0o600 })
        configCache = null
        return {
          hostName: resolved.hostName, port: resolved.port, added: scan.keys.length,
          keys: scan.keys.map(({ type, fingerprint: value }) => ({ type, fingerprint: value })),
          path: knownHostsPath,
        }
      }

      fail('不支持的 SSH 操作。', 'WORLD_SSH_OP')
    },

    async dispose() {
      lifetime.abort()
      await runner.dispose()
    },
  }
}
