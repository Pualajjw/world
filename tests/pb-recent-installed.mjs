/** Read-only release smoke: test the installed Desktop providers, not workspace imports.
 * node tests/pb-recent-installed.mjs <existing mapped library path> [...]
 * Supply nonempty libraries with known timestamps. No object is opened or compiled.
 */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { join, dirname, resolve, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

const paths = process.argv.slice(2)
assert.ok(paths.length, 'Supply an existing library path with dated objects')
const harness = process.env.DSH_SOURCE || 'E:/deepseek-harness'
const profile = process.env.WORLD_DESKTOP_PROFILE || join(homedir(), '.dsh/profiles/desktop')
const load = path => import(pathToFileURL(path).href)
const modules = { 'dsh-fs':'fs/fs', 'dsh-sandbox':'sandbox/sandbox', 'dsh-atomic-write':'util/atomic-write', 'dsh-tool-fs-search':'fs/tool-fs-search' }
const hooks = registerHooks({resolve(name, ctx, next) {
  const id = name.startsWith('@deepseek-ai/') && modules[name.slice('@deepseek-ai/'.length)]
  return id ? {shortCircuit:true, url:pathToFileURL(join(harness, 'packages', id, 'lib/index.js')).href} : next(name, ctx)
}})
const { Context } = await load(join(harness,'vendor/cordis/lib/index.js'))
const { default: LocalFs } = await load(join(harness,'packages/fs/fs-local/lib/index.js'))
const { FsError } = await load(join(harness,'packages/fs/fs/lib/index.js'))
const installed = name => join(profile,'node_modules/@local',`dsh-${name}`)
const { createVscodeSourceEditor } = await load(join(installed('world'),'source-editor.js'))
const ctx = new Context(), cwd = dirname(resolve(paths[0]))
try {
  await ctx.plugin(LocalFs, {cwd})
  for (const name of ['pbnpm','pbnpm-pbd']) await ctx.plugin(await load(join(installed(name),'index.js')), {})
  const editor = createVscodeSourceEditor({fs:ctx.fs,sessions:{get:()=>({header:{cwd}})}},{FsError})
  try {
    for (const path of paths) {
      const entries = await ctx.fs.listDir(await ctx.fs.resolve(path))
      const expected = entries.filter(e=>e.type === 'file' && e.pbModifiedAt > 0).sort((a,b)=>b.pbModifiedAt-a.pbModifiedAt || a.name.localeCompare(b.name))
      const {recentObjects} = await editor.call('list',{sessionId:'smoke',path})
      console.log(`${basename(path)}: ${entries.length} entries, ${expected.length} dated, ${recentObjects?.length || 0} recent`)
      assert.ok(expected.length, 'Installed provider returned no object timestamps for '+basename(path))
      assert.deepEqual(recentObjects,expected.slice(0,10).map(({name})=>({name,type:'file'})))
    }
  } finally { await editor.dispose() }
} finally { await ctx.fiber.dispose(); hooks.deregister() }
