/** Install the DSH pbnpm bundle (not the CLI or pbnpm-pbd) from a configured development feed or Gitee. */
import { constants, copyFile, mkdir, readFile, realpath, stat, writeFile, rename, unlink } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { compareVersions, verifiedBundleArtifact } from './updates.js'

const NAME = '@local/dsh-pbnpm', PBPKG = '@local/dsh-pbpkg'
const BASE = 'https://gitee.com/paulajam/pbpkg/raw/master/', MAX = 32 * 1024 * 1024
const unwrap = r => { if (r?.ok === false) throw new Error(r.error?.message || 'DSH 插件管理器不可用'); return r?.ok === true ? r.value : r }
const missing = e => ['ENOENT', 'ENOTDIR'].includes(e?.code) || /^(?:ENOENT|ENOTDIR)\b|该 TGZ 已不在仓库索引中/u.test(e?.message || '')
const fileSpec = path => `file:${path.replaceAll('\\', '/')}`

function packageRow(index, remote) {
  if (index.schema !== 1 || !index.packages) throw new Error('无效的 pbpkg 插件索引')
  const rows = []
  for (const row of Object.values(index.packages)) {
    if (row?.type !== 'tgz' || typeof row.path !== 'string' || row.path.split('/').some(p => !/^[\w.-]+$/u.test(p) || p === '.' || p === '..')) continue
    if (remote && !row.path.startsWith('p/pbnpm/')) continue
    const match = /^pbnpm-(\d+\.\d+\.\d+)-win32-x86\.tgz$/u.exec(row.path.split('/').at(-1))
    if (!match) continue
    if (typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.sha256) || !Number.isSafeInteger(row.size) || row.size < 1 || row.size > MAX) continue
    rows.push({ path: row.path, version: match[1], sha256: row.sha256, size: row.size })
  }
  return rows.sort((a, b) => compareVersions(b.version, a.version))[0]
}

async function giteeBytes(path, limit, signal) {
  let url = new URL(path, BASE)
  for (let n = 0; n < 4; n++) {
    const response = await fetch(url, { signal, redirect: 'manual' })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      url = new URL(response.headers.get('location'), url)
      if (url.protocol !== 'https:' || url.username || url.password || !['gitee.com', 'raw.giteeusercontent.com'].includes(url.host)) throw new Error('Gitee 下载地址无效')
      continue
    }
    if (!response.ok || Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error(`Gitee 请求失败或文件过大（HTTP ${response.status}）`) }
    const chunks = []; let size = 0
    for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw new Error('Gitee 响应过大'); chunks.push(chunk) }
    return Buffer.concat(chunks)
  }
  throw new Error('Gitee 重定向过多')
}

