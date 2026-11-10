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
  const saved = await editor.call('save', { sessionId: 'session', path: 'main.js', version: opened.version, source: 'const value = 2\n' })
  assert.equal(saved.source, 'const value = 2\n')
  assert.equal(await readFile(file, 'utf8'), '\uFEFFconst value = 2\r\n')
  await assert.rejects(editor.call('save', { sessionId: 'session', path: 'main.js', version: opened.version, source: 'stale' }), { code: 'FS_STALE_VERSION' })

  mode = 'read-only'
  await assert.rejects(editor.call('save', { sessionId: 'session', path: 'main.js', version: saved.version, source: 'denied' }), { code: 'FS_SANDBOX_DENIED' })
  mode = 'workspace-write'
  const foreign = `${workspace}-outside.js`
  await writeFile(foreign, 'outside')
  t.after(() => rm(foreign, { force: true }))
  await assert.rejects(editor.call('open', { sessionId: 'session', path: foreign }), { code: 'FS_SANDBOX_DENIED' })
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
