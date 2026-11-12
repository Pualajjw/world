/** Produce the installable universal DSH package, then leave only the newest tgz in dist. */
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { packagePlugin } from '../project-tree/package-plugin.mjs'

const root = import.meta.dirname
const output = resolve(root, 'dist')
await packagePlugin(root, { output, platform: 'universal' })

// dist 只留最新一版 tgz：安装只认 tgz，旧包都能从源码重建，留着只是白占空间。
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const keep = new Set([`${manifest.meta.title}-${manifest.version}-universal.tgz`, `${manifest.meta.title}-${manifest.version}-universal.sha256`])
const stale = (await readdir(output)).filter(name => !keep.has(name))
for (const name of stale) await rm(join(output, name), { recursive: true, force: true })
if (stale.length) console.log(`Pruned ${stale.length} older artifact(s) from dist`)

// 校验文件里原来还写着 zip 的哈希，但 zip 已经删了——只留 tgz 那一行，免得照着它去核一个不存在的文件。
const checksum = join(output, `${manifest.meta.title}-${manifest.version}-universal.sha256`)
const lines = (await readFile(checksum, 'utf8')).split('\n').filter(line => line.trim().endsWith('.tgz'))
if (lines.length) await writeFile(checksum, `${lines.join('\n')}\n`)
