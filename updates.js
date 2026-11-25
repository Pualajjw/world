import { constants, copyFile, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve, basename, relative, isAbsolute, sep } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

export const WORLD_PACKAGE = '@local/dsh-world'
export const WORLD_REPOSITORY = 'https://github.com/Pualajjw/world.git'
const PBPKG_PACKAGE = '@local/dsh-pbpkg'
const fail = (message, code = 'WORLD_UPDATE') => { throw Object.assign(new Error(message), { code }) }
const unwrap = value => {
  if (value?.ok === false) fail(value.error?.message || '插件管理器调用失败。', value.error?.code)
  return value?.ok === true ? value.value : value
}
const semver = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value)
export function compareVersions(a, b) {
  const av = semver(a), bv = semver(b)
  if (!av || !bv) fail('版本号无效，无法比较。')
  for (let index = 1; index <= 3; index++) if (Number(av[index]) !== Number(bv[index])) return Number(av[index]) > Number(bv[index]) ? 1 : -1
  if (!av[4] || !bv[4]) return av[4] ? -1 : bv[4] ? 1 : 0
  const ap = av[4].split('.'), bp = bv[4].split('.')
  for (let index = 0; index < Math.max(ap.length, bp.length); index++) {
    if (ap[index] === bp[index]) continue
    if (ap[index] === undefined || bp[index] === undefined) return ap[index] === undefined ? -1 : 1
    const an = /^\d+$/u.test(ap[index]), bn = /^\d+$/u.test(bp[index])
    if (an && bn) return Number(ap[index]) > Number(bp[index]) ? 1 : -1
    if (an !== bn) return an ? -1 : 1
    return ap[index] > bp[index] ? 1 : -1
  }
  return 0
}
const bundleManifest = (manifest, packageName = WORLD_PACKAGE) => {
  if (manifest?.name !== packageName || !semver(manifest.version) || typeof manifest.dsh?.bundle?.patch !== 'string')
    fail('更新包的名称、版本或 DSH 插件声明不正确，未安装。')
  return manifest
}
const missingFile = error => error?.code === 'ENOENT' || /^ENOENT\b/u.test(error?.message || '')
const stalePackage = error => missingFile(error) || /该 TGZ 已不在仓库索引中/u.test(error?.message || '')
const sourceNameOf = listing => `pbpkg · ${listing.sources?.find(source => source.id === listing.activeSourceId)?.name || '当前源'}`
function worldUpdateRow(listing) {
  const rows = (listing.rows || []).filter(row => row.packageName === WORLD_PACKAGE || /^world-(?:\d+\.\d+\.\d+|latest)(?:-[\w.-]+)?\.tgz$/iu.test(row.filename || row.path?.split('/').at(-1) || ''))
    .filter(row => !row.packageName || row.packageName === WORLD_PACKAGE)
    .sort((a, b) => {
      const version = row => row.packageVersion || /world-(\d+\.\d+\.\d+(?:-[\w.]+)?)-universal\.tgz$/iu.exec(row.filename || '')?.[1]
        || /world-(\d+\.\d+\.\d+)/iu.exec(row.filename || row.path || '')?.[1]
      return semver(version(a)) && semver(version(b)) ? compareVersions(version(b), version(a)) : 0
    })
  if (!rows.length) fail('pbpkg 当前源没有 world 更新包，请在 pbpkg 中检查或切换源。')
  return rows.find(row => /(?:-universal)?\.tgz$/iu.test(row.filename || row.path)) || rows[0]
}

/** The launcher's installation anchor identifies DSH; Node/Electron versions are unrelated. */
export async function readDshVersion(profile, { readText = file => readFile(file, 'utf8') } = {}) {
  if (!profile?.installAnchor) return null
  try {
    const manifest = JSON.parse(await readText(profile.installAnchor))
    return manifest.name === '@deepseek-ai/dsh' && semver(manifest.version) ? manifest.version : null
  } catch { return null }
}

/** Read only the manifest of pbpkg's verified, content-addressed TGZ. */
export const verifiedWorldArtifact = (artifact, cacheDir) => verifiedBundleArtifact(artifact, cacheDir, WORLD_PACKAGE)

