import assert from 'node:assert/strict'
import test from 'node:test'
import { hasInternetPrivileges } from '../internet-privileges.js'

test('Windows checks the effective token without opening a console or requesting elevation', async () => {
  const calls = []
  const run = async (...args) => { calls.push(args); return { stdout: 'False\r\n' } }
  assert.equal(await hasInternetPrivileges({ platform: 'win32', run }), false)
  assert.equal(calls[0][2].windowsHide, true)
  assert.equal(calls[0][2].timeout, 5000)
  assert.match(calls[0][1].at(-1), /IsInRole.*Administrator/u)
  assert.doesNotMatch(calls[0][1].join(' '), /RunAs|Start-Process/u)
  assert.equal(await hasInternetPrivileges({ platform: 'win32', run: async () => ({ stdout: 'True' }) }), true)
  await assert.rejects(hasInternetPrivileges({ platform: 'win32', run: async () => ({ stdout: 'unknown' }) }), /无法确认/u)
  await assert.rejects(hasInternetPrivileges({ platform: 'win32', run: async () => { throw new Error('timeout') } }), /timeout/u)
})

test('POSIX checks root and Linux effective CAP_NET_ADMIN', async () => {
  for (const platform of ['darwin', 'linux']) {
    assert.equal(await hasInternetPrivileges({ platform, effectiveUid: () => 0 }), true)
  }
  assert.equal(await hasInternetPrivileges({ platform: 'darwin', effectiveUid: () => 501 }), false)
  assert.equal(await hasInternetPrivileges({ platform: 'linux', effectiveUid: () => 1000,
    readText: async () => 'CapEff:\t0000000000001000\n' }), true)
  assert.equal(await hasInternetPrivileges({ platform: 'linux', effectiveUid: () => 1000,
    readText: async () => 'CapEff:\t0000000000000000\n' }), false)
  await assert.rejects(hasInternetPrivileges({ platform: 'linux', effectiveUid: () => 1000,
    readText: async () => 'missing' }), /无法读取/u)
})
