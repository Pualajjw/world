/** `~/.ssh/config` 的解析：主机清单只用来做提示和补全，连不连得上交给 ssh。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expandTilde, parseSshConfig, tokenizeSshLine } from '../ssh-config.js'

test('a host block keeps its aliases and fields', () => {
  const { hosts } = parseSshConfig([
    'Host web',
    '  HostName 10.0.0.5',
    '  User deploy',
    '  Port 2222',
    '  IdentityFile ~/.ssh/id_ed25519',
    '',
    'Host db cache',
    '  HostName 10.0.0.6',
  ].join('\n'))
  assert.deepEqual(hosts.map(host => host.alias), ['web', 'db', 'cache'])
  const [web, db, cache] = hosts
  assert.equal(web.hostName, '10.0.0.5')
  assert.equal(web.user, 'deploy')
  assert.equal(web.port, '2222')
  assert.equal(web.identityFile, '~/.ssh/id_ed25519')
  // 一个 Host 行里的多个别名共享下面这段配置
  assert.equal(db.hostName, '10.0.0.6')
  assert.equal(cache.hostName, '10.0.0.6')
  assert.equal(cache.line, 7)
})

test('hostName falls back to the alias and trailing comments are ignored', () => {
  const { hosts } = parseSshConfig([
    '# 这是我自己的注释',
    'Host only-alias # 行尾注释',
    'Host plain',
  ].join('\n'))
  assert.deepEqual(hosts.map(host => host.alias), ['only-alias', 'plain'])
  assert.equal(hosts[1].hostName, 'plain')
  assert.equal(hosts[0].hostName, 'only-alias')
})

test('wildcard and negated patterns are defaults, not connectable hosts', () => {
  const { hosts } = parseSshConfig([
    'Host *',
    '  User root',
    'Host !bad web*',
    '  Port 22',
    'Host real',
    '  HostName example.com',
  ].join('\n'))
  assert.deepEqual(hosts.map(host => host.alias), ['real'])
  assert.equal(hosts[0].hostName, 'example.com')
})

test('the first block for an alias wins, like ssh', () => {
  const { hosts } = parseSshConfig([
    'Host web',
    '  HostName first.example.com',
    'Host web',
    '  HostName second.example.com',
    '  User nope',
  ].join('\n'))
  assert.equal(hosts.length, 1)
  assert.equal(hosts[0].hostName, 'first.example.com')
  assert.equal(hosts[0].user, '')
})

test('match blocks contribute nothing to the host list', () => {
  const { hosts } = parseSshConfig([
    'Match host bastion exec "true"',
    '  User jump',
    'Host after',
    '  User later',
  ].join('\n'))
  assert.deepEqual(hosts.map(host => host.alias), ['after'])
  assert.equal(hosts[0].user, 'later')
})

test('include lines are reported so the loader can follow them', () => {
  const { includes } = parseSshConfig([
    'Include ~/.ssh/conf.d/*.conf',
    'Include work.conf',
    'Host x',
  ].join('\n'))
  assert.deepEqual(includes, ['~/.ssh/conf.d/*.conf', 'work.conf'])
})

test('quotes, equals signs and mixed case keywords are understood', () => {
  assert.deepEqual(tokenizeSshLine('HostName="my host" User=me'), ['HostName', 'my host', 'User', 'me'])
  assert.deepEqual(tokenizeSshLine("IdentityFile 'C:\\Users\\me\\key file'"), ['IdentityFile', 'C:\\Users\\me\\key file'])
  const { hosts } = parseSshConfig([
    'HOST quoted',
    '  hostname = "quoted.example.com"',
    '  USER=someone',
  ].join('\n'))
  assert.equal(hosts[0].hostName, 'quoted.example.com')
  assert.equal(hosts[0].user, 'someone')
})

test('tilde expansion only touches a leading ~', () => {
  const home = 'C:\\Users\\me'
  assert.equal(expandTilde('~/.ssh/config', home), 'C:\\Users\\me/.ssh/config')
  assert.equal(expandTilde('~', home), home)
  assert.equal(expandTilde('a/~/b', home), 'a/~/b')
  assert.equal(expandTilde('', home), '')
})

test('empty input is an empty config', () => {
  assert.deepEqual(parseSshConfig(''), { hosts: [], includes: [], warnings: [] })
  assert.deepEqual(parseSshConfig(undefined), { hosts: [], includes: [], warnings: [] })
})
