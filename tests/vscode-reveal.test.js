/** Windows 资源管理器只认一个 `/select,<path>` 参数，拆成两段会变成打开文件。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createPathRevealer } from '../vscode-reveal.js'

test('reveal spawns explorer once and tolerates its nonzero exit code', async () => {
  const calls = []
  const handle = {
    done: Promise.resolve({ exitCode: 1, signal: null }),
    terminate() {},
    waitForExit: async () => true,
  }
  const revealer = createPathRevealer({
    spawn(spec) { calls.push(spec); return handle },
  })
  const target = 'C:/Users/a b/文件.txt'
  await revealer.reveal(target, new AbortController().signal)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].argv, ['explorer.exe', `/select,${target}`])
  // cwd 是宿主 spawn 的必填项
  assert.equal(calls[0].cwd, 'C:/Users/a b')
  await revealer.dispose()
})

test('reveal reports an unavailable shell as WORLD_REVEAL_UNAVAILABLE', async () => {
  const revealer = createPathRevealer({ spawn() { throw new Error('no win32') } })
  await assert.rejects(revealer.reveal('C:/tmp/a.txt'), { code: 'WORLD_REVEAL_UNAVAILABLE' })
  await revealer.dispose()
})

test('reveal surfaces a spawn failure reported through done', async () => {
  const revealer = createPathRevealer({
    spawn: () => ({
      done: Promise.reject(new Error('command not found on PATH')),
      terminate() {},
      waitForExit: async () => true,
    }),
  })
  await assert.rejects(revealer.reveal('C:/tmp/a.txt'), {
    code: 'WORLD_REVEAL_UNAVAILABLE',
    message: /无法打开资源管理器：command not found on PATH/,
  })
  await revealer.dispose()
})
