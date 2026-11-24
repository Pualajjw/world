/** EasyTier connection owned by the world host, independent of the window lifetime. */
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rename, stat, writeFile, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { isIPv4 } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { stripVTControlCharacters } from 'node:util'
import { hasInternetPrivileges } from './internet-privileges.js'
import { createElevatedInternetProcess } from './internet-elevated.js'
import { createInternetConnectionProbe } from './internet-connection.js'

const PLATFORMS = new Set(['win32', 'darwin', 'linux'])
export function internetDefaults(platform = process.platform) {
  return { directory: platform === 'win32' ? 'D:\\easytier-windows-x86_64' : '',
    ipv4: '10.192.168.3', secret: '', peer: 'udp://118.178.196.123:11010', autoStart: false }
}
const connectionFields = ['directory', 'ipv4', 'secret', 'peer']
export const INTERNET_DEFAULTS = Object.freeze(internetDefaults())
const fail = (message, code = 'WORLD_INTERNET') => { throw Object.assign(new Error(message), { code }) }
const pathsFor = platform => platform === 'win32' ? win32 : posix
export const internetExecutable = (directory, platform = process.platform) =>
  directory ? pathsFor(platform).join(directory, platform === 'win32' ? 'easytier-core.exe' : 'easytier-core')
    : platform === 'win32' ? 'easytier-core.exe' : 'easytier-core'
export const internetPermissionHint = platform => platform === 'win32'
  ? 'EasyTier 权限不足，请以管理员身份启动 DSH 后重试。'
  : 'EasyTier 权限不足，请检查 TUN 设备权限，并以 root 或具备所需网络权限的账号启动 DSH 后重试。'

export function normalizeInternetConfig(value, platform = process.platform) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('请输入 EasyTier 配置。')
  if (value.autoStart !== undefined && typeof value.autoStart !== 'boolean') fail('随 World 启动上网必须为开或关。')
  const config = { autoStart: value.autoStart === true } // Absent in legacy configurations: never opt in implicitly.
  for (const key of connectionFields) {
    if (typeof value[key] !== 'string' || /[\x00-\x1f\x7f]/u.test(value[key]) || value[key].length > 4096)
      fail('配置字段必须是单行文本。')
    config[key] = key === 'secret' ? value[key] : value[key].trim()
  }
  config.peer = config.peer.replace(/\\:\/\//gu, '://')
  if (config.directory && (!pathsFor(platform).isAbsolute(config.directory)
    || (platform !== 'win32' && /^[a-z]:/iu.test(config.directory))))
    fail('程序目录需要填写当前系统的完整路径，也可留空从 PATH 查找 EasyTier。')
  const [ip, mask, extra] = config.ipv4.split('/')
  if (!isIPv4(ip) || extra !== undefined || (mask !== undefined && !/^(?:[0-9]|[12][0-9]|3[0-2])$/u.test(mask)))
    fail('请填写有效的 IPv4 地址，例如 10.192.168.3。')
  if (!config.secret || config.secret.length > 512) fail('请输入网络密钥（最多 512 个字符）。')
  let url
  try { url = new URL(config.peer) } catch { fail('节点地址格式错误，例如 udp://118.178.196.123:11010。') }
  if (!['udp:', 'tcp:', 'ws:', 'wss:', 'wg:', 'quic:', 'faketcp:'].includes(url.protocol)
    || !url.hostname || url.username || url.password || (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)))
    fail('请填写有效的 EasyTier 节点地址。')
  return config
}

