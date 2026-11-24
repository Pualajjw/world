import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createGitFixture } from './git-fixture.js'
import { parseGitDiff } from '../git-diff.js'

test('diff display keeps content resembling file headers and hunk patches retain no-newline markers', () => {
  const patch = 'diff --git a/a.txt b/a.txt\nindex 111..222 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n--- old heading\n\\ No newline at end of file\n+++ new heading\n\\ No newline at end of file\n'
  const parsed = parseGitDiff(patch)
  assert.equal(parsed.rows.find(row => row.kind === 'del').text, '-- old heading')
  assert.equal(parsed.rows.find(row => row.kind === 'add').text, '++ new heading')
  assert.equal(parsed.hunkPatch(0), patch)
  assert.equal(parsed.hunkPatch(5), null)
})

test('hunks stage and unstage only the chosen change, reject stale views, and preserve worktree bytes', async t => {
  const f = await createGitFixture(); t.after(() => f.dispose())
  for (const newline of ['\n', '\r\n']) {
    const path = `中文 [${newline.length}] file.txt`, file = join(f.root, path)
    const rows = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`)
    const original = rows.join(newline) + newline
    await writeFile(file, original); await f.git('add', '--', path); await f.git('commit', '-m', 'base')
    const edited = [...rows]; edited[2] = 'first change'; edited[35] = 'second change'
    const draft = edited.join(newline) + newline
    await writeFile(file, draft)
    const diff = await f.call('diff', { paths: [path] })
    assert.equal(diff.hunkCount, 2); assert.equal(diff.canStageHunks, true)
    assert.equal(parseGitDiff(diff.patch).hunks.length, 2)
    await f.call('stage-hunk', { paths: [path], snapshot: diff.snapshot, hunk: 0 })
    const partial = [...rows]; partial[2] = edited[2]
    assert.equal(await f.git('show', `:${path}`), partial.join(newline) + newline)
    assert.equal(await readFile(file, 'utf8'), draft)
    await assert.rejects(f.call('stage-hunk', { paths: [path], snapshot: diff.snapshot, hunk: 1 }), { code: 'GIT_STALE_DIFF' })
    const index = await f.call('diff', { paths: [path], staged: true })
    await f.call('unstage-hunk', { paths: [path], snapshot: index.snapshot, hunk: 0 })
    assert.equal(await f.git('show', `:${path}`), original)
    assert.equal(await readFile(file, 'utf8'), draft)
    const next = await f.call('diff', { paths: [path] })
    await f.call('stage-hunk', { paths: [path], snapshot: next.snapshot, hunk: 1 })
    assert.match(await f.git('show', `:${path}`), /second change/u)
    assert.doesNotMatch(await f.git('show', `:${path}`), /first change/u)
    await f.git('reset', '--hard', 'HEAD')
  }
})

test('discard requires confirmation, keeps staged changes and deletes only selected untracked files', async t => {
  const f = await createGitFixture(); t.after(() => f.dispose())
  const file = join(f.root, 'tracked.txt')
  await writeFile(file, 'base\n'); await f.git('add', '.'); await f.git('commit', '-m', 'base')
  await writeFile(file, 'staged\n'); await f.call('stage', { paths: ['tracked.txt'] })
  await writeFile(file, 'working\n')
  await assert.rejects(f.call('discard', { paths: ['tracked.txt'] }), { code: 'GIT_CONFIRM_REQUIRED' })
  const plan = paths => f.call('prepare-discard', { paths })
  await f.call('discard', { paths: ['tracked.txt'], snapshot: (await plan(['tracked.txt'])).snapshot, confirmed: true })
  assert.equal(await readFile(file, 'utf8'), 'staged\n')
  assert.equal(await f.git('show', ':tracked.txt'), 'staged\n')
  await mkdir(join(f.root, 'new'))
  await writeFile(join(f.root, 'new/[one].txt'), 'remove')
  await writeFile(join(f.root, 'new/o.txt'), 'keep')
  await assert.rejects(f.call('discard', { paths: ['new'], confirmed: true }), { code: 'GIT_STALE_DIFF' })
  await f.call('discard', { paths: ['new/[one].txt'], snapshot: (await plan(['new/[one].txt'])).snapshot, confirmed: true })
  await assert.rejects(readFile(join(f.root, 'new/[one].txt')), { code: 'ENOENT' })
  assert.equal(await readFile(join(f.root, 'new/o.txt'), 'utf8'), 'keep')
  await assert.rejects(f.call('discard', { paths: ['../outside'], confirmed: true }), { code: 'GIT_INVALID_PATH' })
  f.setMode('read-only')
  await assert.rejects(f.call('discard', { paths: ['new/o.txt'], confirmed: true }), { code: 'FS_SANDBOX_DENIED' })
  await assert.rejects(f.call('stage-hunk', { paths: ['tracked.txt'], snapshot: 'x', hunk: 0 }), { code: 'FS_SANDBOX_DENIED' })
})

test('each commit exposes its own changed files and immutable diffs, including root, rename, deletion and merge', async t => {
  const f = await createGitFixture(); t.after(() => f.dispose())
  await writeFile(join(f.root, 'old name.txt'), 'one\ntwo\nthree\n')
  await writeFile(join(f.root, 'delete.txt'), 'delete\n')
  await f.git('add', '.'); await f.git('commit', '-m', 'initial')
  const first = (await f.git('rev-parse', 'HEAD')).trim()
  await rename(join(f.root, 'old name.txt'), join(f.root, '新名称.txt'))
  await rm(join(f.root, 'delete.txt')); await writeFile(join(f.root, 'add.txt'), 'added\n')
  await f.git('add', '-A'); await f.git('commit', '-m', 'rename add delete')
  const second = (await f.git('rev-parse', 'HEAD')).trim()
  f.setMode('read-only')
  const initial = await f.call('commit-files', { commit: first })
  assert.equal(initial.parent, null); assert.deepEqual(initial.files.map(row => row.status), ['A', 'A'])
  assert.match((await f.call('commit-diff', { commit: first, paths: ['delete.txt'] })).patch, /\+delete/u)
  const detail = await f.call('commit-files', { commit: second })
  assert.ok(detail.files.some(row => row.status === 'R' && row.path === '新名称.txt' && row.from === 'old name.txt'))
  assert.ok(detail.files.some(row => row.status === 'D' && row.path === 'delete.txt'))
  assert.match((await f.call('commit-diff', { commit: second, paths: ['delete.txt'] })).patch, /-delete/u)
  await writeFile(join(f.root, 'add.txt'), 'unrelated current draft\n')
  const historical = await f.call('commit-diff', { commit: second, paths: ['add.txt'] })
  assert.match(historical.patch, /\+added/u); assert.doesNotMatch(historical.patch, /current draft/u)
  await assert.rejects(f.call('commit-files', { commit: 'HEAD; bad' }), { code: 'GIT_INVALID_COMMIT' })
  await f.git('restore', '--worktree', 'add.txt')
  await f.git('checkout', '-b', 'feature'); await writeFile(join(f.root, 'feature.txt'), 'feature\n')
  await f.git('add', '.'); await f.git('commit', '-m', 'feature')
  await f.git('checkout', 'main'); await f.git('merge', '--no-ff', 'feature', '-m', 'merge')
  const merge = await f.call('commit-files', { commit: (await f.git('rev-parse', 'HEAD')).trim() })
  assert.equal(merge.merge, true); assert.deepEqual(merge.files.map(row => row.path), ['feature.txt'])
})


test('isolated hunks use the index coordinates in both directions despite identical neighbouring contexts', async t => {
  const f = await createGitFixture(); t.after(() => f.dispose())
  const path = 'repeat.txt', disk = join(f.root, path), paths = [path]
  const base = Array.from({ length: 115 }, (_, i) => `unique ${i}`)
  for (const start of [18, 38, 58]) for (let i = 0; i < 9; i++) base[start+i] = `repeat-${i}`
  const text = rows => rows.join('\n') + '\n'
  await writeFile(disk, text(base)); await f.git('add', '.'); await f.git('commit', '-m', 'base')
  for (const shift of ['insert', 'delete']) {
    const withShift = [...base]
    if (shift === 'insert') withShift.splice(2, 0, ...Array.from({length:20}, (_,i) => `extra ${i}`))
    else withShift.splice(0, 20)
    const changed = [...withShift]; changed[42 + (shift === 'insert' ? 20 : -20)] = 'selected line'
    await writeFile(disk, text(changed))
    const before = await f.call('diff', { paths }); assert.equal(before.hunkCount, 2)
    await f.call('stage-hunk', { paths, hunk: 1, snapshot: before.snapshot })
    const onlySelected = [...base]; onlySelected[42] = 'selected line'
    assert.equal(await f.git('show', ':' + path), text(onlySelected))
    await f.call('stage', { paths })
    const staged = await f.call('diff', { paths, staged: true }); assert.equal(staged.hunkCount, 2)
    await f.call('unstage-hunk', { paths, hunk: 1, snapshot: staged.snapshot })
    assert.equal(await f.git('show', ':' + path), text(withShift)); assert.equal(await readFile(disk, 'utf8'), text(changed))
    await f.call('unstage', { paths })
  }
})

test('whole-file stage and unstage treat bracketed filenames literally', async t => {
  const f = await createGitFixture(); t.after(() => f.dispose())
  const selected = 'item[1].txt', other = 'item1.txt'
  for (const path of [selected, other]) await writeFile(join(f.root,path), 'base\n')
  await f.git('add', '.'); await f.git('commit', '-m', 'base')
  for (const path of [selected, other]) await writeFile(join(f.root,path), 'modified\n')
  await f.call('stage', { paths: [selected] }); assert.equal((await f.git('diff','--cached','--name-only')).trim(), selected)
  await f.call('stage', { paths: [other] }); await f.call('unstage',{paths:[selected]})
  assert.equal((await f.git('diff','--cached','--name-only')).trim(), other)
})

test('discard refuses changed action, worktree bytes or staged restore target after confirmation opens', async t => {
  const f = await createGitFixture(); t.after(() => f.dispose())
  const path = 'notes.txt', paths = [path], disk = join(f.root,path)
  const plan = () => f.call('prepare-discard', { paths }); const discard = snapshot => f.call('discard', { paths, snapshot, confirmed: true })
  await writeFile(disk, 'base\n'); await f.git('add','.'); await f.git('commit','-m','init'); await writeFile(disk,'work A\n')
  const tracked = await plan(); assert.equal(tracked.files[0].removed,false)
  await writeFile(disk,'work B\n'); await assert.rejects(discard(tracked.snapshot), {code:'GIT_STALE_DIFF'}); assert.equal(await readFile(disk,'utf8'),'work B\n')
  const old = await plan(); await f.git('rm','--cached','--',path); await f.git('commit','-m','stop tracking')
  await assert.rejects(discard(old.snapshot), {code:'GIT_STALE_DIFF'}); assert.equal(await readFile(disk,'utf8'),'work B\n')
  const untracked = await plan(); assert.equal(untracked.files[0].removed,true); await writeFile(disk,'work C\n')
  await assert.rejects(discard(untracked.snapshot), {code:'GIT_STALE_DIFF'}); assert.equal(await readFile(disk,'utf8'),'work C\n')
  await f.git('add','.'); await f.git('commit','-m','track again'); await writeFile(disk,'next\n'); await f.git('add','.')
  await writeFile(disk,'disk unchanged\n'); const pending = await plan()
  const blob = (await f.git('rev-parse','HEAD:'+path)).trim(); await f.git('update-index','--cacheinfo',`100644,${blob},${path}`)
  await assert.rejects(discard(pending.snapshot),{code:'GIT_STALE_DIFF'});assert.equal(await readFile(disk,'utf8'),'disk unchanged\n')
})


test('reverse hunk with duplicate postimages restores the selected index line, not an earlier matching block', async t => {
  const f = await createGitFixture(); t.after(() => f.dispose())
  const path = 'reverse.txt', paths = [path], disk = join(f.root,path)
  const base = Array.from({length:100}, (_,i) => `unique ${i}`)
  for (const start of [18,38,58]) for (let i=0;i<9;i++) base[start+i] = `repeat-${i}`
  base[42] = 'original at line 43'
  const text = rows => rows.join('\n') + '\n'
  await writeFile(disk,text(base)); await f.git('add','.'); await f.git('commit','-m','base')
  const expected = [...base]; expected.splice(3,0,...Array.from({length:20},(_,i)=>`insert ${i}`))
  const changed = [...expected]; changed[62] = 'repeat-4'
  await writeFile(disk,text(changed)); await f.call('stage',{paths})
  const diff = await f.call('diff',{paths,staged:true}); assert.equal(diff.hunkCount,2)
  await f.call('unstage-hunk',{paths,snapshot:diff.snapshot,hunk:1})
  assert.equal(await f.git('show',':'+path),text(expected)); assert.equal(await readFile(disk,'utf8'),text(changed))
})


test('large multi-directory picks use literal paths in one index operation, including before the first commit', async t => {
  const f = await createGitFixture(); t.after(() => f.dispose())
  const names = []
  for (const dir of ['中文 目录', 'second']) {
    await mkdir(join(f.root, dir))
    for (let i = 0; i < 110; i++) {
      const path = `${dir}/item[${i}]-${'name'.repeat(38)}.txt`
      names.push(path); await writeFile(join(f.root,path),'selected\n')
    }
  }
  assert.ok(names.join(' ').length > 32767, 'file list exceeds a Windows command line')
  const keep = 'keep staged.txt', untouched = 'remain untracked.txt'
  await writeFile(join(f.root,keep),'keep\n'); await writeFile(join(f.root,untouched),'untouched\n')
  await f.call('stage',{paths:[keep]}); await f.call('stage',{paths:names})
  const tracked = async () => new Set((await f.git('ls-files','-z')).split('\0').filter(Boolean))
  assert.deepEqual(await tracked(),new Set([keep,...names]))
  await f.call('unstage',{paths:names}); assert.deepEqual(await tracked(),new Set([keep]))
  await f.git('commit','-m','baseline'); await f.call('stage',{paths:names}); await f.call('unstage',{paths:names})
  assert.deepEqual(await tracked(),new Set([keep])); assert.equal(await readFile(join(f.root,names.at(-1)),'utf8'),'selected\n')
})
