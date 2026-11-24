import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** Publish only this world's artifact before pruning any files an existing local source still references. */
export async function publishWorldIndex(root, manifest) {
  const parent = dirname(root), indexFile = join(parent, 'index.json')
  const text = await readFile(indexFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (text === null) return null // A standalone source checkout need not be a pbpkg repository.
  const index = JSON.parse(text)
  if (!index.packages?.world) return null
  if (index.schema !== 1 || manifest.name !== '@local/dsh-world' || manifest.meta?.title !== 'world'
    || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(manifest.version)) throw new Error('world 本地源索引或包信息无效，未更新索引。')
  const previous = index.packages.world
  if (typeof previous.path !== 'string' || dirname(resolve(parent, previous.path)) !== resolve(root, 'dist'))
    throw new Error('本地源的 world 条目不属于当前 dist 目录，未覆盖索引。')
  const file = join(root, 'dist', `world-${manifest.version}-universal.tgz`)
  const bytes = await readFile(file)
  const row = { ...previous, type: 'tgz', path: relative(parent, file).split(sep).join('/'),
    size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), description: manifest.description || '' }
  index.packages.world = row
  const temporary = `${indexFile}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(index, null, 2) + '\n', { flag: 'wx' })
    // Do not overwrite an index another packaging process changed while we hashed this archive.
    if (await readFile(indexFile, 'utf8') !== text) throw new Error('本地源索引已被其他进程更新，请重新打包 world。')
    await rename(temporary, indexFile)
  } finally { await rm(temporary, { force: true }) }
  return row
}
