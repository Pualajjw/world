/** 插件留下的可打开位置：IMA 与 PowerBuilder 工程，以及 pbnpm 的 bin 目录。 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createWorkspaceRoots, discoverToolDirs } from '../workspace-roots.js'

class FakeFsError extends Error {
  constructor(message, code) { super(message); this.code = code }
}

const roots = []
after(async () => {
  await Promise.all(roots.map(dir => rm(dir, { recursive: true, force: true })))
})

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'world-roots-'))
  roots.push(dir)
  return dir
}

/** 不存在的路径返回 undefined，目录返回 directory——和宿主 fs.stat 的约定一致。 */
function fakeContext({ mount = null, directories = [], treeRoots = [] } = {}) {
  const known = new Set(directories.map(item => item.replace(/\\/gu, '/')))
  const mounted = mount ? mount.replace(/\\/gu, '/') : null
  return {
    fs: {
      async resolve(path) { return String(path).replace(/\\/gu, '/') },
      async stat(path) {
        const key = String(path).replace(/\\/gu, '/')
        if (key === mounted || known.has(key)) return { type: 'directory' }
        return undefined
      },
      processPath: path => path,
    },
    get: id => id === 'projectTreeRoots'
      ? { list: () => treeRoots }
      : undefined,
  }
}

test('discovers the pbnpm bin folder in both install layouts', async () => {
  const base = await workspace()
  const installed = join(base, 'dsh-world')
  const sibling = join(base, 'pbnpm', 'bin')
  await mkdir(join(base, 'dsh-pbnpm', 'bin'), { recursive: true })
  await mkdir(sibling, { recursive: true })
  await mkdir(installed, { recursive: true })
  await writeFile(join(base, 'dsh-pbnpm', 'bin', 'pbnpm.exe'), '')
  await writeFile(join(sibling, 'pbnpm.exe'), '')

  const dirs = discoverToolDirs(installed)
  assert.equal(dirs.length, 2)
  assert.ok(dirs[0].endsWith('dsh-pbnpm\\bin') || dirs[0].endsWith('dsh-pbnpm/bin'))
  assert.ok(dirs.some(dir => dir.includes(join('pbnpm', 'bin'))))
})

test('a bin folder without the executable is not put on PATH', async () => {
  const base = await workspace()
  await mkdir(join(base, 'dsh-pbnpm', 'bin'), { recursive: true })
  assert.deepEqual(discoverToolDirs(base), [])
})

test('scan reports the IMA mount registered by project-tree', async () => {
  const home = await workspace()
  const mount = join(home, 'ima', 'knowledge.workspace')
  await mkdir(mount, { recursive: true })
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = fakeContext({ mount, treeRoots: [{ id: 'ima', label: 'IMA', path: mount }] })
    const service = createWorkspaceRoots(ctx, { FsError: FakeFsError, toolDirs: () => [] })
    const result = await service.call('scan', {})
    assert.equal(result.ima.available, true)
    assert.equal(result.ima.path, mount.replace(/\\/gu, '/'))
    assert.equal(result.ima.error, '')
    assert.deepEqual(result.projects, [])
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('an unmounted IMA still yields a path and a reason', async () => {
  const home = await workspace()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = fakeContext()
    const service = createWorkspaceRoots(ctx, { FsError: FakeFsError, toolDirs: () => [] })
    const result = await service.call('scan', {})
    assert.equal(result.ima.available, false)
    assert.match(result.ima.path.replace(/\\/gu, '/'), /ima\/knowledge\.workspace$/u)
    assert.match(result.ima.error, /ima 插件/u)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('PowerBuilder projects come from both registries without duplicates', async () => {
  const home = await workspace()
  const workspaceDir = join(home, 'proj', 'tj.workspace')
  const exeWorkspace = join(home, 'proj', 'tj.pbd.workspace')
  await mkdir(workspaceDir, { recursive: true })
  await mkdir(exeWorkspace, { recursive: true })
  const pbt = join(home, 'proj', 'tj.pbt')
  const exe = join(home, 'proj', 'tj.exe')
  const entry = root => ({ root, pbtPath: pbt, pbVersion: 90, libraries: [{ name: 'a.pbl', path: 'x' }] })
  await mkdir(join(home, 'pbnpm-pbd'), { recursive: true })
  await mkdir(join(home, 'pbnpm'), { recursive: true })
  await writeFile(join(home, 'pbnpm-pbd', 'projects.json'), JSON.stringify({
    version: 1,
    projects: [entry(workspaceDir), { root: exeWorkspace, pbtPath: exe, pbVersion: 80, libraries: [] }, entry(join(home, 'gone'))],
  }))
  await writeFile(join(home, 'pbnpm', 'projects.json'), JSON.stringify({ version: 1, projects: [entry(workspaceDir)] }))

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = fakeContext({ directories: [workspaceDir, exeWorkspace] })
    const service = createWorkspaceRoots(ctx, { FsError: FakeFsError, toolDirs: () => [join(home, 'bin')] })
    const result = await service.call('scan', {})
    assert.equal(result.projects.length, 2)
    const byKind = Object.fromEntries(result.projects.map(item => [item.kind, item]))
    assert.equal(byKind.pbt.root.replace(/\\/gu, '/'), workspaceDir.replace(/\\/gu, '/'))
    assert.equal(byKind.exe.pbVersion, 80)
    assert.equal(byKind.pbt.libraries, 1)
    // 同一 root 在第二个登记文件里重复出现时只保留一条
    assert.equal(result.projects.filter(item => item.kind === 'pbt').length, 1)
    // 目录已经不存在的工程不该出现在侧栏里
    assert.equal(result.projects.some(item => item.root.includes('gone')), false)
    assert.equal(result.tools[0].name, 'pbnpm')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('a broken registry file is treated as empty', async () => {
  const home = await workspace()
  await mkdir(join(home, 'pbnpm-pbd'), { recursive: true })
  await writeFile(join(home, 'pbnpm-pbd', 'projects.json'), '{ not json')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = fakeContext({ treeRoots: [{ id: 'ima', label: 'IMA', path: join(home, 'missing') }] })
    const service = createWorkspaceRoots(ctx, { FsError: FakeFsError, toolDirs: () => [] })
    const result = await service.call('scan', {})
    assert.deepEqual(result.projects, [])
    // 注册过但读不出内容：错误要说「检查授权」，而不是「没装插件」
    assert.match(result.ima.error, /授权/u)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
