import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { lstat, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { promisify } from 'node:util'
import { createVscodeGit } from '../git.js'

export async function createGitFixture() {
  const root = await mkdtemp(join(tmpdir(), 'world-git-flow-'))
  let mode = 'workspace-write'
  class FsError extends Error { constructor(message, code) { super(message); this.code = code } }
  const subprocess = { spawn(spec) {
    const input = typeof spec.stdio.stdin === 'object' ? spec.stdio.stdin.data : undefined
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, windowsHide: true,
      env: { ...process.env, ...spec.env }, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    const collect = (stream, max) => {
      let bytes = Buffer.alloc(0), lossy = false
      stream.on('data', chunk => { bytes = Buffer.concat([bytes, chunk]); lossy ||= bytes.length > max; bytes = bytes.subarray(-max) })
      return { readFrom: () => ({ text: bytes.toString('utf8'), lossy }) }
    }
    const collected = { stdout: collect(child.stdout, spec.stdio.stdout.maxBytes), stderr: collect(child.stderr, spec.stdio.stderr.maxBytes) }
    const terminate = () => { if (!child.killed) child.kill() }
    const done = new Promise(resolve => {
      child.once('error', error => resolve({ exitCode: null, signal: 'error', error }))
      child.once('close', (exitCode, signal) => { spec.signal?.removeEventListener('abort', terminate); resolve({ exitCode, signal }) })
    })
    spec.signal?.addEventListener('abort', terminate, { once: true })
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input) }
    return { done, collected, terminate, waitForExit: () => done }
  } }
  const service = createVscodeGit({
    fs: { resolve: async (file, options) => resolve(options.cwd || root, file), processPath: file => file,
      lstat: async file => { const s = await lstat(file, { bigint: true }).catch(e => { if (e.code !== 'ENOENT') throw e });
        return s && { type: s.isFile() ? 'file' : s.isSymbolicLink() ? 'symlink' : 'directory', version: `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` } },
      stat: async file => { try { const info = await stat(file); return { type: info.isDirectory() ? 'directory' : 'file' } } catch (error) { if (error.code === 'ENOENT') return null; throw error } } },
    sessions: { get: id => id === 'session-1' ? { header: { cwd: root } } : null }, get: () => undefined,
    sandboxPolicy: { resolve: () => ({ mode }) },
  }, { FsError, subprocess })
  const git = async (...args) => (await promisify(execFile)('git', ['-C', root, ...args], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout
  await git('init', '-b', 'main')
  await git('config', 'user.name', 'World Git Fixture')
  await git('config', 'user.email', 'world-git@example.invalid')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.autocrlf', 'false')
  return { root, git, service, setMode: value => { mode = value },
    call: (op, payload = {}) => service.call(op, { sessionId: 'session-1', ...payload }),
    async dispose() { await service.dispose(); assert.equal(dirname(root), tmpdir()); assert.ok(basename(root).startsWith('world-git-flow-')); await rm(root, { recursive: true, force: true }) } }
}
