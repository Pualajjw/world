import { execFile } from 'node:child_process'
import { readFile, readdir, readlink, stat } from 'node:fs/promises'
import { cpus } from 'node:os'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { parseLsofPorts, parseProcPorts } from './process-ports.js'

const execute = promisify(execFile)
const identity = row => `${row.pid}:${row.startedAt}`
export function parseProcStat(text) {
  const end = text.lastIndexOf(')'), start = text.indexOf('(')
  if (start < 0 || end < start) throw new Error('Invalid /proc stat')
  const fields = text.slice(end + 2).trim().split(/\s+/u)
  const pid = Number(text.slice(0, start).trim()), parentPid = Number(fields[1]), ticks = Number(fields[19])
  if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || !Number.isFinite(ticks)) throw new Error('Invalid /proc identity')
  return { pid, parentPid, name: text.slice(start + 1, end), startedAt: String(ticks).padStart(20, '0'),
    cpuTicks: Number(fields[11]) + Number(fields[12]) }
}
const millis = text => {
  const [prefix, clock] = text.includes('-') ? text.split('-') : ['0', text]
  const pieces = clock.split(':').map(Number).reverse()
  return (Number(prefix) * 86400 + (pieces[2] || 0) * 3600 + (pieces[1] || 0) * 60 + (pieces[0] || 0)) * 1000
}
export function parsePs(text) {
  return text.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+([\d:.-]+)\s+(\d+)\s+(.+)$/u)
    if (!match) return []
    const timestamp = Date.parse(match[3])
    if (!Number.isFinite(timestamp)) return []
    return [{ pid: Number(match[1]), parentPid: Number(match[2]), startedAt: String(timestamp).padStart(20, '0'),
      cpuMs: millis(match[4]), workingSet: Number(match[5]) * 1024, privateBytes: null, handles: null, threads: null,
      path: match[6].trim(), name: basename(match[6].trim()) }]
  })
}

async function mapLimit(items, action) {
  let index = 0
  const output = []
  await Promise.all(Array.from({ length: Math.min(16, items.length) }, async () => {
    while (index < items.length) { const value = await action(items[index++]); if (value) output.push(value) }
  }))
  return output
}

