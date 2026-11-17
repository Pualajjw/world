import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:net'
import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { createWorldProcesses, dshProcessTree } from '../process-manager.js'
import { createUnixProcessCollector } from '../process-manager-unix.js'
import { parseLsofPorts, parseProcPorts } from '../process-ports.js'

const processRow = (pid, parentPid = 1, startedAt = '100') => ({ pid, parentPid, startedAt, name: `dsh-${pid}` })
const port = (pid, startedAt = '100', localPort = 53319) => ({ pid, startedAt, protocol: 'TCP', localAddress: '127.0.0.1',
  localPort, remoteAddress: '0.0.0.0', remotePort: 0, state: 'LISTEN' })
test('port ownership excludes unrelated and recycled PIDs, deduplicates endpoints and shares collection', async () => {
  let release, count = 0
  const manager = createWorldProcesses({ platform: 'win32', rootPid: 10, collector: {
    collect: async () => { count++; await new Promise(resolve => { release = resolve }); return {
      rows: [processRow(10), processRow(11, 10, '110'), processRow(99)], timestamp: 1000,
      ports: [port(10), port(10), port(11, '110', 15888), port(11, 'old'), port(99), port(10, '100', -1)],
    } }, dispose() {},
  } })
  try {
    const a = manager.call('ports'), b = manager.call('ports')
    await Promise.resolve(); release()
    const result = await a
    assert.deepEqual(result, await b); assert.equal(count, 1)
    assert.deepEqual(result.rows.map(row => [row.pid, row.localPort]), [[11, 15888], [10, 53319]])
  } finally { manager.dispose() }
})

test('Linux parses IPv4, IPv6 and UDP socket tables; macOS parses listening and established lsof fields', () => {
  const tcp = ' 0: 0100007F:D047 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 777\n'
  assert.deepEqual(parseProcPorts(tcp, 'TCP')[0], { protocol: 'TCP', localAddress: '127.0.0.1', localPort: 53319,
    remoteAddress: '0.0.0.0', remotePort: 0, state: 'LISTEN', inode: '777' })
  const v6 = tcp.replace('0100007F', '00000000000000000000000001000000').replace('00000000:0000', '00000000000000000000000000000000:0000')
  assert.equal(parseProcPorts(v6, 'UDP')[0].localAddress, '0:0:0:0:0:0:0:1')
  const lsof = 'p10\nf12\nPTCP\nn127.0.0.1:53319\nTST=LISTEN\nf14\nPTCP\nn[::1]:53320->[::1]:443\nTST=ESTABLISHED\np11\nf15\nPUDP\nn*:11010\n'
  const rows = parseLsofPorts(lsof)
  assert.equal(rows.length, 3); assert.equal(rows[1].remoteAddress, '::1')
  assert.equal(rows[1].remotePort, 443); assert.equal(rows[2].protocol, 'UDP'); assert.equal(rows[2].localPort, 11010)
})

test('Linux socket ownership comes from DSH file descriptors and validates the process after reading', async () => {
  const stat = pid => `${pid} (dsh) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100 0 0`
  const files = '0: 0100007F:D047 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 777\n'
    + '1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 999\n'
  const collector = createUnixProcessCollector({ platform: 'linux', selectTree: dshProcessTree,
    run: async () => ({ stdout: '100' }), list: async path => path === '/proc' ? ['10', '99'] : ['1'],
    readText: async path => path.endsWith('/stat') ? stat(Number(path.split('/')[2])) : path.endsWith('/tcp') ? files : '',
    link: async path => path.endsWith('/fd/1') ? 'socket:[777]' : '/opt/dsh',
  })
  try {
    const result = await collector.collect('ports', { rootPid: 10 })
    assert.equal(result.ports.length, 1); assert.equal(result.ports[0].pid, 10); assert.equal(result.ports[0].localPort, 53319)
  } finally { collector.dispose() }
})

test('macOS scopes lsof to DSH PIDs and excludes unrelated records', async () => {
  const ps = '10 1 Tue Nov 17 09:00:00 2026 00:01.00 1000 /opt/dsh\n11 10 Tue Nov 17 09:01:00 2026 00:01.00 1000 /opt/helper\n99 1 Tue Nov 17 08:00:00 2026 00:01.00 1000 /opt/other\n'
  const collector = createUnixProcessCollector({ platform: 'darwin', selectTree: dshProcessTree, run: async (file, args) => {
    if (file.endsWith('/ps')) return { stdout: ps }
    assert.deepEqual(args, ['-a', '-p', '10,11', '-nP', '-i', '-FpfPnT'])
    return { stdout: 'p11\nf1\nPTCP\nn127.0.0.1:53319\nTST=LISTEN\np99\nf2\nPUDP\nn*:11010\n' }
  } })
  try {
    const result = await collector.collect('ports', { rootPid: 10 })
    assert.deepEqual(result.ports.map(row => row.pid), [11])
  } finally { collector.dispose() }
})

test('port permission failures are reported and a later read can retry', async () => {
  let failed = true
  const manager = createWorldProcesses({ platform: 'win32', rootPid: 10, collector: {
    async collect() {
      if (failed) throw new Error('port permission denied')
      return { rows: [processRow(10)], ports: [port(10)], timestamp: 1000 }
    }, dispose() {},
  } })
  try {
    await assert.rejects(manager.call('ports'), /permission denied/u)
    failed = false
    assert.equal((await manager.call('ports')).rows.length, 1)
  } finally { manager.dispose() }
  const collector = createUnixProcessCollector({ platform: 'linux', selectTree: dshProcessTree,
    run: async () => ({ stdout: '100' }), list: async path => {
      if (path === '/proc') return ['10']
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    },
    readText: async () => '10 (dsh) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100 0 0', link: async () => '/opt/dsh',
  })
  try { await assert.rejects(collector.collect('ports', { rootPid: 10 }), /无权/u) }
  finally { collector.dispose() }
})

test('native TCP and UDP ports are attributed to this isolated DSH-like process', { timeout: 30000 }, async () => {
  const tcp = createServer(), udp = createSocket('udp4')
  await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve))
  udp.bind(0, '127.0.0.1'); await once(udp, 'listening')
  const manager = createWorldProcesses({ rootPid: process.pid })
  try {
    const result = await manager.call('ports')
    assert.ok(result.rows.some(row => row.pid === process.pid && row.protocol === 'TCP' && row.localPort === tcp.address().port))
    assert.ok(result.rows.some(row => row.pid === process.pid && row.protocol === 'UDP' && row.localPort === udp.address().port))
  } finally { manager.dispose(); await new Promise(resolve => tcp.close(resolve)); udp.close() }
})