export function createPbnpmInstaller({ manager, profile, pbpkg, home, download = giteeBytes }) {
  const lifetime = new AbortController(), devCache = join(home, 'pbpkg', 'tarballs'), remoteCache = join(home, 'world', 'pbnpm')
  let installing = false, plan, cachedRemote
  async function installed() {
    const m = manager()
    if (!m?.listBundles || !m.inspect || !m.installBundle) throw new Error('当前 DSH 不支持插件安装')
    const bundles = unwrap(await m.listBundles()), bundle = bundles.find(b => b.name === NAME && b.installed)
    const version = bundle?.version || null
    if (bundle && !version) throw new Error('无法确定已安装的 pbnpm 版本')
    return { version, enabled: bundle ? bundle.enabled !== false : null, source: bundle?.source, hasDev: bundles.some(b => b.name === PBPKG && b.installed && b.enabled !== false) }
  }
  async function confirmedState(selected) {
    const current = await installed()
    if (current.version !== selected.installedVersion || current.enabled !== selected.enabled) throw new Error('pbnpm 安装状态已变化，请重试')
    return current
  }
  async function choose(hasDev, prepare, signal) {
    if (hasDev) {
      // `list` only sees the active source. Read registered local indexes without switching the user's source.
      let registry
      try { registry = await pbpkg('sources', {}, signal) } catch { signal.throwIfAborted() }
      const sources = (registry?.sources || []).filter(s => s.type === 'local' || s.type === 'shared')
      const rank = s => Number(s.id === registry.activeSourceId) * 2 + Number(/开发|dev/iu.test(s.name))
      for (const source of sources.sort((a, b) => rank(b) - rank(a))) {
        try {
          const index = JSON.parse(await readFile(join(source.location, source.indexPath || 'index.json'), { encoding: 'utf8', signal }))
          const row = packageRow(index, false)
          if (!row) continue
          await stat(join(source.location, row.path))
          const artifact = prepare && await pbpkg('prepare', { sourceId: source.id, path: row.path }, signal)
          if (artifact && (artifact.sha256 !== row.sha256 || artifact.size !== row.size)) throw new Error('开发源的 pbnpm 包已变更，请重试')
          return { row, artifact, dir: devCache, source: `开发 pbpkg · ${source.name}` }
        } catch (e) {
          signal.throwIfAborted()
          if (!missing(e) && !['EACCES', 'EPERM', 'ENETUNREACH', 'EHOSTUNREACH'].includes(e?.code)) throw e
        }
      }
    }
    if (!prepare && cachedRemote && cachedRemote.expires > Date.now()) return cachedRemote.value
    const row = packageRow(JSON.parse((await download('index.json', 2 * 1024 * 1024, signal)).toString('utf8')), true)
    if (!row) throw new Error('开发源和 Gitee 均未找到 pbnpm 插件包')
    const value = { row, dir: remoteCache, source: 'Gitee 直连' }
    cachedRemote = { value, expires: Date.now() + 60000 }
    return value
  }
  async function remoteArtifact({ row, dir }, signal) {
    const path = join(dir, `${row.sha256}.tgz`)
    try { await stat(path) } catch (e) {
      if (!missing(e)) throw e
      const bytes = await download(row.path, row.size, signal)
      if (bytes.length !== row.size || createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new Error('Gitee pbnpm 下载校验失败')
      await mkdir(dir, { recursive: true }); const tmp = `${path}.${randomUUID()}.tmp`
      try { await writeFile(tmp, bytes, { flag: 'wx' }); await rename(tmp, path) } finally { await unlink(tmp).catch(e => { if (!missing(e)) throw e }) }
    }
    return { spec: fileSpec(path), sha256: row.sha256, size: row.size }
  }
  return { dispose() { lifetime.abort() }, async call(op, payload = {}, requestSignal) {
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(60000), ...(requestSignal ? [requestSignal] : [])])
    if (op === 'info' || op === 'prepare') {
      const current = await installed(), info = { installedVersion: current.version, enabled: current.enabled, installing }
      let selected
      try { selected = await choose(current.hasDev, op === 'prepare', signal) } catch (e) {
        if (op === 'info') return { ...info, error: e.message }; throw e
      }
      const { row, source } = selected
      if (op === 'info') return { ...info, version: row.version, source }
      if (installing) throw new Error('pbnpm 正在安装')
      const token = randomUUID(); plan = { ...selected, installedVersion: current.version, enabled: current.enabled, token, expires: Date.now() + 600000 }
      return { ...info, token, version: row.version, source }
    }
    if (op !== 'install') throw new Error('不支持的 pbnpm 操作')
    if (installing) throw new Error('pbnpm 正在安装，请勿重复提交')
    if (!plan || payload.confirmed !== true || payload.token !== plan.token || Date.now() > plan.expires) throw new Error('安装信息已过期，请重新选择 pbnpm')
    const selected = plan; plan = null; installing = true
    try {
      const current = await confirmedState(selected), dir = profile()?.dir
      let saved = current.source || ''
      if (dir && current.version) saved = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).dependencies?.[NAME] || saved
      if (/^(?:link|workspace|portal):/iu.test(saved)) throw new Error('pbnpm 是开发目录链接，请先在插件管理中移除链接再安装')
      const artifact = selected.artifact || await remoteArtifact(selected, signal)
      let cache = selected.dir
      let checked = await verifiedBundleArtifact(artifact, cache, NAME)
      if (checked.manifest.version !== selected.row.version) throw new Error('pbnpm 包版本与确认的版本不符')
      // pnpm may skip an identical file: dependency. Alternate two durable, verified paths for the same digest.
      if (saved.startsWith('file:') && relative(resolve(dir || '.', saved.slice(5)), checked.spec.slice(5)) === '') {
        cache = join(remoteCache, 'reinstall'); await mkdir(cache, { recursive: true })
        const copy = join(await realpath(cache), `${artifact.sha256}.tgz`)
        try { await copyFile(checked.spec.slice(5), copy, constants.COPYFILE_EXCL) } catch (e) { if (e.code !== 'EEXIST') throw e }
        checked = await verifiedBundleArtifact({ ...artifact, spec: fileSpec(copy) }, cache, NAME)
      }
      const m = manager(), review = unwrap(await m.inspect(checked.spec, {}, signal))
      if (review?.status !== 'accepted') throw new Error(review?.reason || 'DSH 拒绝安装 pbnpm')
      // Download and inspection can outlast a change in the plugin manager.
      await confirmedState(selected)
      signal.throwIfAborted()
      const enabled = current.enabled ?? true
      const result = unwrap(await m.installBundle(checked.spec, { enabled, requestId: randomUUID(), expected: { name: NAME, version: selected.row.version } }))
      if (!['applied', 'restart-required'].includes(result?.application)) throw new Error(result?.error?.diagnostic || result?.error?.message || result?.packageResult?.output?.slice(-1000) || result?.error?.code || 'DSH 未完成 pbnpm 安装')
      return { installedVersion: selected.row.version, enabled, version: selected.row.version, source: selected.source, restartRequired: result.application === 'restart-required' }
    } finally { installing = false }
  } }
}
