import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { APP_FORMAT, MAX_APP_FILE, RESERVED_IDS, parseWorldApp } from '../app-format.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const valid = {
  format: APP_FORMAT,
  id: 'team-wiki',
  name: '团队 Wiki',
  description: '内网知识库',
  icon: '📚',
  color: '#22aa88',
  url: 'http://127.0.0.1:8080/',
  size: { w: 82, h: 76 },
}

test('accepts a well formed .worldapp and normalizes defaults', () => {
  const parsed = parseWorldApp(JSON.stringify(valid))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.app.id, 'team-wiki')
  assert.equal(parsed.app.url, 'http://127.0.0.1:8080/')
  assert.deepEqual(parsed.app.size, { w: 82, h: 76 })

  const minimal = parseWorldApp(JSON.stringify({ format: APP_FORMAT, id: 'a1', name: 'A', url: 'https://example.com/' }))
  assert.equal(minimal.ok, true)
  assert.equal(minimal.app.icon, '🧩')
  assert.equal(minimal.app.color, '#4c86ff')
  assert.deepEqual(minimal.app.size, { w: 80, h: 80 })
})

test('rejects invalid format, id, name and oversized packages', () => {
  assert.match(parseWorldApp('{').error, /JSON/)
  assert.match(parseWorldApp(JSON.stringify({ ...valid, format: 'other/1' })).error, /format/)
  assert.match(parseWorldApp(JSON.stringify({ ...valid, id: 'Bad ID' })).error, /id/)
  assert.match(parseWorldApp(JSON.stringify({ ...valid, name: '' })).error, /名称/)
  assert.match(parseWorldApp(JSON.stringify(valid), MAX_APP_FILE + 1).error, /64 KB/)
})

test('protects built-in app ids from being overwritten', () => {
  for (const id of RESERVED_IDS) {
    const parsed = parseWorldApp(JSON.stringify({ ...valid, id }))
    assert.equal(parsed.ok, false, `${id} must be reserved`)
    assert.match(parsed.error, /内置应用/)
  }
})

test('only http/https urls are allowed', () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/windows', 'data:text/html,hi', 'ftp://host/x']) {
    assert.match(parseWorldApp(JSON.stringify({ ...valid, url })).error, /url|http/, url)
  }
})

test('the shipped example package is valid', async () => {
  const source = await readFile(join(root, 'app-packages/demo-prototype.worldapp'), 'utf8')
  const parsed = parseWorldApp(source, Buffer.byteLength(source))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.app.id, 'demo-prototype')
  assert.equal(new URL(parsed.app.url).port, '53317')
  assert.equal(new URL(parsed.app.url).pathname, '/')
})