export async function verifiedBundleArtifact(artifact, cacheDir, packageName) {
  if (typeof artifact?.spec !== 'string' || !artifact.spec.startsWith('file:') || !/^[a-f\d]{64}$/iu.test(artifact.sha256))
    fail('pbpkg 未返回可校验的本地更新包。')
  const expected = join(await realpath(cacheDir), artifact.sha256.toLowerCase() + '.tgz')
  const file = await realpath(artifact.spec.slice(5))
  if (resolve(file) !== resolve(expected) || basename(file) !== artifact.sha256.toLowerCase() + '.tgz') fail('更新包不在 pbpkg 校验缓存内。')
  const metadata = await stat(file)
  if (!metadata.isFile() || metadata.size > 32 * 1024 * 1024) fail('插件包大小无效。')
  const bytes = await readFile(file)
  if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256.toLowerCase()) fail('更新包校验失败，请重新检查更新。')
  const tar = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 })
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    const text = (from, to) => header.subarray(from, to).toString('utf8').replace(/\0.*$/su, '')
    const name = text(0, 100), prefix = text(345, 500)
    if (!name) break
    const sizeText = text(124, 136).trim()
    if (!/^[0-7]+$/u.test(sizeText)) fail('更新包 tar 长度无效。')
    const size = Number.parseInt(sizeText, 8), start = offset + 512
    if (start + size > tar.length) fail('更新包不完整。')
    if ((prefix ? prefix + '/' : '') + name === 'package/package.json') {
      if (size > 1024 * 1024 || ![0, 48].includes(header[156])) fail('更新包 manifest 无效。')
      return { manifest: bundleManifest(JSON.parse(tar.subarray(start, start + size).toString('utf8')), packageName), spec: `file:${file.replaceAll('\\', '/')}` }
    }
    offset = start + Math.ceil(size / 512) * 512
  }
  fail('更新包缺少 package/package.json。')
}