/** Linux uses procfs; macOS uses system ps and lsof. No shell command interpolation. */
export function createUnixProcessCollector({ platform = process.platform, selectTree, proc = '/proc',
  readText = path => readFile(path, 'utf8'), list = readdir, link = readlink, inspect = stat, run = execute,
  coreCount = () => cpus().length } = {}) {
  const lifetime = new AbortController()
  let hz
  return {
    async collect(operation, { rootPid, path }, signal) {
      const active = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(15000)])
      active.throwIfAborted()
      const command = async (file, args) => run(file, args, { encoding: 'utf8', windowsHide: true, signal: active,
        timeout: 15000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } })
      let rows, owners = [], ports = []
      if (platform === 'linux') {
        hz ||= Number((await command('getconf', ['CLK_TCK'])).stdout.trim())
        if (!Number.isFinite(hz) || hz <= 0) throw new Error('无法读取 Linux 时钟频率。')
        const ids = (await list(proc)).filter(name => /^\d+$/u.test(name))
        const all = await mapLimit(ids, async pid => {
          active.throwIfAborted()
          try { return parseProcStat(await readText(`${proc}/${pid}/stat`)) } catch { return null }
        })
        rows = selectTree(all, rootPid)
        const target = operation === 'files' ? await inspect(path) : null
        rows = await mapLimit(rows, async row => {
          active.throwIfAborted()
          let status = '', executable = '', fds = []
          try { status = await readText(`${proc}/${row.pid}/status`) } catch {}
          try { executable = await link(`${proc}/${row.pid}/exe`) } catch {}
          let handles = null
          try { fds = await list(`${proc}/${row.pid}/fd`); handles = fds.length } catch (error) {
            if (operation === 'ports' && error.code === 'ENOENT') return null
            if (operation === 'files' || operation === 'ports') throw new Error(`无权查询 DSH 进程 ${row.pid} 的文件描述符。`)
          }
          if (target) {
            for (const fd of fds) {
              active.throwIfAborted()
              let opened
              try { opened = await inspect(`${proc}/${row.pid}/fd/${fd}`) } catch { continue }
              if (opened.dev === target.dev && opened.ino === target.ino) { owners.push(row); break }
            }
          }
          if (operation === 'ports') {
            const sockets = new Set()
            for (const fd of fds) {
              active.throwIfAborted()
              try {
                const match = /^socket:\[(\d+)\]$/u.exec(await link(`${proc}/${row.pid}/fd/${fd}`))
                if (match) sockets.add(match[1])
              } catch (error) { if (error.code === 'EACCES' || error.code === 'EPERM') throw new Error(`无权读取 DSH 进程 ${row.pid} 的端口。`) }
            }
            if (sockets.size) for (const table of ['tcp', 'tcp6', 'udp', 'udp6']) {
              active.throwIfAborted()
              let text
              try { text = await readText(`${proc}/${row.pid}/net/${table}`) }
              catch (error) {
                if (error.code === 'ENOENT') { if (table.endsWith('6')) continue; return null }
                throw new Error(`无法读取 DSH 进程 ${row.pid} 的 ${table} 端口。`)
              }
              ports.push(...parseProcPorts(text, table.startsWith('tcp') ? 'TCP' : 'UDP')
                .filter(endpoint => sockets.has(endpoint.inode)).map(endpoint => ({ ...endpoint, pid: row.pid, startedAt: row.startedAt })))
            }
          }
          try {
            const after = parseProcStat(await readText(`${proc}/${row.pid}/stat`))
            if (identity(after) !== identity(row)) return null
          } catch { return null }
          const value = key => { const match = status.match(new RegExp(`^${key}:\\s+(\\d+)`, 'mu')); return match ? Number(match[1]) : null }
          return { ...row, path: executable, name: executable ? basename(executable) : row.name, cpuMs: row.cpuTicks / hz * 1000,
            workingSet: value('VmRSS') === null ? null : value('VmRSS') * 1024,
            privateBytes: value('RssAnon') === null ? null : value('RssAnon') * 1024, handles, threads: value('Threads') }
        })
      } else if (platform === 'darwin') {
        rows = selectTree(parsePs((await command('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,time=,rss=,comm='])).stdout), rootPid)
        if (operation === 'files' && rows.length) {
          let output
          try { output = (await command('/usr/sbin/lsof', ['-a', '-p', rows.map(row => row.pid).join(','), '-Fpn', '--', path])).stdout }
          catch (error) {
            if (error.code === 1 && !String(error.stderr || '').trim()) output = error.stdout || ''
            else throw new Error(`无法查询文件占用：${error.code === 'ENOENT' ? '系统缺少 lsof' : error.stderr || error.message}`)
          }
          const pids = new Set(output.split('\n').filter(line => /^p\d+$/u.test(line)).map(line => Number(line.slice(1))))
          const after = new Map(parsePs((await command('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,time=,rss=,comm='])).stdout).map(row => [identity(row), row]))
          owners = rows.filter(row => pids.has(row.pid) && after.has(identity(row)))
        }
        if (operation === 'ports' && rows.length) {
          let output
          try { output = (await command('/usr/sbin/lsof', ['-a', '-p', rows.map(row => row.pid).join(','), '-nP', '-i', '-FpfPnT'])).stdout }
          catch (error) {
            if (error.code === 1 && !String(error.stderr || '').trim()) output = error.stdout || ''
            else throw new Error(`无法查询端口占用：${error.code === 'ENOENT' ? '系统缺少 lsof' : error.stderr || error.message}`)
          }
          const before = new Map(rows.map(row => [row.pid, row]))
          const after = new Set(parsePs((await command('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,time=,rss=,comm='])).stdout).map(identity))
          ports = parseLsofPorts(output).flatMap(endpoint => {
            const owner = before.get(endpoint.pid)
            return owner && after.has(identity(owner)) ? [{ ...endpoint, startedAt: owner.startedAt }] : []
          })
        }
      } else throw new Error('当前系统不支持进程采集。')
      active.throwIfAborted()
      const valid = new Set(rows.map(identity))
      return { rows, owners: owners.filter(row => valid.has(identity(row))), ports: ports.filter(row => valid.has(identity(row))), timestamp: Date.now(), cores: coreCount() }
    },
    dispose() { lifetime.abort() },
  }
}