export function createWorldInternet({
  dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'world'),
  spawnImpl = spawn, platform = process.platform, maxLogChars = 65536, stopMs = 5000,
  checkPrivileges = () => hasInternetPrivileges({ platform }), elevatedSpawnImpl = createElevatedInternetProcess,
  connectionProbe = createInternetConnectionProbe({ platform }), startup, bootSignal,
} = {}) {
  const file = join(dir, 'internet.json')
  let removed = false, savedAutoStart = false
  let configPromise, current = null, disposed = false, queue = Promise.resolve()
  let phase = 'stopped', startedAt = 0, exitCode = null, lastError = '', logs = '', truncated = false
  let privileged = null, privilegeCheck
  async function privilege() {
    if (!privilegeCheck) privilegeCheck = Promise.resolve().then(checkPrivileges).then(value => {
      privileged = value === true; return privileged
    }).catch(error => { privilegeCheck = null; throw error })
    return privilegeCheck
  }
  const secrets = new Set()
  const redact = text => {
    let result = stripVTControlCharacters(String(text))
    for (const secret of secrets) {
      result = result.replaceAll(secret, '******').replaceAll(JSON.stringify(secret).slice(1, -1), '******')
    }
    return result
  }
  const log = (source, text) => {
    if (current && source !== '系统' && /access.*denied|permission denied|operation not permitted|拒绝访问|os error 5|权限不足/iu.test(text))
      current.permissionDenied = true
    logs += `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] [${source}] ${redact(text)}\n`
    if (logs.length > maxLogChars) {
      logs = logs.slice(-maxLogChars)
      const first = logs.indexOf('\n')
      if (first >= 0) logs = logs.slice(first + 1)
      truncated = true
    }
  }
  const snapshot = () => ({
    supported: PLATFORMS.has(platform), platform, executableName: internetExecutable('', platform),
    requiresElevation: platform === 'win32' && privileged === false, elevated: current?.elevated || privileged === true,
    autoStart: savedAutoStart, phase, running: Boolean(current), pid: current?.child.pid || null,
    startedAt, exitCode, error: lastError, logs, truncated,
  })
  async function load() {
    if (!configPromise) configPromise = (async () => {
      try {
        const stored = JSON.parse(await readFile(file, 'utf8'))
        const value = normalizeInternetConfig(stored, platform)
        removed = stored.startupRemoved === true; if (removed) value.autoStart = false
        savedAutoStart = value.autoStart
        secrets.add(value.secret)
        return value
      } catch (error) {
        if (error.code === 'ENOENT') return internetDefaults(platform)
        configPromise = null
        fail(`无法读取上网配置：${error.message}`)
      }
    })()
    return configPromise
  }
  async function save(value, next, expected) {
    const config = normalizeInternetConfig(value, platform)
    if (typeof expected === 'boolean' && expected !== savedAutoStart) {
      if (config.autoStart !== expected) fail('启动项已在其他窗口修改，请重新读取配置。')
      config.autoStart = savedAutoStart // Saving unrelated fields must not restore a removed entry.
    }
    const hide = next === 'removed' || (removed && !config.autoStart && next !== 'disabled')
    if (current) {
      // Scheduling the next launch doesn't change the live tunnel. Keep network
      // parameters locked, including when a second window has a stale draft.
      const saved = await load()
      if ((!next && saved.autoStart === config.autoStart) || connectionFields.some(key => config[key] !== saved[key]))
        fail('请先停止 EasyTier，再修改配置。', 'WORLD_INTERNET_BUSY')
    }
    await mkdir(dir, { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(hide ? {...config, startupRemoved:true} : config, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, file)
    } finally { await unlink(temporary).catch(() => {}) }
    removed = hide; savedAutoStart = config.autoStart
    secrets.add(config.secret)
    configPromise = Promise.resolve(config)
    connectionProbe.invalidate()
    return config
  }
  function capture(stream, source) {
    const decoder = new StringDecoder('utf8')
    let pending = '', dropping = false
    const consume = text => {
      for (const part of text.split(/(?<=\n)/u)) {
        if (!dropping) pending += part
        if (pending.length > 65536) { pending = ''; dropping = true }
        if (part.endsWith('\n')) {
          log(source, dropping ? '超长单行日志已省略。' : pending.replace(/[\r\n]+$/u, ''))
          pending = ''; dropping = false
        }
      }
    }
    stream?.on('data', bytes => consume(decoder.write(bytes)))
    return () => { consume(decoder.end()); if (pending || dropping) log(source, dropping ? '超长单行日志已省略。' : pending) }
  }
  async function start(value, expected) {
    if (!PLATFORMS.has(platform)) fail('上网功能支持 Windows、macOS 和 Linux。')
    if (current) return snapshot()
    connectionProbe.invalidate()
    const config = value ? await save(value, undefined, expected) : normalizeInternetConfig(await load(), platform)
    let executable = internetExecutable(config.directory, platform)
    if (config.directory) {
      try { if (!(await stat(executable)).isFile()) throw new Error('not a file') }
      catch { fail(`找不到 ${executable}，请检查程序目录。`) }
      if (platform !== 'win32') {
        try { await access(executable, constants.X_OK) }
        catch { fail(`EasyTier 文件不可执行，请为 ${executable} 添加执行权限后重试。`) }
      }
    }
    let allowed
    try { allowed = await privilege() }
    catch { fail('无法检测 EasyTier 启动权限，请检查系统权限检测是否可用后重试。', 'WORLD_INTERNET_PRIVILEGE') }
    const elevate = platform === 'win32' && !allowed
    if (platform !== 'win32' && !allowed) fail(internetPermissionHint(platform), 'WORLD_INTERNET_PRIVILEGE')
    if (elevate && !config.directory) {
      // UAC starts in a different environment. Resolve PATH before requesting elevation.
      const path = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] || ''
      let found = ''
      for (const folder of path.split(';').filter(Boolean)) {
        const candidate = win32.resolve(folder.replace(/^"|"$/gu, ''), executable)
        try { if ((await stat(candidate)).isFile()) { found = candidate; break } } catch {}
      }
      if (!found) fail('找不到 easytier-core.exe，请填写程序目录或加入 DSH 的 PATH。')
      executable = found
    }
    if (disposed) fail('上网服务已关闭。')
    phase = elevate ? 'authorizing' : 'starting'; startedAt = Date.now(); exitCode = null; lastError = ''
    secrets.add(config.secret)
    if (elevate) log('系统', '请在 Windows 授权窗口中允许 EasyTier 以管理员权限启动。')
    log('系统', `启动 EasyTier · ${config.ipv4} · ${config.peer}`)
    let child
    try {
      child = (elevate ? elevatedSpawnImpl : spawnImpl)(executable, ['-i', config.ipv4, '--network-secret', config.secret, '-p', config.peer], {
        cwd: config.directory || undefined, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
      })
    } catch (error) {
      phase = 'failed'; lastError = redact(`无法启动 EasyTier：${error.message}`); log('系统', lastError)
      fail(lastError)
    }
    let finish
    const run = { child, elevated: elevate, done: new Promise(resolve => { finish = resolve }) }
    current = run
    const flushOut = capture(child.stdout, '输出'), flushErr = capture(child.stderr, '错误')
    child.on('error', error => {
      lastError = redact(error.code === 'ENOENT' ? `找不到 ${executable}，请安装 EasyTier 并填写程序目录，或加入 DSH 的 PATH 后重试。`
        : error.code === 'EACCES' || error.code === 'EPERM' ? `无法执行 ${executable}，请检查文件执行权限。`
          : `无法运行 EasyTier：${error.message}`)
      log('系统', lastError)
    })
    child.once('close', (code, signal) => {
      flushOut(); flushErr()
      if (current === run) {
        const stopped = phase === 'stopping'
        current = null; exitCode = code
        connectionProbe.invalidate()
        phase = stopped || (code === 0 && !lastError) ? 'stopped' : 'failed'
        if (phase === 'failed' && !lastError) lastError = 'EasyTier 已退出，请查看下方日志。'
        if (phase === 'failed' && run.permissionDenied)
          lastError = internetPermissionHint(platform)
        log('系统', `EasyTier 已退出（${signal || `退出码 ${code}`}）。`)
      }
      finish()
    })
    try {
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      if (current === run) phase = 'running'
    } catch (error) {
      await run.done
      fail(lastError || redact(`无法启动 EasyTier：${error.message}`))
    }
    return snapshot()
  }
  async function stop() {
    const run = current
    if (!run) return snapshot()
    phase = 'stopping'; lastError = ''; log('系统', '正在停止 EasyTier…')
    try { run.child.kill() } catch (error) { fail(redact(`无法停止 EasyTier：${error.message}`)) }
    let timer
    const exited = await Promise.race([run.done.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), stopMs) })])
    clearTimeout(timer)
    if (!exited) fail('EasyTier 尚未退出，请重试停止。', 'WORLD_INTERNET_STOP')
    return snapshot()
  }
  // The host owns this one-shot task, not the web client. Serialize it with manual
  // start/stop/save so reopening a window or attaching a phone cannot launch twice.
  async function autoLaunch() {
    if (disposed || !PLATFORMS.has(platform)) return
    let config
    try { config = await load() } catch {
      if (!disposed) { phase = 'failed'; lastError = '无法读取上网配置，未自动启动。'; log('系统', lastError) }
      return
    }
    if (disposed || !config.autoStart) return
    const existing = await connectionProbe.read(config)
    if (disposed) return
    if (existing.connected && existing.ipv4 === config.ipv4.split('/')[0]) {
      log('系统', '已有 EasyTier 连接，跳过自动启动。'); return
    }
    log('系统', '随 World 启动上网。')
    await start()
  }
  // Keep legacy internet.json authoritative. Managing this entry neither exposes the
  // network secret nor creates another copy of the setting in startup.json.
  const managerConfig = () => load().catch(() => fail('上网配置读取失败，请在「上网」检查配置。'))
  startup?.register('internet', {
    name:'上网（EasyTier）', start:autoLaunch,
    async read() {
      const config = await managerConfig()
      return removed || !config.secret ? 'removed' : config.autoStart ? 'enabled' : 'disabled'
    },
    write(next, signal) {
      const work = queue.then(async () => {
        signal?.throwIfAborted(); if (disposed) fail('上网服务已关闭。')
        const config = await managerConfig()
        if (!config.secret) fail('请先在「上网」保存连接配置。')
        await save({...config,autoStart:next === 'enabled'},next)
      })
      queue=work.catch(()=>{}); return work
    },
  })
  queue = queue.then(() => startup ? startup.run('internet',bootSignal) : autoLaunch()).catch(error => {
    if (disposed || phase === 'failed' && lastError) return
    phase = 'failed'; lastError = redact(`自动启动上网失败：${error.message}`); log('系统', lastError)
  })
  return {
    call(operation, payload = {}, signal) {
      signal?.throwIfAborted()
      if (disposed) return Promise.reject(new Error('上网服务已关闭。'))
      if (operation === 'status') return Promise.resolve(snapshot())
      if (operation === 'connection') return load().then(config => connectionProbe.read(config))
      if (operation === 'info') return Promise.all([load(), privilege().catch(() => null)]).then(([config]) => ({ ...snapshot(), config }))
      const task = queue.then(async () => {
        signal?.throwIfAborted()
        if (disposed) fail('上网服务已关闭。')
        if (operation === 'save') return { ...snapshot(), config: await save(payload.config, undefined, payload.expectedAutoStart) }
        if (operation === 'start') return start(payload.config, payload.expectedAutoStart)
        if (operation === 'stop') return stop()
        if (operation === 'clear') { logs = ''; truncated = false; return snapshot() }
        fail('不支持的上网操作。')
      })
      queue = task.catch(() => {})
      return task
    },
    async dispose() {
      disposed = true
      connectionProbe.dispose()
      if (phase === 'authorizing') current?.child.kill()
      await queue; await stop()
    },
  }
}