/** Call the existing pbpkg endpoints as a trusted in-process owner, without opening a network port. */
export function pbpkgCaller(connection) {
  return async (operation, payload, signal) => {
    if (!connection?.createSharedFetchHandler || !connection.browserPeer) fail('当前宿主无法调用 pbpkg，请升级 DSH。')
    const method = `pbpkg/${operation}`, rpcId = randomUUID()
    const response = await connection.createSharedFetchHandler('/api').fetch(new Request(`http://localhost/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    }), connection.browserPeer)
    if (!response.ok) fail('pbpkg 接口不可用，请启用 pbpkg 后重试。')
    const reply = await response.json()
    if (reply.type !== 'server-response' || reply.rpcId !== rpcId) fail('pbpkg 返回了无效响应。')
    return unwrap(reply.result)
  }
}

// DSH can hot-reload world while installBundle is still settling. Keep the native
// job (not tokens or services) in this process/profile until DSH actually restarts.
function profileUpdateState(dir) {
  const initial = { job: { state: 'idle' } }
  if (!dir) return initial
  const byProfile = globalThis[Symbol.for('@local/dsh-world/update-jobs')] ??= new Map()
  const key = resolve(dir)
  if (!byProfile.has(key)) byProfile.set(key, initial)
  return byProfile.get(key)
}

export function createWorldUpdates({ currentVersion, manager: getManager, profile: getProfile,
  runtimeDir,
  pbpkg: callPbpkg, cacheDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'pbpkg', 'tarballs'),
  fetchJson, verifyArtifact = verifiedWorldArtifact, readVersion = readDshVersion, now = Date.now,
} = {}) {
  const lifetime = new AbortController()
  let checking = false, starting = false, candidate = null, disposed = false
  const manager = () => typeof getManager === 'function' ? getManager() : getManager
  const profile = () => typeof getProfile === 'function' ? getProfile() : getProfile
  const state = profileUpdateState(runtimeDir && profile()?.dir)
  const json = fetchJson || (async (url, signal) => {
    const response = await fetch(url, { signal, redirect: 'error', headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-world-updater' } })
    if (!response.ok) fail(`GitHub 检查更新失败（HTTP ${response.status}），请稍后重试。`)
    if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) fail('GitHub 响应过大。')
    let length = 0
    const chunks = []
    for await (const chunk of response.body) {
      length += chunk.length; chunks.push(Buffer.from(chunk))
      if (length > 2 * 1024 * 1024) fail('GitHub 响应过大。')
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  })
  async function info(includeSource = false) {
    const installed = typeof manager()?.listBundles === 'function' ? unwrap(await manager().listBundles()) : []
    const pbpkg = installed.find?.(item => item.name === PBPKG_PACKAGE && item.installed === true)
    const world = installed.find?.(item => item.name === WORLD_PACKAGE && item.installed)
    let savedSource = world?.source || ''
    if (profile()?.dir) {
      try { savedSource = JSON.parse(await readFile(join(profile().dir, 'package.json'), 'utf8')).dependencies?.[WORLD_PACKAGE] || savedSource } catch {}
    }
    let developmentLink = /^(?:link|workspace|portal):/iu.test(savedSource)
    if (world && runtimeDir && profile()?.dir) {
      const [modules, actual] = await Promise.all([realpath(join(profile().dir, 'node_modules')), realpath(runtimeDir)])
      const outside = relative(modules, actual)
      developmentLink ||= outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside)
    }
    const installedVersion = world?.version || currentVersion
    return { currentVersion, dshVersion: await readVersion(profile()), source: pbpkg ? 'pbpkg' : 'github',
      pbpkgEnabled: pbpkg ? pbpkg.enabled !== false : false,
      ...(includeSource ? { savedSource } : {}), installed: Boolean(world?.version),
      installedVersion, restartRequired: installedVersion !== currentVersion ||
        (state.job.operation === 'reinstall' && state.job.state === 'success' && state.job.version === installedVersion),
      canInstall: typeof manager()?.installBundle === 'function' && !developmentLink,
      blockReason: developmentLink ? 'world 当前通过开发目录链接加载，请先以 TGZ 或 GitHub 方式安装后再使用内置升级。' : '',
      job: structuredClone(state.job) }
  }
  async function pbpkgUpdate(active) {
    const list = async () => {
      try { return await callPbpkg('list', {}, active) }
      catch (error) {
        active.throwIfAborted()
        if (missingFile(error)) fail('pbpkg 当前源目录或 index.json 不存在，请在 pbpkg 中检查源路径后重试。', 'WORLD_UPDATE_SOURCE_MISSING')
        throw error
      }
    }
    let listing = await list(), row = worldUpdateRow(listing)
    for (let attempt = 0; attempt < 2; attempt++) {
      let artifact
      try { artifact = await callPbpkg('prepare', { path: row.path, sourceId: row.sourceId || listing.activeSourceId }, active) }
      catch (error) {
        active.throwIfAborted()
        if (!stalePackage(error)) throw error
        if (!attempt) {
          // Publishing may replace the index between list and prepare. Retry only a changed row in the same source.
          const fresh = await list()
          if (fresh.activeSourceId !== listing.activeSourceId) fail('更新来源已变化，请重新检查。')
          const next = worldUpdateRow(fresh)
          if (next.path !== row.path || next.sha256 !== row.sha256) { listing = fresh; row = next; continue }
        }
        const filename = row.filename || row.path?.split(/[\\/]/u).at(-1) || 'world TGZ'
        fail(`${sourceNameOf(listing)} 的索引引用了不存在的安装包「${filename}」。请在该源重新打包 world 并更新 index.json，或在 pbpkg 中切换到有效源后重试。`, 'WORLD_UPDATE_SOURCE_INCOMPLETE')
      }
      active.throwIfAborted()
      if (artifact.sha256 !== row.sha256) fail('pbpkg 更新包已变化，请重新检查。')
      let verified
      try { verified = await verifyArtifact(artifact, cacheDir) }
      catch (error) {
        active.throwIfAborted()
        if (missingFile(error)) fail('本地更新包缓存已失效，请重试以重新获取并校验更新包。', 'WORLD_UPDATE_CACHE_MISSING')
        throw error
      }
      return { ...verified, digest: artifact.sha256, sourceName: sourceNameOf(listing) }
    }
  }
  function operationFor(version, details) {
    if (compareVersions(version, currentVersion) > 0 && compareVersions(version, details.installedVersion) > 0) return 'install'
    if (details.installed && version === currentVersion && version === details.installedVersion && !details.restartRequired) return 'reinstall'
    return null
  }
  async function check(signal) {
    if (checking || starting || state.job.state === 'installing') fail('正在检查或升级，请等待完成。', 'WORLD_UPDATE_BUSY')
    checking = true; candidate = null
    try {
      const details = await info(), active = AbortSignal.any([lifetime.signal, AbortSignal.timeout(120000), ...(signal ? [signal] : [])])
      let manifest, spec, sourceName, digest
      if (details.source === 'pbpkg') {
        if (!details.pbpkgEnabled) fail('已安装 pbpkg，但尚未启用。请先启用 pbpkg，再检查 world 更新。')
        ;({ manifest, spec, digest, sourceName } = await pbpkgUpdate(active))
      } else {
        const commit = await json('https://api.github.com/repos/Pualajjw/world/commits/HEAD', active)
        if (!/^[a-f\d]{40}$/u.test(commit.sha)) fail('GitHub 未返回可验证的提交号。')
        manifest = bundleManifest(await json(`https://raw.githubusercontent.com/Pualajjw/world/${commit.sha}/package.json`, active))
        spec = `git+${WORLD_REPOSITORY}#${commit.sha}`; sourceName = 'GitHub · Pualajjw/world'
      }
      active.throwIfAborted()
      const baseline = compareVersions(details.installedVersion, currentVersion) > 0 ? details.installedVersion : currentVersion
      const operation = operationFor(manifest.version, details)
      if (operation) candidate = { operation, token: randomUUID(), checkedAt: now(), version: manifest.version, spec, source: details.source, sourceName, digest }
      return { ...details, latestVersion: manifest.version, available: operation === 'install', reinstallable: operation === 'reinstall',
        sourceName, token: candidate?.token || null, sourceOlder: compareVersions(manifest.version, baseline) < 0 }
    } finally { checking = false }
  }
  async function install(plan, savedSource) {
    try {
      const m = manager()
      if (!m?.installBundle || !m.inspect) fail('当前 DSH 未提供插件安装能力。')
      let spec = plan.spec
      // An identical saved dependency can be a pnpm no-op (or an ambiguous install in DSH).
      // Give DSH a real replacement from the same checked bytes/commit, without uninstalling world.
      if (plan.source === 'pbpkg') {
        const file = spec.slice(5), size = (await stat(file)).size
        let dir = cacheDir
        if (plan.operation === 'reinstall' && savedSource.startsWith('file:') &&
          relative(resolve(profile()?.dir || '.', savedSource.slice(5)), file) === '') {
          // The profile keeps this dependency path across restarts, so never use a temporary file.
          dir = join(cacheDir, 'world-reinstall')
          await mkdir(dir, { recursive: true })
          const copy = join(dir, `${plan.digest}.tgz`)
          try { await copyFile(file, copy, constants.COPYFILE_EXCL) } catch (error) { if (error.code !== 'EEXIST') throw error }
          spec = `file:${copy.replaceAll('\\', '/')}`
        }
        const artifact = await verifyArtifact({ spec, sha256: plan.digest, size }, dir)
        spec = artifact.spec
        if (artifact.manifest.version !== plan.version) fail('更新包版本已变化。')
      } else if (plan.operation === 'reinstall' && savedSource && !savedSource.startsWith('file:') && !savedSource.endsWith('.tar.gz')) {
        spec = `${WORLD_REPOSITORY.slice(0, -4)}/archive/${plan.spec.split('#')[1]}.tar.gz`
      }
      const checked = unwrap(await m.inspect(spec, {}, lifetime.signal))
      if (checked?.status !== 'accepted') fail(checked?.reason || 'DSH 拒绝此更新。')
      const result = unwrap(await m.installBundle(spec, { enabled: true, requestId: state.job.requestId,
        expected: { name: WORLD_PACKAGE, version: plan.version } }))
      if (!result || !['applied', 'restart-required'].includes(result.application)) {
        const detail = result?.error?.diagnostic || result?.error?.message || result?.packageResult?.output || '安装未完成。'
        fail(`${detail}${result?.pendingBuilds?.length ? ' 需要构建脚本审批，请通过 DSH 添加插件入口继续。' : ''}`)
      }
      state.job = { ...state.job, state: 'success', restartRequired: true, message: `world ${plan.version} 已安装，请重启 DSH。` }
    } catch (error) { state.job = { ...state.job, state: 'error', message: error.message || String(error) } }
  }
  return {
    async call(operation, payload = {}, signal) {
      if (disposed) fail('升级服务已关闭。')
      if (operation === 'info') return info()
      if (operation === 'check') return check(signal)
      if (operation === 'status') return { ...structuredClone(state.job), installedVersion: (await info()).installedVersion }
      if (operation === 'install' || operation === 'reinstall') {
        if (state.job.state === 'installing' || checking || starting) fail('升级正在执行，请勿重复提交。', 'WORLD_UPDATE_BUSY')
        starting = true
        try {
          if (!candidate || operation !== candidate.operation || payload.token !== candidate.token || payload.confirmed !== true || now() - candidate.checkedAt > 10 * 60000)
            fail('更新信息已失效，请重新检查更新。')
          const details = await info(true)
          if (!details.canInstall) fail(details.blockReason || '当前 DSH 未提供插件安装能力。')
          if (details.source !== candidate.source || candidate.source === 'pbpkg' && !details.pbpkgEnabled) fail('更新来源已变化，请重新检查。')
          if (operationFor(candidate.version, details) !== operation) fail('本地版本或安装状态已变化，请重新检查更新。')
          const plan = candidate; candidate = null
          state.job = { state: 'installing', operation, requestId: randomUUID(), version: plan.version, sourceName: plan.sourceName, message: '正在校验并安装更新…' }
          void install(plan, details.savedSource)
          return structuredClone(state.job)
        } finally { starting = false }
      }
      fail('不支持的升级操作。')
    },
    dispose() { disposed = true; lifetime.abort() },
  }
}
