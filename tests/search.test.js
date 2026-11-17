/** The search view reads the session workspace twice as fast as a user can type; keep its contract pinned. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { buildMatcher, clipLine, compileGlob, createVscodeSearch, matchText, parseGlobList, SKIPPED_DIRS } from '../vscode-search.js'

const harness = process.env.DSH_SOURCE ?? 'E:/deepseek-harness'
const modules = {
  '@deepseek-ai/dsh-fs': 'packages/fs/fs/lib/index.js',
  '@deepseek-ai/dsh-sandbox': 'packages/sandbox/sandbox/lib/index.js',
}
registerHooks({ resolve(name, context, next) {
  return modules[name] ? { url: pathToFileURL(join(harness, modules[name])).href, shortCircuit: true } : next(name, context)
} })
const load = path => import(pathToFileURL(join(harness, path)))
const { Context } = await load('vendor/cordis/lib/index.js')
const { default: LocalFs } = await load('packages/fs/fs-local/lib/index.js')
const { FsError } = await load('packages/fs/fs/lib/index.js')

test('globs cover basenames, nested paths and brace lists', () => {
  assert.equal(compileGlob('*.js').re.test('a.js'), true)
  assert.equal(compileGlob('*.js').basenameOnly, true)
  assert.equal(compileGlob('src/**').basenameOnly, false)
  assert.equal(compileGlob('src/**').re.test('src/a/b.ts'), true)
  assert.equal(compileGlob('src/**').re.test('test/a.ts'), false)
  assert.equal(compileGlob('**/test/**').re.test('a/test/b.js'), true)
  assert.equal(compileGlob('*.{ts,tsx}').re.test('view.tsx'), true)
  assert.equal(compileGlob('*.{ts,tsx}').re.test('view.ts'), true)
  assert.equal(compileGlob('*.{ts,tsx}').re.test('view.js'), false)
  assert.deepEqual(parseGlobList(''), [])
  assert.equal(parseGlobList('*.js, *.md').length, 2)
})

test('matchers honour case and regex flags and reject broken patterns', () => {
  assert.ok(buildMatcher({ query: 'todo' }).test('TODO'))
  assert.equal(buildMatcher({ query: 'todo', caseSensitive: true }).test('TODO'), false)
  assert.ok(buildMatcher({ query: 'a+b', regex: true }).test('aaab'))
  assert.equal(buildMatcher({ query: 'a+b' }).test('aaab'), false)
  assert.throws(() => buildMatcher({ query: '([a-z', regex: true }), { code: 'SEARCH_INVALID_PATTERN' })
})

test('matchText reports line numbers, columns and visible ranges', () => {
  const hits = matchText('one\ntwo TODO here\nTODO\n', buildMatcher({ query: 'todo' }))
  assert.deepEqual(hits.map(hit => hit.line), [2, 3])
  assert.equal(hits[0].column, 4)
  assert.deepEqual(hits[0].ranges, [[4, 8]])
  assert.equal(hits[0].text, 'two TODO here')
})

test('empty Unicode regex matches advance past emoji and still find later text', () => {
  for (const query of ['^', '$', '(?:)', '(?=.)']) {
    assert.deepEqual(matchText('😀 hello\n中文😀', buildMatcher({ query, regex: true })), [])
  }
  const hits = matchText('😀 hello', buildMatcher({ query: '(?=.)|hello', regex: true }))
  assert.deepEqual(hits, [])
  const mixed = matchText('😀 hello', buildMatcher({ query: '^|hello', regex: true }))
  assert.equal(mixed[0].column, 3)
  assert.deepEqual(mixed[0].ranges, [[3, 8]])
})

test('clipLine keeps the hit visible in a very long line', () => {
  const line = `${'x'.repeat(2000)}NEEDLE${'y'.repeat(2000)}`
  const clipped = clipLine(line, [[2000, 2006]])
  assert.equal(clipped.text.length, 400)
  assert.equal(clipped.prefix, true)
  assert.equal(clipped.suffix, true)
  const [start, end] = clipped.ranges[0]
  assert.equal(clipped.text.slice(start, end), 'NEEDLE')
})

test('search walks the workspace and skips noise, binaries and filters', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'world-search-'))
  await mkdir(join(workspace, 'src', 'deep'), { recursive: true })
  await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(workspace, 'src', 'app.js'), 'const a = 1\nconst TODO = "fix"\n')
  await writeFile(join(workspace, 'src', 'deep', 'notes.md'), 'todo: 写文档\n')
  await writeFile(join(workspace, 'node_modules', 'pkg', 'index.js'), 'todo\n')
  await writeFile(join(workspace, 'assets.bin'), Buffer.from([0x74, 0x6f, 0x64, 0x6f, 0x00]))

  const context = new Context()
  await context.plugin(LocalFs, { cwd: workspace })
  const session = { header: { cwd: workspace } }
  const service = createVscodeSearch({
    fs: context.fs,
    sessions: { get: id => id === 'session' ? session : undefined },
    get: () => undefined,
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
  }, { FsError })
  t.after(async () => {
    service.dispose()
    await context.fiber.dispose()
    await rm(workspace, { recursive: true, force: true })
  })

  const all = await service.call('find', { sessionId: 'session', query: 'todo' })
  assert.deepEqual(all.files.map(file => file.path), ['src/app.js', 'src/deep/notes.md'])
  assert.equal(all.total, 2)
  assert.equal(all.files[0].matches[0].line, 2)
  assert.equal(all.files[0].matches[0].column, 6)
  assert.equal(all.truncated, false)

  const exact = await service.call('find', { sessionId: 'session', query: 'todo', caseSensitive: true })
  assert.deepEqual(exact.files.map(file => file.path), ['src/deep/notes.md'])

  const onlyJs = await service.call('find', { sessionId: 'session', query: 'todo', include: '*.js' })
  assert.deepEqual(onlyJs.files.map(file => file.path), ['src/app.js'])

  const withoutDeep = await service.call('find', { sessionId: 'session', query: 'todo', exclude: 'src/deep/**' })
  assert.deepEqual(withoutDeep.files.map(file => file.path), ['src/app.js'])

  const asRegex = await service.call('find', { sessionId: 'session', query: 'TO+DO|todo', regex: true })
  assert.equal(asRegex.total, 2)

  assert.ok(SKIPPED_DIRS.has('node_modules'))
  // 打开文件夹后只搜那个文件夹：路径相对新根，越界（文件当根）要拒绝
  const scoped = await service.call('find', { sessionId: 'session', query: 'todo', root: join(workspace, 'src') })
  assert.deepEqual(scoped.files.map(file => file.path), ['app.js', 'deep/notes.md'])
  await assert.rejects(service.call('find', {
    sessionId: 'session', query: 'todo', root: join(workspace, 'src', 'app.js'),
  }), { code: 'SEARCH_NO_WORKSPACE' })
  await assert.rejects(service.call('find', { sessionId: 'session', query: 'todo', root: join(workspace, 'missing') }), { code: 'SEARCH_NO_WORKSPACE' })
  await assert.rejects(service.call('find', { sessionId: 'session', query: '' }), { code: 'SEARCH_EMPTY' })
  await assert.rejects(service.call('find', { sessionId: 'session', query: '(' , regex: true }), { code: 'SEARCH_INVALID_PATTERN' })
  await assert.rejects(service.call('find', { sessionId: 'missing', query: 'x' }), { code: 'SEARCH_NO_SESSION' })
  await assert.rejects(service.call('find', { sessionId: 'session', query: 'x'.repeat(400) }), { code: 'SEARCH_TOO_LONG' })
})

test('file lookup matches names and paths without reading contents, including binary, GBK and large files', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'world-filenames-'))
  await mkdir(join(workspace, 'src/deep'), { recursive: true })
  await mkdir(join(workspace, 'node_modules/pkg'), { recursive: true })
  await writeFile(join(workspace, 'src/中文窗口.srw'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))
  await writeFile(join(workspace, 'src/deep/Report.PDF'), Buffer.alloc(2_000_000))
  await writeFile(join(workspace, 'body.txt'), 'only-in-content')
  await writeFile(join(workspace, 'node_modules/pkg/Report.js'), 'ignored')
  const context = new Context()
  await context.plugin(LocalFs, { cwd: workspace })
  const service = createVscodeSearch({ fs: {
    resolve: (...args) => context.fs.resolve(...args), stat: (...args) => context.fs.stat(...args),
    listDir: (...args) => context.fs.listDir(...args), contains: (...args) => context.fs.contains(...args),
    processPath: (...args) => context.fs.processPath(...args),
    readBytes() { assert.fail('file name search must not read file contents') },
  }, sessions: { get: () => ({ header: { cwd: workspace } }) }, get: () => undefined }, { FsError })
  t.after(async () => { service.dispose(); await context.fiber.dispose(); await rm(workspace, { recursive: true, force: true }) })
  assert.deepEqual((await service.call('files', { sessionId: 's', query: 'report' })).files, [{ path: 'src/deep/Report.PDF' }])
  assert.deepEqual((await service.call('files', { sessionId: 's', query: '中文' })).files, [{ path: 'src/中文窗口.srw' }])
  assert.equal((await service.call('files', { sessionId: 's', query: 'only-in-content' })).fileCount, 0)
  assert.deepEqual((await service.call('files', { sessionId: 's', query: 'deep\\report' })).files, [{ path: 'src/deep/Report.PDF' }])
  assert.deepEqual((await service.call('files', { sessionId: 's', query: 'report', root: join(workspace, 'src/deep') })).files, [{ path: 'Report.PDF' }])
  await assert.rejects(service.call('files', { sessionId: 's', query: '' }), { code: 'SEARCH_EMPTY' })
  await assert.rejects(service.call('files', { sessionId: 's', query: 'x'.repeat(301) }), { code: 'SEARCH_TOO_LONG' })
})

test('file lookup enforces result limits, directory boundaries and cancellation', async () => {
  let cancel
  const service = createVscodeSearch({ fs: {
    resolve: async value => value, stat: async () => ({ type: 'directory' }), processPath: value => value,
    contains: (root, target) => target.startsWith(root + '/'),
    listDir: async (_root, signal) => {
      if (cancel) { cancel.abort(); signal.throwIfAborted() }
      return [{ name: 'match-outside', type: 'file', target: '/elsewhere/file' },
        ...Array.from({ length: 250 }, (_, index) => ({ name: `match-${index}.js`, type: 'file', target: `/workspace/match-${index}.js` }))]
    },
  }, sessions: { get: () => ({ header: { cwd: '/workspace' } }) }, get: () => undefined }, { FsError })
  try {
    const found = await service.call('files', { sessionId: 's', query: 'match' })
    assert.equal(found.fileCount, 200); assert.equal(found.truncated, true); assert.equal(found.skipped, 1)
    cancel = new AbortController()
    await assert.rejects(service.call('files', { sessionId: 's', query: 'match' }, cancel.signal), { name: 'AbortError' })
  } finally { service.dispose() }
})

test('replace only touches listed files, keeps CRLF and expands regex captures', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'world-replace-'))
  const src = join(workspace, 'src')
  await mkdir(src, { recursive: true })
  const app = join(src, 'app.js')
  const notes = join(workspace, 'notes.md')
  await writeFile(app, 'const TODO = 1\r\n// todo again\r\n')
  await writeFile(notes, 'todo\n')

  const context = new Context()
  await context.plugin(LocalFs, { cwd: workspace })
  const session = { header: { cwd: workspace } }
  const service = createVscodeSearch({
    fs: context.fs,
    sessions: { get: id => id === 'session' ? session : undefined },
    get: () => undefined,
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
  }, { FsError })
  t.after(async () => {
    service.dispose()
    await context.fiber.dispose()
    await rm(workspace, { recursive: true, force: true })
  })

  const found = await service.call('find', { sessionId: 'session', query: 'todo' })
  const paths = found.files.map(file => file.path)
  const replaced = await service.call('replace', {
    sessionId: 'session', query: 'todo', replacement: 'DONE', paths,
  })
  assert.equal(replaced.replacements, 3)
  assert.deepEqual(replaced.files.map(file => file.path).sort(), ['notes.md', 'src/app.js'])
  assert.equal(await readFile(app, 'utf8'), 'const DONE = 1\r\n// DONE again\r\n')
  assert.equal(await readFile(notes, 'utf8'), 'DONE\n')

  // 有草稿的文件由前端点名跳过；正则替换支持捕获组
  await writeFile(app, 'const TODO = 2\n')
  const skipped = await service.call('replace', {
    sessionId: 'session', query: 'todo', replacement: 'X', paths: ['src/app.js'], skip: [app],
  })
  assert.equal(skipped.replacements, 0)
  assert.match(skipped.skipped[0].reason, /未保存/u)
  assert.equal(await readFile(app, 'utf8'), 'const TODO = 2\n')

  await writeFile(app, 'const count = 41\n')
  const captured = await service.call('replace', {
    sessionId: 'session', query: 'const (\\w+) = (\\d+)', regex: true,
    replacement: 'let $1 = $2 + 1', paths: ['src/app.js'],
  })
  assert.equal(captured.replacements, 1)
  assert.equal(await readFile(app, 'utf8'), 'let count = 41 + 1\n')

  await assert.rejects(service.call('replace', {
    sessionId: 'session', query: 'a*', regex: true, replacement: 'x', paths: ['src/app.js'],
  }), { code: 'SEARCH_INVALID_PATTERN' })

  const outside = await service.call('replace', {
    sessionId: 'session', query: 'todo', replacement: 'x', paths: ['../outside.txt'],
  })
  assert.equal(outside.replacements, 0)
  assert.equal(outside.skipped.length, 1)

  const readOnly = createVscodeSearch({
    fs: context.fs,
    sessions: { get: id => id === 'session' ? session : undefined },
    get: () => undefined,
    sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
  }, { FsError })
  t.after(() => readOnly.dispose())
  await assert.rejects(readOnly.call('replace', {
    sessionId: 'session', query: 'value', replacement: 'x', paths: ['src/app.js'],
  }), { code: 'FS_SANDBOX_DENIED' })
})
