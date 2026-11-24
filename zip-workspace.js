/** A VSCode-only filesystem view. No member path is ever extracted onto the host. */
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { open, rename, rm, stat as diskStat } from 'node:fs/promises'

const ZIP = Symbol('world zip member'), LIMIT = 16 * 1024 * 1024, MAX_NODES = 50000
const slash = path => path.replaceAll('\\', '/')
const readerOptions = { filenameValidation: 'strict', filenameEncoding: 'gbk', maxAppendedDataSize: 0, useWebWorkers: false }
const virtualPath = /\.zip\.workspace(?:[\\/]|$)/i
const codec = () => import('./vendor/zip-native.min.js')
const member = (archive, root, name = '') => ({ [ZIP]: true, archive, root, name })
const entryVersion = e => `zip:${e.crc32}:${e.uncompressedSize}` // unrelated entries stay editable after a save

export function createZipWorkspace(host, { FsError, writableRoots, withFileLock }) {
  const cache = new Map(), building = new Map()
  let cachedNodes = 0
  function forget(path) {
    const old = cache.get(path)
    if (old) { cache.delete(path); cachedNodes -= old.nodes.size }
  }
  function invalidate(path) { forget(path); building.delete(path) }
  const fail = (message, code = 'WORLD_ZIP_INVALID') => { throw new FsError(message, code) }
  const stale = () => fail('ZIP 或其中的文件已更改，请刷新后再保存。', 'FS_STALE_VERSION')
  const physical = t => host.processPath(t.archive)
  const rangeReader = async (archive, size) => {
    const { Reader } = await codec(), reader = new Reader()
    reader.size = size
    reader.readUint8Array = async (offset, length) => {
      if (length > LIMIT) fail('ZIP 目录过大。', 'FS_TOO_LARGE')
      const bytes = await host.readByteRange(archive, { offset, length })
      if (bytes.length !== length) stale()
      return bytes
    }
    return reader
  }
  async function build(t, info) {
    const { ZipReader } = await codec(), input = await rangeReader(t.archive, info.size)
    const root = { children: new Map(), depth: 0 }, nodes = new Map([['', root]])
    const reader = new ZipReader(input, readerOptions)
    // Most parents already exist. Resolve the complete parent key once instead of
    // splitting and rebuilding every prefix of every filename in the central directory.
    function insert(name, directory, missingParents = 0) {
      if (missingParents >= 128) fail('ZIP 含有不安全的文件路径。')
      let node = nodes.get(name)
      if (node) {
        if (!!node.children !== directory) fail('ZIP 中的文件名与目录冲突。')
        return node
      }
      const cut = name.lastIndexOf('/'), parent = cut < 0 ? root : insert(name.slice(0, cut), true, missingParents + 1)
      if (parent.depth >= 128) fail('ZIP 含有不安全的文件路径。')
      if (nodes.size >= MAX_NODES) fail('ZIP 条目过多。', 'FS_TOO_LARGE')
      node = directory ? { children: new Map(), depth: parent.depth + 1 } : {}
      nodes.set(name, node); parent.children.set(name.slice(cut + 1), node)
      return node
    }
    let firstOffset = Infinity, record = 0, previous
    for await (const entry of reader.getEntriesGenerator()) {
      firstOffset = Math.min(firstOffset, entry.offset)
      const name = entry.directory && entry.filename.endsWith('/') ? entry.filename.slice(0, -1) : entry.filename
      if (!name || name.length > 4096 || /[\\:\x00-\x1f]|^\/|\/$|\/\/|(?:^|\/)\.{1,2}(?:\/|$)/u.test(name)) fail('ZIP 含有不安全的文件路径。')
      const node = insert(name, entry.directory)
      if (node.entry) fail('ZIP 中有重复或冲突的路径。')
      // zip.js FileEntry owns a decoder closure, extra fields, dates, and raw byte views.
      // Keep only a directory-record locator and the fields used by stat/list/guards.
      const length = 46 + entry.rawFilename.length + entry.rawExtraField.length + entry.rawComment.length
      if (previous && previous.offset < entry.offset) previous.end = entry.offset
      previous = node.entry = { record, length, offset: entry.offset, end: null, crc32: entry.crc32, uncompressedSize: entry.uncompressedSize,
        directory: entry.directory, encrypted: entry.encrypted, symlink: entry.symlink }
      record += length
    }
    if ((await host.stat(t.archive))?.version !== info.version) stale()
    const protectedLayout = !!reader.digitalSignature || (Number.isFinite(firstOffset) && firstOffset !== 0)
    const directory = !protectedLayout && record === reader.directoryLength
      ? reader.directoryOffset : null
    return { nodes, input, comment: reader.comment, version: info.version, protectedLayout, directory }
  }
  async function index(t, signal) {
    signal?.throwIfAborted()
    const path = physical(t), info = await host.stat(t.archive, signal)
    if (info?.type !== 'file') fail('ZIP 文件不存在。', 'FS_NOT_FOUND')
    const hit = cache.get(path)
    if (hit?.version === info.version) {
      cache.delete(path); cache.set(path, hit); return hit
    }
    forget(path)
    let job = building.get(path)
    if (job?.version !== info.version) {
      job = { version: info.version }; building.set(path, job)
      job.value = build(t, info).then(idx => {
        if (building.get(path) === job) {
          while (cache.size && (cache.size >= 8 || cachedNodes + idx.nodes.size > MAX_NODES)) forget(cache.keys().next().value)
          cache.set(path, idx); cachedNodes += idx.nodes.size
        }
        return idx
      }).finally(() => { if (building.get(path) === job) building.delete(path) })
    }
    return job.value
  }

  // zip.js decodes a directory as a whole. To hydrate ONE entry, present its original
  // local block + central record + a one-entry EOCD (local header now at offset zero).
  // No ZIP bytes on disk are changed; zip.js still checks/decodes the real local header
  // and payload. Layouts that cannot be rebased safely use the normal archive reader.
  async function openEntry(idx, name, meta, signal) {
    const { ZipReader, Reader, Uint8ArrayReader } = await codec()
    let input = idx.input
    if (idx.directory !== null) {
      const local = meta.offset, size = Math.min(meta.end ?? idx.directory, idx.directory) - local
      const tail = Buffer.alloc(meta.length + 22)
      tail.set(await input.readUint8Array(idx.directory + meta.record, meta.length))
      // A ZIP64 offset sentinel or a prepended-data correction cannot be replaced
      // by changing the 32-bit field. Keep the decoder's full-archive handling there.
      if (size > 0 && size < 0xffffffff && local < 0xffffffff && tail.readUInt32LE(42) === local) {
        tail.writeUInt32LE(0, 42)
        tail.writeUInt32LE(0x06054b50, meta.length); tail.writeUInt16LE(1, meta.length + 8); tail.writeUInt16LE(1, meta.length + 10)
        tail.writeUInt32LE(meta.length, meta.length + 12); tail.writeUInt32LE(size, meta.length + 16)
        if (size <= 65536) {
          // One bounded I/O for the header + compressed content of a small file.
          input = new Uint8ArrayReader(Buffer.concat([await idx.input.readUint8Array(local, size), tail]))
        } else {
          input = new Reader(); input.size = size + tail.length
          input.readUint8Array = async (at, length) => {
            signal?.throwIfAborted()
            if (at >= size) return tail.subarray(at - size, at - size + length)
            const bytes = await idx.input.readUint8Array(local + at, Math.min(length, size - at))
            return bytes.length === length ? bytes : Buffer.concat([bytes, tail.subarray(0, length - bytes.length)])
          }
        }
      }
    }
    const reader = new ZipReader(input, readerOptions)
    for await (const entry of reader.getEntriesGenerator()) {
      signal?.throwIfAborted()
      if (entry.filename !== name) continue
      if (entryVersion(entry) !== entryVersion(meta) || entry.encrypted || entry.symlink || entry.directory) stale()
      return entry
    }
    stale()
  }
  async function mount(path, signal) {
    if (!isAbsolute(path) || !/\.zip$/i.test(path)) fail('请选择本地 ZIP 文件。')
    const archive = await host.resolve(path, { signal }), real = host.processPath(archive), root = real + '.workspace'
    if (!/\.zip$/i.test(real) || host.processPathFromHostPath(real) !== real) fail('只支持本机 ZIP 文件。')
    if (await host.lstat(root, {}, signal)) fail('同名 .zip.workspace 路径已存在，不会覆盖。')
    const t = member(archive, root); await index(t, signal)
    return { path: root }
  }
  const fs = {
    async resolve(path, opts = {}) {
      if (!virtualPath.test(path) && !virtualPath.test(opts.cwd || '')) return host.resolve(path, opts)
      const absolute = slash(resolve(opts.cwd || '.', path)), match = /^(.*?\.zip)\.workspace(?:\/(.*))?$/i.exec(absolute)
      if (match && !await host.lstat(`${match[1]}.workspace`, {}, opts.signal)) {
        const archive = await host.resolve(match[1], opts), real = host.processPath(archive)
        if (host.processPathFromHostPath(real) === real && (await host.stat(archive, opts.signal))?.type === 'file') return member(archive, real + '.workspace', match[2])
      }
      return host.resolve(path, opts)
    },
    processPath(t) { return t[ZIP] ? join(t.root, ...t.name.split('/')) : host.processPath(t) },
    contains(parent, child) {
      if (!parent[ZIP]) return host.contains(parent, child[ZIP] ? child.archive : child)
      return !!child[ZIP] && parent.root === child.root && (!parent.name || parent.name === child.name || child.name.startsWith(parent.name + '/'))
    },
    async lstat(path, opts, signal) {
      if (!virtualPath.test(path) && !virtualPath.test(opts?.cwd || '')) return host.lstat(path, opts, signal)
      const t = await fs.resolve(path, { ...opts, signal })
      return t[ZIP] ? fs.stat(t, signal) : host.lstat(path, opts, signal)
    },
    async stat(t, signal) {
      if (!t[ZIP]) return host.stat(t, signal)
      const idx = await index(t, signal), node = idx.nodes.get(t.name)
      return node && (node.children ? { type: 'directory', version: idx.version } : { type: 'file', version: entryVersion(node.entry), size: node.entry.uncompressedSize })
    },
    async listDir(t, signal) {
      if (!t[ZIP]) return host.listDir(t, signal)
      const children = (await index(t, signal)).nodes.get(t.name)?.children
      if (!children) fail('ZIP 目录不存在。', 'FS_NOT_DIRECTORY')
      return Array.from(children, ([name, n]) => ({ name, type: n.children ? 'directory' : 'file', size: n.entry?.uncompressedSize,
        target: member(t.archive, t.root, t.name ? `${t.name}/${name}` : name) }))
    },
    async readBytes(t, signal, max) {
      if (!t[ZIP]) return host.readBytes(t, signal, max)
      const idx = await index(t, signal), e = idx.nodes.get(t.name)?.entry, limit = Math.min(max, LIMIT)
      if (!e || e.directory || e.encrypted || e.symlink) fail('只能读取 ZIP 中未加密的普通文件。')
      if (e.uncompressedSize > limit) fail('ZIP 条目超过读取上限。', 'FS_TOO_LARGE')
      const chunks = []; let size = 0
      const entry = await openEntry(idx, t.name, e, signal)
      await entry.getData(new WritableStream({ write(chunk) {
        size += chunk.length; if (size > limit) fail('ZIP 条目超过读取上限。', 'FS_TOO_LARGE'); chunks.push(Buffer.from(chunk))
      } }), { signal, checkSignature: true, useWebWorkers: false })
      return Buffer.concat(chunks, size)
    },
    async writeText(t, content, intent, signal, policy) {
      if (!t[ZIP]) return host.writeText(t, content, intent, signal, policy)
      const path = physical(t)
      const authorize = async () => {
        const fresh = await host.resolve(path, { signal })
        if (host.processPath(fresh) !== path || host.processPathFromHostPath(path) !== path) stale()
        if (policy?.mode === 'danger-full-access') return
        if (policy?.mode === 'workspace-write') for (const root of writableRoots(policy)) {
          if (host.contains(await host.resolve(root, { signal }), fresh)) return
        }
        fail('ZIP 原文件不在会话可写范围内。', 'FS_SANDBOX_DENIED')
      }
      await authorize()
      return withFileLock(path, async () => {
        const idx = await index(t, signal), e = idx.nodes.get(t.name)?.entry
        if (idx.protectedLayout) fail('带签名或附加前缀的 ZIP 仅支持浏览，不会改写原文件。')
        if (!e || e.encrypted || e.directory || e.symlink || intent.kind !== 'replaceIfVersion' || entryVersion(e) !== intent.version) stale()
        const { ZipWriter, TextReader } = await codec(), mode = (await diskStat(path)).mode
        const tmp = join(dirname(path), `.world-zip-${randomUUID()}.tmp`), handle = await open(tmp, 'wx', mode)
        try {
          const output = new WritableStream({ async write(chunk) {
            signal?.throwIfAborted(); await handle.writeFile(chunk)
          } })
          const writer = new ZipWriter(output, { useWebWorkers: false, signal })
          // Copy unchanged local records in compressed form: no full extraction, no old revisions appended.
          let replaced
          await writer.appendZip(idx.input, { readerOptions, filter: original => {
            if (original.filename !== t.name) return true
            replaced = original; return false
          } })
          if (!replaced || entryVersion(replaced) !== intent.version) stale()
          const updated = await writer.add(t.name, new TextReader(content), { entry: replaced, lastModDate: new Date() })
          await writer.close(idx.comment); await handle.sync(); await handle.close()
          await authorize(); if ((await host.stat(t.archive, signal))?.version !== idx.version) stale()
          signal?.throwIfAborted(); await rename(tmp, path); invalidate(path)
          return { after: content, version: entryVersion(updated) }
        } finally { await handle.close(); await rm(tmp, { force: true }) }
      }, { signal, waitMs: 10000 })
    },
  }
  return { fs, mount, isMember: t => !!t[ZIP], physical, clear() { cache.clear(); building.clear(); cachedNodes = 0 } }
}