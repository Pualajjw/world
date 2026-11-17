import assert from 'node:assert/strict'
import test from 'node:test'
import { createUnixProcessCollector, parseProcStat, parsePs } from '../process-manager-unix.js'
import { createWorldProcesses, dshProcessTree } from '../process-manager.js'

function procStat(pid, parent, start, ticks = 200) {
  const fields = Array(40).fill('0')
  fields[0] = 'S'; fields[1] = String(parent); fields[11] = String(ticks); fields[12] = '100'; fields[19] = String(start)
  return `${pid} (DSH worker (child)) ${fields.join(' ')}`
}
const ps = ' 10 1 Tue Nov 17 09:00:00 2026 01:02.50 1024 /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness\n' +
  ' 11 10 Tue Nov 17 09:01:00 2026 1-02:03:04 2048 /Applications/DSH helper\n' +
  ' 99 1 Tue Nov 17 08:00:00 2026 00:01.00 4000 /usr/bin/unrelated\n'

test('Linux parser handles spaces and parentheses, and macOS ps handles app paths, days and fractional CPU seconds', () => {
  assert.equal(parseProcStat(procStat(10, 1, 42)).name, 'DSH worker (child)')
  assert.equal(parseProcStat(procStat(10, 1, 42)).startedAt, '00000000000000000042')
  assert.equal(parsePs(ps)[0].cpuMs, 62500)
  assert.equal(parsePs(ps)[1].cpuMs, 93784000)
  assert.equal(parsePs(ps)[0].name, 'DeepSeek Harness')
  assert.deepEqual(parsePs('invalid ps output'), [])
})

test('Linux collection limits resources and file owners to the DSH process tree and uses procfs without lsof', async () => {
  const commands = [], inspected = []
  const collector = createUnixProcessCollector({ platform: 'linux', selectTree: dshProcessTree, coreCount: () => 8,
    run: async (file, args) => { commands.push({ file, args }); return { stdout: '100\n' } },
    list: async path => path === '/proc' ? ['10', '11', '99', 'self'] : ['0', '1'],
    readText: async path => {
      const pid = Number(path.split('/')[2])
      if (path.endsWith('/stat')) return procStat(pid, pid === 11 ? 10 : 1, pid + 100)
      return 'VmRSS:\t2000 kB\nRssAnon:\t800 kB\nThreads:\t4\n'
    },
    link: async () => '/opt/DSH/deepseek-harness',
    inspect: async path => { inspected.push(path); return { dev: 1, ino: path === '/tmp/文 件.txt' || path === '/proc/11/fd/1' ? 20 : 21 } },
  })
  const service = createWorldProcesses({ platform: 'linux', rootPid: 10, collector, resolveFile: async path => path, inspectFile: async () => ({ isFile: () => true }) })
  try {
    const snapshot = await service.call('snapshot')
    assert.deepEqual(snapshot.rows.map(row => row.pid).sort(), [10, 11]); assert.equal(snapshot.platform, 'linux')
    assert.equal(snapshot.rows[0].privateBytes, 800 * 1024); assert.equal(snapshot.rows[0].handles, 2)
    const files = await service.call('files', { path: '/tmp/文 件.txt' })
    assert.deepEqual(files.owners.map(row => row.pid), [11])
    assert.equal(inspected.some(path => path.includes('/99/')), false)
    assert.deepEqual(commands, [{ file: 'getconf', args: ['CLK_TCK'] }])
    await assert.rejects(service.call('files', { path: 'C:\\not-posix' }), { code: 'WORLD_PROCESSES_PATH' })
  } finally { service.dispose() }
})

test('Linux file-owner permission errors do not become a false no-owner result', async () => {
  const collector = createUnixProcessCollector({ platform: 'linux', selectTree: dshProcessTree,
    run: async () => ({ stdout: '100' }), readText: async () => procStat(10, 1, 100),
    list: async path => { if (path === '/proc') return ['10']; throw new Error('permission denied') },
    link: async () => '/opt/dsh', inspect: async () => ({ ino: 1, dev: 1 }),
  })
  try { await assert.rejects(collector.collect('files', { rootPid: 10, path: '/tmp/file' }), /无权/u) }
  finally { collector.dispose() }
})

test('macOS lsof arguments are data, only DSH owners survive and unsupported metrics stay null', async () => {
  const calls = [], path = '/Users/a/a ;$(no).txt'
  let missing = false
  const collector = createUnixProcessCollector({ platform: 'darwin', selectTree: dshProcessTree, run: async (file, args, options) => {
    calls.push({ file, args, options })
    if (file.endsWith('/ps')) return { stdout: ps }
    if (missing) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return { stdout: 'p11\nn' + path + '\np99\nn' + path + '\n' }
  } })
  try {
    const result = await collector.collect('files', { rootPid: 10, path })
    assert.deepEqual(result.owners.map(row => row.pid), [11])
    assert.equal(result.rows[0].privateBytes, null)
    assert.deepEqual(calls.find(call => call.file.endsWith('/lsof')).args, ['-a', '-p', '10,11', '-Fpn', '--', path])
    assert.equal(calls[0].options.env.LC_ALL, 'C')
    missing = true
    await assert.rejects(collector.collect('files', { rootPid: 10, path }), /缺少 lsof/u)
  } finally { collector.dispose() }
})

test('actual Unix process snapshot when run on Linux or macOS', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  const manager = createWorldProcesses({ rootPid: process.pid })
  try {
    const result = await manager.call('snapshot')
    assert.ok(result.rows.some(row => row.pid === process.pid && row.workingSet > 0))
    assert.equal(result.platform, process.platform)
  } finally { manager.dispose() }
})
