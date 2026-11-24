/** Run with node --expose-gc. Synthetic archives stay in memory to exclude disk I/O. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import '../vendor/zip-native.min.js'

const custom = process.argv[2]
const { createZipWorkspace } = await import(custom ? pathToFileURL(resolve(custom)) : '../zip-workspace.js')
if (!global.gc) throw Error('Run with --expose-gc')
function sample(files) {
  return execFileSync('python', ['-B', '-c', `import io, zipfile, sys
b = io.BytesIO()
with zipfile.ZipFile(b, 'w', compression=zipfile.ZIP_DEFLATED) as z:
 for n in range(${files}): z.writestr('dir%02d/file%04d.txt'%(n%50,n), 'zip workspace benchmark')
sys.stdout.buffer.write(b.getvalue())`], {maxBuffer: 4 * 1024 * 1024})
}
let bytes = sample(5000), reads = 0, readBytes = 0
const host = { resolve:async x=>resolve(x), processPath:x=>x, processPathFromHostPath:x=>x,
  lstat:async()=>undefined, stat:async()=>({type:'file',version:'v1',size:bytes.length}),
  readByteRange:async (_,{offset,length}) => { reads++; readBytes += length; return bytes.subarray(offset, offset+length) } }
const zip = createZipWorkspace(host,{FsError:Error}), archive = i=>resolve(`profile-${i}.zip`)
const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed }
const ms = n=>Number(n.toFixed(3)), initial = heap(), coldMs = []
for (let i=0; i<3; i++) {
  const start = performance.now(); await zip.mount(archive(i)); coldMs.push(ms(performance.now()-start))
}
const retainedMiB = Number(((heap()-initial)/1048576).toFixed(1)), warm = []
reads = 0
for (let i=0; i<100; i++) {
  const start = performance.now(); await zip.mount(archive(i%3)); warm.push(performance.now()-start)
}
assert.equal(reads, 0, 'hot projects need no archive byte reads')
readBytes = 0
const start = performance.now()
for (let i=0; i<100; i++) {
  const n=(i*53)%5000, path = `${archive(0)}.workspace/dir${String(n%50).padStart(2,'0')}/file${String(n).padStart(4,'0')}.txt`
  const target=await zip.fs.resolve(path)
  assert.equal((await zip.fs.readBytes(target,undefined,100)).toString(), 'zip workspace benchmark')
}
console.log({ files:5000, archiveKiB:Math.round(bytes.length/1024), coldMs, hotMedianMs:ms(warm.sort((a,b)=>a-b)[50]), retainedMiB,
  randomReadMs:ms(performance.now()-start), randomReadBytes:readBytes })
zip.clear()
if (!custom) {
  assert.ok(retainedMiB < 20, 'compact indexes, not full decoder objects')
  assert.ok(readBytes < 1024*1024, '100 random small reads must not reread the central directory')
  bytes = sample(13000)
  for (const i of [0,1,2,0,3]) await zip.mount(archive(i))
  reads=0; await zip.mount(archive(0)); assert.equal(reads,0,'recently reused archive remains hot')
  await zip.mount(archive(1)); assert.ok(reads>0,'node budget evicts the least recently used archive before the count limit')
  zip.clear()
}
