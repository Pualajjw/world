/** Connection evidence comes from EasyTier's peer list plus the assigned TUN IPv4. */
import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { isIPv4 } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export function internetConnectionFromPeers(rows, interfaces) {
  const disconnected = { connected: false, ipv4: '', peerCount: 0 }
  if (!Array.isArray(rows)) return disconnected
  const local = rows.find(row => row && String(row.cost).toLowerCase() === 'local' && isIPv4(String(row.ipv4 || '')))
  if (!local) return disconnected
  const assigned = Object.values(interfaces || {}).flatMap(rows => Array.isArray(rows) ? rows : [])
    .some(row => row && !row.internal && row.address === local.ipv4 && (row.family === 'IPv4' || row.family === 4))
  const peers = rows.filter(row => row && String(row.cost).toLowerCase() !== 'local' && row.id && row.id !== local.id
    && row.cost && String(row.cost).toLowerCase() !== 'local')
  return { connected: assigned && peers.length > 0, ipv4: local.ipv4, peerCount: peers.length }
}

export function createInternetConnectionProbe({ platform = process.platform, run = execute,
  interfaces = networkInterfaces, now = Date.now, cacheMs = 2000 } = {}) {
  let pending, previous, at = 0, generation = 0
  const lifetime = new AbortController()
  return {
    read(config) {
      if (lifetime.signal.aborted) return Promise.resolve({ connected: false, ipv4: '', peerCount: 0, checkedAt: now() })
      if (pending) return pending
      if (previous && now() - at < cacheMs) return Promise.resolve(previous)
      const startedGeneration = generation
      pending = (async () => {
        let result
        try {
          const name = platform === 'win32' ? 'easytier-cli.exe' : 'easytier-cli'
          const executable = config.directory ? join(config.directory, name) : name
          const { stdout } = await run(executable, ['-o', 'json', 'peer', 'list'], {
            windowsHide: true, encoding: 'utf8', timeout: 2500, maxBuffer: 1024 * 1024, signal: lifetime.signal,
          })
          result = { ...internetConnectionFromPeers(JSON.parse(stdout), interfaces()), checkedAt: now() }
        } catch { result = { connected: false, ipv4: '', peerCount: 0, checkedAt: now() } }
        if (startedGeneration !== generation || lifetime.signal.aborted) return { connected: false, ipv4: '', peerCount: 0, checkedAt: now() }
        previous = result; at = now()
        return result
      })().finally(() => { pending = null })
      return pending
    },
    invalidate() { generation++; previous = null },
    dispose() { lifetime.abort(); generation++; previous = null },
  }
}
