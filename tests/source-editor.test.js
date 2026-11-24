/** The built-in editor uses session workspace and permission checks for every save. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import { registerHooks } from 'node:module'
import { createVscodeSourceEditor } from '../source-editor.js'

const harness = process.env.DSH_SOURCE ?? 'E:/deepseek-harness'
const modules = {
  '@deepseek-ai/dsh-fs': 'packages/fs/fs/lib/index.js',
  '@deepseek-ai/dsh-sandbox': 'packages/sandbox/sandbox/lib/index.js',
}
const hooks = registerHooks({ resolve(name, context, next) {
  return modules[name] ? { url: pathToFileURL(join(harness, modules[name])).href, shortCircuit: true } : next(name, context)
} })
const load = path => import(pathToFileURL(join(harness, path)))
const { Context } = await load('vendor/cordis/lib/index.js')
const { default: LocalFs } = await load('packages/fs/fs-local/lib/index.js')
const { FsError } = await load('packages/fs/fs/lib/index.js')
const { writableRoots } = await load('packages/sandbox/sandbox/lib/index.js')

test('source editor preserves UTF-8 BOM/newlines and enforces session write policy and versions', async t => {
  const workspace = await mkdtemp('E:/newworkspace/pbhelp/.dsh/tmp/world-vscode-')
  const context = new Context()
  await context.plugin(LocalFs, { cwd: workspace })
  let mode = 'workspace-write'
  const session = { header: { cwd: workspace } }
  const editor = createVscodeSourceEditor({
    fs: context.fs,
    sessions: { get: id => id === 'session' ? session : undefined },
    get: () => undefined,
    sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: workspace }) },
  }, { FsError, writableRoots })
  t.after(async () => { await editor.dispose(); await context.fiber.dispose(); await rm(workspace, { recursive: true, force: true }) })

  const file = join(workspace, 'main.js')
  await writeFile(file, '\uFEFFconst value = 1\r\n')
  const opened = await editor.call('open', { sessionId: 'session', path: 'main.js' })
  assert.equal(opened.source, 'const value = 1\n')
  // 桌面拖入文件只需要路径和类型：probe 不读取内容
  const probedFile = await editor.call('probe', { sessionId: 'session', path: 'main.js' })
  assert.deepEqual(probedFile, { path: probedFile.path, type: 'file', name: 'main.js' })
  const probedDir = await editor.call('probe', { sessionId: 'session', path: workspace })
  assert.equal(probedDir.type, 'directory')
  await assert.rejects(editor.call('probe', { sessionId: 'session', path: 'missing.txt' }), { code: 'FS_NOT_FOUND' })
  // 状态栏要如实显示换行符与 BOM，保存时再按原样写回
  assert.equal(opened.eol, 'CRLF')
  assert.equal(opened.bom, true)
  // 批量版本：对话里的工具改了文件后，客户端靠它判断哪个标签需要重读
  const versions = await editor.call('versions', { sessionId: 'session', root: workspace,
    paths: ['main.js', 'missing.txt', join(workspace, '..', 'outside.js')] })
  assert.equal(versions.versions.length, 1, '不存在的文件和根目录外的路径都跳过')
  assert.equal(versions.versions[0].version, opened.version)
  assert.match(versions.versions[0].path, /main\.js$/)
  const saved = await editor.call('save', { sessionId: 'session', path: 'main.js', version: opened.version, source: 'const value = 2\n' })
  assert.equal(saved.source, 'const value = 2\n')
  const refreshed = await editor.call('versions', { sessionId: 'session', root: workspace, paths: ['main.js'] })
  assert.notEqual(refreshed.versions[0].version, opened.version, '写盘后版本号要变，客户端据此重读')
  assert.equal(await readFile(file, 'utf8'), '\uFEFFconst value = 2\r\n')
  await assert.rejects(editor.call('save', { sessionId: 'session', path: 'main.js', version: opened.version, source: 'stale' }), { code: 'FS_STALE_VERSION' })

  const mixed = join(workspace, 'w_mixed.srw'), raw = '\uFEFFleft\r\nAAA\nkeep line\rkeep again\r\nBBB\nend\r'
  await writeFile(mixed, raw)
  const meta = await editor.call('open', { sessionId: 'session', path: mixed })
  const updated = meta.source.replace('AAA','中文甲').replace('BBB','中文乙')
  const spans = ['AAA','BBB'].map(word => { const k = meta.source.indexOf(word); return [k,k+3,k,k+3] })
  await editor.call('save', { sessionId:'session', path:mixed, version:meta.version, source:updated, spans })
  assert.equal(await readFile(mixed,'utf8'),raw.replace('AAA','中文甲').replace('BBB','中文乙'))

  mode = 'read-only'
  await assert.rejects(editor.call('pbtest', { sessionId: 'session', path: 'main.js' }), { code: 'FS_SANDBOX_DENIED' })
  await assert.rejects(editor.call('save', { sessionId: 'session', path: 'main.js', version: saved.version, source: 'denied' }), { code: 'FS_SANDBOX_DENIED' })
  mode = 'workspace-write'
  const foreign = `${workspace}-outside.js`
  await writeFile(foreign, 'outside')
  t.after(() => rm(foreign, { force: true }))
  await assert.rejects(editor.call('open', { sessionId: 'session', path: foreign }), { code: 'FS_SANDBOX_DENIED' })
})

test('GBK files open losslessly for viewing and cannot be overwritten as UTF-8', async t => {
  const workspace = await mkdtemp('E:/newworkspace/pbhelp/.dsh/tmp/world-gbk-')
  const context = new Context()
  await context.plugin(LocalFs, { cwd: workspace })
  const editor = createVscodeSourceEditor({ fs: context.fs,
    sessions: { get: () => ({ header: { cwd: workspace } }) }, get: () => undefined,
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
  }, { FsError, writableRoots })
  t.after(async () => { await editor.dispose(); await context.fiber.dispose(); await rm(workspace, { recursive: true, force: true }) })
  const file = join(workspace, 'w_test.srw')
  const bytes = Buffer.concat([Buffer.from('string ls_name = "'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('"\r\n')])
  await writeFile(file, bytes)
  const opened = await editor.call('open', { sessionId: 'session', path: file })
  assert.equal(opened.source, 'string ls_name = "中文"\n')
  assert.equal(opened.encoding, 'GBK')
  assert.equal(opened.eol, 'CRLF')
  assert.equal(opened.readOnly, true)
  await assert.rejects(editor.call('save', { sessionId: 'session', path: file, version: opened.version, source: 'modified' }), { code: 'FS_ENCODING_READ_ONLY' })
  assert.deepEqual(await readFile(file), bytes)
  await writeFile(join(workspace, 'utf8.srw'), 'string ls_name = "中文"\n')
  const utf8 = await editor.call('open', { sessionId: 'session', path: 'utf8.srw' })
  assert.equal(utf8.encoding, 'UTF-8'); assert.equal(utf8.readOnly, false)
  for (const bytes of [Buffer.from([0x81]), Buffer.from([0xd6, 0xd0, 0x00])]) {
    await writeFile(join(workspace, 'binary.bin'), bytes)
    await assert.rejects(editor.call('open', { sessionId: 'session', path: 'binary.bin' }), { code: 'FS_NOT_TEXT' })
  }
})

test('PB recent objects use per-entry times across the entire library, even beyond the tree cap', async () => {
  const entries = Array.from({length:2040}, (_,i) => ({name:`u${String(i).padStart(4,'0')}.sru`,type:'file',pbModifiedAt:i}))
  const ctx = {sessions:{get:()=>({header:{cwd:'/test'}})}, fs:{resolve:async p=>p,stat:async()=>({type:'directory'}),listDir:async()=>entries,processPath:p=>p}}
  const editor = createVscodeSourceEditor(ctx, {FsError})
  const value = await editor.call('list',{sessionId:'s',path:'/test/large.pbd'})
  assert.equal(value.truncated,true); assert.deepEqual(value.recentObjects.map(e=>e.name),entries.slice(-10).reverse().map(e=>e.name))
})

test('opening a folder moves the editor root without escaping it', async t => {
  const workspace = await mkdtemp('E:/newworkspace/pbhelp/.dsh/tmp/world-folder-')
  const outside = await mkdtemp('E:/newworkspace/pbhelp/.dsh/tmp/world-other-')
  const context = new Context()
  await context.plugin(LocalFs, { cwd: workspace })
  const session = { header: { cwd: workspace } }
  const editor = createVscodeSourceEditor({
    fs: context.fs,
    sessions: { get: id => id === 'session' ? session : undefined },
    get: () => undefined,
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
  }, { FsError, writableRoots })
  t.after(async () => {
    await editor.dispose()
    await context.fiber.dispose()
    await rm(workspace, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  await mkdir(join(workspace, 'src', 'deep'), { recursive: true })
  await writeFile(join(workspace, 'src', 'app.js'), 'const a = 1\n')
  await writeFile(join(workspace, 'top.js'), 'const b = 2\n')
  await writeFile(join(outside, 'note.js'), 'outside\n')

  const rootList = await editor.call('list', { sessionId: 'session', path: workspace })
  assert.deepEqual(rootList.entries.map(item => item.name), ['src', 'top.js'])
  assert.equal(rootList.parent.replace(/\\/gu, '/'), dirname(workspace).replace(/\\/gu, '/'))
  const deepList = await editor.call('list', { sessionId: 'session', path: join(workspace, 'src') })
  assert.deepEqual(deepList.entries.map(item => item.name), ['deep', 'app.js'])
  assert.equal(deepList.parent.replace(/\\/gu, '/'), workspace.replace(/\\/gu, '/'))
  await assert.rejects(editor.call('list', { sessionId: 'session', path: join(workspace, 'top.js') }), { code: 'FS_NOT_DIRECTORY' })

  // 以 src 为根：src 内可开，src 外（同一个工作区）也不行
  const subRoot = join(workspace, 'src')
  const inner = await editor.call('open', { sessionId: 'session', path: join(subRoot, 'app.js'), root: subRoot })
  assert.equal(inner.source, 'const a = 1\n')
  await assert.rejects(editor.call('open', { sessionId: 'session', path: join(workspace, 'top.js'), root: subRoot }), { code: 'FS_SANDBOX_DENIED' })

  // 用户主动打开的其它文件夹：可读；写仍由 sandbox policy 决定
  const opened = await editor.call('open', { sessionId: 'session', path: join(outside, 'note.js'), root: outside })
  assert.equal(opened.source, 'outside\n')
  await assert.rejects(editor.call('save', {
    sessionId: 'session', path: join(outside, 'note.js'), root: outside, version: opened.version, source: 'changed\n',
  }), { code: 'FS_SANDBOX_DENIED' })
  await assert.rejects(editor.call('open', { sessionId: 'session', path: join(outside, 'note.js'), root: workspace }), { code: 'FS_SANDBOX_DENIED' })
})

test('reveal selects files and folders only inside the open folder', async t => {
  const workspace = await mkdtemp('E:/newworkspace/pbhelp/.dsh/tmp/world-reveal-')
  const outside = await mkdtemp('E:/newworkspace/pbhelp/.dsh/tmp/world-reveal-other-')
  const context = new Context()
  await context.plugin(LocalFs, { cwd: workspace })
  const session = { header: { cwd: workspace } }
  const revealed = []
  const reveal = async target => { revealed.push(target) }
  const makeEditor = options => createVscodeSourceEditor({
    fs: context.fs,
    sessions: { get: id => id === 'session' ? session : undefined },
    get: () => undefined,
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
  }, { FsError, writableRoots, ...options })
  const editor = makeEditor({ reveal })
  t.after(async () => {
    await editor.dispose()
    await context.fiber.dispose()
    await rm(workspace, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'src', 'app.js'), '')
  await writeFile(join(outside, 'note.js'), '')
  const stable = path => path.replace(/\\/gu, '/')

  const file = await editor.call('reveal', { sessionId: 'session', path: join(workspace, 'src', 'app.js') })
  assert.equal(stable(file.path), stable(join(workspace, 'src', 'app.js')))
  const folder = await editor.call('reveal', { sessionId: 'session', path: join(workspace, 'src') })
  assert.equal(stable(folder.path), stable(join(workspace, 'src')))
  assert.deepEqual(revealed.map(stable), [stable(join(workspace, 'src', 'app.js')), stable(join(workspace, 'src'))])

  await assert.rejects(editor.call('reveal', { sessionId: 'session', path: join(outside, 'note.js') }), { code: 'FS_SANDBOX_DENIED' })
  await assert.rejects(editor.call('reveal', { sessionId: 'session', path: join(workspace, 'missing.js') }), { code: 'FS_NOT_FOUND' })
  const unavailable = makeEditor({})
  t.after(() => unavailable.dispose())
  await assert.rejects(unavailable.call('reveal', { sessionId: 'session', path: join(workspace, 'src') }), { code: 'WORLD_REVEAL_UNAVAILABLE' })
})

after(() => hooks.deregister())

test('directory listing needs only the cold session header and propagates list errors', async t => {
  let closes = 0, failed = false
  const editor = createVscodeSourceEditor({ sessions: { get: () => null },
    get: () => ({ open: async () => ({ header: { cwd: 'C:/test' }, close: async () => { closes++ },
      read: () => assert.fail('directory listing must not replay the transcript') }) }),
    fs: { resolve: (path, { cwd }) => { assert.equal(cwd, 'C:/test'); return path },
      stat: () => ({ type: 'directory' }), processPath: path => path,
      listDir: () => { if (failed) throw new FsError('read failed', 'FS_NOT_FOUND'); return [] } },
  }, { FsError, writableRoots })
  t.after(() => editor.dispose())
  assert.deepEqual((await editor.call('list', { sessionId: 'cold' })).entries, [])
  failed = true
  await assert.rejects(editor.call('list', { sessionId: 'cold' }), { code: 'FS_NOT_FOUND' })
  assert.equal(closes, 2)
})

// Opt-in: PB9/ORCA writes ONLY to a disposable project, never to an installed library.
test('the World save route recompiles a pbnpm virtual UTF-8 SRW; a rejected script leaves the PBL unchanged', { skip: process.env.WORLD_SRW_ORCA !== '1' }, async t => {
  const { installOverlay } = await import('../../pbnpm/overlay.js')
  const { createNativeProject } = await import('../../pbnpm/tests/native-fixture.js')
  const { fileURLToPath } = await import('node:url')
  const directory = await mkdtemp(fileURLToPath(new URL('../../../tmp/world-srw-orca-', import.meta.url)))
  t.after(() => rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}))
  const config = { ...await load(modules['@deepseek-ai/dsh-fs']), writableRoots, pbVersion:90, pbtPath:join(directory,'demo.pbt'), libraryPaths:[],
    pbnpmPath:fileURLToPath(new URL('../../pbnpm/bin/pbnpm.exe',import.meta.url)), pbRuntimeRoot:fileURLToPath(new URL('../../pbnpm/runtime/',import.meta.url)),
    maxSourceBytes:16*1024*1024, maxEntries:100000, maxIndexNodes:16384, compileWorkDir:directory, compileTimeoutMs:120000, diagnosticBytes:65536 }
  await createNativeProject(config,directory)
  const ctx = new Context(); await ctx.plugin(LocalFs,{cwd:directory})
  const policy={mode:'workspace-write',workspaceRoot:directory}, dispose=installOverlay(ctx.fs,config,()=>policy)
  const editor=createVscodeSourceEditor({fs:ctx.fs,sessions:{get:()=>({header:{cwd:directory}})},sandboxPolicy:{resolve:()=>policy}},{FsError,writableRoots})
  try {
    const path=join(directory,'demo.pbl','w_roundtrip.srw'), params={sessionId:'local-test',root:directory,path}
    const text='$PBExportHeader$w_roundtrip.srw\nforward\nglobal type w_roundtrip from window\nend type\nend forward\nglobal type w_roundtrip from window\nend type\nglobal w_roundtrip w_roundtrip\n\nevent open;MessageBox("World", "之前")\nend event\n'
    await ctx.fs.writeText(await ctx.fs.resolve(path),text,{kind:'createIfAbsent'},undefined,policy)
    const opened=await editor.call('open',params); assert.equal(opened.encoding,'UTF-8'); assert.equal(opened.readOnly,false); assert.match(opened.source,/之前/)
    const saved=await editor.call('save',{...params,version:opened.version,source:opened.source.replace('之前','改后')})
    assert.match((await editor.call('open',params)).source,/改后/)
    const bytes=await readFile(join(directory,'demo.pbl'))
    await assert.rejects(editor.call('save',{...params,version:saved.version,source:saved.source.replace('end event','invalid powerscript !!!\nend event')}))
    assert.deepEqual(await readFile(join(directory,'demo.pbl')),bytes)
  } finally { await editor.dispose(); await dispose(); await ctx.fiber.dispose() }
})

test('ZIP workspace: virtual tree, on-demand source, search, guarded saves back to the same archive', async t => {
  const { createZipWorkspace } = await import('../zip-workspace.js')
  const { createVscodeSearch } = await import('../vscode-search.js')
  const { ZipReader, ZipWriter, Uint8ArrayReader, Uint8ArrayWriter, TextReader } = await import('../vendor/zip-native.min.js')
  const { withFileLock } = await load('packages/util/atomic-write/lib/index.js')
  const workspace = await mkdtemp(join(import.meta.dirname, '../../../tmp/world-zip-')), path = join(workspace, '工程.ZIP')
  const context = new Context(); await context.plugin(LocalFs, { cwd: workspace })
  let mode = 'workspace-write', writable = workspace
  const ctx = { fs:context.fs, sessions:{get:() => ({header:{cwd:workspace}})}, sandboxPolicy:{resolve:() => ({mode,workspaceRoot:writable})} }
  const zip = createZipWorkspace(ctx.fs, { FsError, writableRoots, withFileLock })
  const editor = createVscodeSourceEditor(ctx, {FsError, writableRoots, zip}), search = createVscodeSearch(ctx,{FsError,writableRoots,fs:zip.fs})
  t.after(async () => { await editor.dispose(); search.dispose(); zip.clear(); await context.fiber.dispose(); await rm(workspace,{recursive:true,force:true}) })
  const make = async text => {
    const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers:false })
    await writer.add('目录/note.txt',new TextReader(text),{comment:'keep'})
    await writer.add('assets/raw.bin', new Uint8ArrayReader(new Uint8Array([0,1,255,42])))
    await writer.add('assets/large.bin', new Uint8ArrayReader(Buffer.alloc(100000, 42)), {level:0})
    await writer.add('empty/',null,{directory:true})
    return writer.close(Buffer.from('archive comment'))
  }
  await writeFile(path, await make('\uFEFFhello\r\n'))
  const call = (op, payload) => editor.call(op,{sessionId:'session',root,...payload})
  const {path:root} = await editor.call('open-zip',{sessionId:'session',path})
  assert.deepEqual((await call('list',{path:root})).entries.map(e=>e.name).sort(), ['assets','empty','目录'])
  const file=join(root,'目录','note.txt'), doc=await call('open',{path:file}); assert.equal(doc.source,'hello\n')
  const large = await zip.fs.resolve(join(root,'assets/large.bin'))
  assert.deepEqual(await zip.fs.readBytes(large, undefined, 100000), Buffer.alloc(100000,42))
  assert.equal((await search.call('files',{sessionId:'session',root,query:'note.txt'})).files[0].path,'目录/note.txt')
  assert.equal((await search.call('find',{sessionId:'session',root,query:'hello'})).total,1)
  const save=(source,version)=>call('save',{path:file,source,version})
  for (const policy of ['read-only','workspace-write']) {
    mode=policy; writable=join(workspace,'elsewhere'); await assert.rejects(save('denied',doc.version),{code:'FS_SANDBOX_DENIED'})
  }
  writable=workspace
  const saved=await save('改好了\n',doc.version); assert.equal(saved.version,(await call('open',{path:file})).version)
  await assert.rejects(save('stale',doc.version),{code:'FS_STALE_VERSION'})
  const reader=new ZipReader(new Uint8ArrayReader(await readFile(path)),{useWebWorkers:false}), entries=await reader.getEntries()
  assert.deepEqual(Buffer.from(reader.comment), Buffer.from('archive comment'))
  const data=name=>entries.find(e=>e.filename===name).getData(new Uint8ArrayWriter(),{checkSignature:true})
  assert.deepEqual(Buffer.from(await data('目录/note.txt')),Buffer.from('\uFEFF改好了\r\n')); assert.equal(entries.find(e=>e.filename==='目录/note.txt').comment,'keep')
  assert.deepEqual(Array.from(await data('assets/raw.bin')),[0,1,255,42]); assert.ok(entries.some(e=>e.filename==='empty/' && e.directory)); await reader.close()
  const external=await make('updated elsewhere'); await writeFile(path,external)
  await assert.rejects(save('overwrite',saved.version),{code:'FS_STALE_VERSION'}); assert.deepEqual(await readFile(path),Buffer.from(external))
  await assert.rejects((await import('node:fs/promises')).stat(root),{code:'ENOENT'}) // never extracted
  await mkdir(root); await assert.rejects(editor.call('open-zip',{sessionId:'session',path}),/同名/)
})