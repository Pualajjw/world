import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { alarmTime, dayKey, hhmm, lastClock, nextClock, parseClock, whenText } from '../companion-time.js'
import { conversationRow, createCompanionMemory } from '../companion-memory.js'
import { companionInstructions, createLifeLine, didSince, registerCompanionTools, summarizeCall } from '../companion-life.js'

const at = value => new Date(`2026-11-09T${value.length > 5 ? value : `${value}:00`}`)
const message = (time, role, text) => ({ id: `${role}-${time}`, time, role, text })

test('a clock is HH:MM or nothing', () => {
  assert.deepEqual(parseClock('09:00'), { hour: 9, minute: 0 })
  assert.deepEqual(parseClock(' 23:59 '), { hour: 23, minute: 59 })
  for (const value of ['24:00', '9', '09:60', '', null, 'nine']) assert.equal(parseClock(value), undefined)
})

test('the next and the last reading of a clock both land on the right side of now', () => {
  const now = at('10:00')
  assert.equal(hhmm(nextClock(now, '23:00')), '23:00')
  assert.equal(dayKey(nextClock(now, '09:00')), '2026-11-10', 'a time already past today is tomorrow')
  assert.equal(hhmm(nextClock(now, '10:00')), '10:00')
  assert.equal(dayKey(nextClock(now, '10:00')), '2026-11-10', 'strictly after, never the same instant')
  assert.equal(dayKey(lastClock(now, '23:00')), '2026-11-08')
  assert.equal(hhmm(lastClock(now, '10:00')), '10:00')
})

test('an alarm takes a full instant or a number of minutes, never the past nor next month', () => {
  const now = at('10:00')
  assert.equal(hhmm(alarmTime({ after_minutes: 30 }, now)), '10:30')
  assert.equal(hhmm(alarmTime({ at: '2026-11-09T21:30:00+08:00' }, now)), '21:30')
  assert.throws(() => alarmTime({}, now), /at/)
  assert.throws(() => alarmTime({ after_minutes: 0 }, now), /after_minutes/)
  assert.throws(() => alarmTime({ after_minutes: 60 * 24 * 8 }, now), /after_minutes/)
  assert.throws(() => alarmTime({ at: '2026-11-09T09:59:00+08:00' }, now), /一分钟/)
  assert.throws(() => alarmTime({ at: '明天' }, now), /带时区/)
})

test('a moment reads as today, tomorrow, or its date', () => {
  const now = at('10:00')
  assert.equal(whenText(at('21:30'), now), '今天 21:30')
  assert.equal(whenText(new Date('2026-11-10T09:00:00'), now), '明天 09:00')
  assert.equal(whenText(new Date('2026-11-12T09:00:00'), now), '11-12 09:00')
})

test('her own wake word is never mistaken for the user speaking', () => {
  const time = '2026-11-09T10:00:00.000Z'
  const user = conversationRow({ type: 'user/message', seq: 1, time, data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '在吗' }] } })
  const wake = conversationRow({ type: 'user/message', seq: 2, time, data: { id: 'w1', source: { kind: 'user' }, content: [{ type: 'text', text: '【我的时间】10:00 到了' }] } })
  const reply = conversationRow({ type: 'assistant/message', seq: 3, time, data: { message: { id: 'a1', content: [{ type: 'text', text: '在。' }] } } })
  assert.equal(user.role, 'user')
  assert.equal(wake.role, 'life')
  assert.equal(reply.role, 'assistant')
  assert.equal(conversationRow({ type: 'tool/call', seq: 4, time, data: {} }), undefined)
  assert.equal(conversationRow({ type: 'user/message', seq: 5, time, data: { source: { kind: 'system' }, content: [{ type: 'text', text: 'x' }] } }), undefined)
})

test('the archive keeps each word once, reads back in order, and answers a literal search with a ref', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'world-memory-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const memory = createCompanionMemory({ dir })
  const base = '2026-11-09T02:00:00.000Z'
  assert.equal(await memory.append(message(base, 'user', '把短词查询改好，改完拿五个词试一遍')), true)
  assert.equal(await memory.append(message(base, 'user', '把短词查询改好，改完拿五个词试一遍')), false, 'the same message is not remembered twice')
  await memory.append(message('2026-11-09T02:05:00.000Z', 'assistant', '好，我先看现有的查询。'))
  await memory.append(message('2026-11-09T02:10:00.000Z', 'life', '【我的时间】10:10 到了'))

  const recent = await memory.recent(2)
  assert.deepEqual(recent.map(row => row.role), ['assistant', 'life'], 'newest last')
  const text = await memory.recentText(3)
  assert.match(text, /用户：把短词查询改好/)
  assert.match(text, /我：好，我先看/)
  assert.match(text, /我的时间：/)

  const found = await memory.find({ query: '短词' })
  assert.equal(found.items.length, 1)
  assert.equal(found.items[0].kind, 'conversation')
  assert.equal(found.nextCursor, null)
  assert.match(found.items[0].ref, /^conv:2026-11-09:\d+$/)

  assert.equal((await memory.find({ query: '短词', cursor: 1 })).items.length, 0, 'the cursor skips what was already seen')
  assert.equal((await memory.find({ from: '2026-11-09T02:04:00.000Z' })).items.length, 2)
  assert.equal((await memory.find({ query: '不存在的字' })).items.length, 0)
  await assert.rejects(memory.find({ query: 'x'.repeat(300) }), /200/)
})

test('a ref pages by character and never cuts one in half', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'world-read-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const memory = createCompanionMemory({ dir })
  await memory.append(message('2026-11-09T02:00:00.000Z', 'assistant', '好的🙂我记住了这一句话'))
  const { items } = await memory.find({ query: '好的' })
  const first = await memory.read({ ref: items[0].ref, offset: 0, limit: 3 })
  assert.equal(first.text, '好的🙂')
  const second = await memory.read({ ref: items[0].ref, offset: first.nextOffset, limit: 100 })
  assert.equal(second.text, '我记住了这一句话')
  assert.equal(second.nextOffset, null)
  assert.equal(first.totalChars + 0 > 3, true)
  await assert.rejects(memory.read({ ref: 'conv:2026-11-09:99' }), /找不到/)
  await assert.rejects(memory.read({ ref: 'hand written' }), /不要手写/)
})

test('her self-description is written whole, read from cache, and kept aside before a look back', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'world-self-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const memory = createCompanionMemory({ dir })
  assert.equal(await memory.readSelf(), '')
  assert.equal(memory.selfTextSync(), '')
  await memory.writeSelf('我喜欢慢慢把事情做完。')
  assert.equal(await memory.readSelf(), '我喜欢慢慢把事情做完。')
  assert.equal(memory.selfTextSync(), '我喜欢慢慢把事情做完。')
  assert.match(await readFile(memory.selfPath(), 'utf8'), /慢慢把事情做完/)
  const copy = await memory.keepSelf('2026-11-09')
  assert.match(copy, /self\.history/)
  assert.match(await readFile(copy, 'utf8'), /慢慢把事情做完/)
  await assert.rejects(memory.writeSelf('   '), /不能为空/)
  const long = '长'.repeat(4100)
  await memory.writeSelf(long)
  assert.match(memory.selfTextSync(), /不要|长/)
  assert.equal([...memory.selfTextSync()].length, 4000)
})

test('a tool is said in words, and the alarm counts what she actually did', () => {
  assert.equal(summarizeCall('world_life', JSON.stringify({ action: 'plan', note: '改查询' })), '定了个闹钟')
  assert.equal(summarizeCall('world_desktop_action', JSON.stringify({ windowId: 'w1' })), '在桌面上动了手')
  assert.equal(summarizeCall('write', JSON.stringify({ file_path: 'C:/room/查询.md' })), '查询.md')
  assert.equal(summarizeCall('unknown_tool', JSON.stringify({ command: 'ls -la' })), 'ls -la')

  const records = [
    { time: '2026-11-09T02:00:00.000Z', tool: 'read', summary: 'a.md' },
    { time: '2026-11-09T02:10:00.000Z', tool: 'write', summary: 'b.md' },
    { time: '2026-11-09T01:00:00.000Z', tool: 'write', summary: 'before the alarm' },
  ]
  const line = didSince(records, '2026-11-09T01:30:00.000Z', new Date('2026-11-09T02:20:00.000Z'))
  assert.match(line, /动了 2 次手/)
  assert.match(line, /最后一次是：b\.md/)
  assert.equal(didSince(records, '2026-11-09T03:00:00.000Z', new Date('2026-11-09T04:00:00.000Z')), '这段时间我没动过手。')
  assert.equal(didSince(records, 'not a time', new Date()), '')
})

test('one alarm: she plans it, it comes once, and cancelling rests until morning', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'world-life-'))
  const memory = createCompanionMemory({ dir })
  const runs = []
  let clock = at('10:00')
  const timers = []
  const life = createLifeLine({
    memory, dir, now: () => clock, available: () => true,
    workbench: { run: async request => { runs.push(request); return true } },
    config: () => ({ life: true, wakeTime: '09:00', reviewTime: '23:00' }),
    setTimer: (fn, delay) => { const handle = { fn, delay, unref() {} }; timers.push(handle); return handle },
    clearTimer: handle => { if (handle) handle.cancel = true },
  })
  t.after(async () => { life.stop(); await life.settled(); await rm(dir, { recursive: true, force: true }) })
  await life.start()
  const armed = () => timers.filter(handle => !handle.cancel).at(-1)
  assert.equal(life.status().next.kind, 'review', 'the evening look back is sooner than tomorrow morning')
  assert.match(life.status().alarm.at, /T01:00:00/, 'nothing planned means nine tomorrow morning')

  assert.match(life.plan({ after_minutes: 30 }, '把短词查询改好'), /今天 10:30/)
  assert.match(life.check(), /还有 30 分钟/)
  clock = at('10:20')
  assert.match(life.check(), /还有 10 分钟/)

  clock = at('10:30:20')
  armed().fn()
  await life.settled()
  assert.equal(runs.length, 1)
  assert.equal(runs[0].kind, 'alarm')
  assert.match(runs[0].text, /【我的时间】10:30 到了/)
  assert.match(runs[0].text, /把短词查询改好/)
  assert.match(runs[0].text, /这段时间我没动过手/)

  assert.match(life.cancel(), /早上 09:00/)
  assert.match(life.cancel(), /现在没有安排/)
  await life.onTurnEnd(true)
  assert.match(life.status().alarm.at, /T01:00:00/)
})

test('a wake word that cannot enter stays pending instead of being lost', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'world-retry-'))
  const memory = createCompanionMemory({ dir })
  let accept = false
  const timers = []
  let clock = at('10:00')
  const life = createLifeLine({
    memory, dir, now: () => clock, available: () => true,
    workbench: { run: async () => accept },
    config: () => ({ life: true, wakeTime: '09:00', reviewTime: '23:00' }),
    setTimer: (fn, delay) => { const handle = { fn, delay, unref() {} }; timers.push(handle); return handle },
    clearTimer: handle => { if (handle) handle.cancel = true },
  })
  t.after(async () => { life.stop(); await life.settled(); await rm(dir, { recursive: true, force: true }) })
  await life.start()
  life.plan({ after_minutes: 1 }, '一件事')
  const armed = () => timers.filter(handle => !handle.cancel).at(-1)
  clock = new Date(at('10:00').getTime() + 90_000)
  armed().fn()
  await life.settled()
  assert.match(life.status().faults.map(item => item.message).join('\n'), /一分钟后再试/)
  assert.equal(life.status().alarm.note, '一件事', 'the alarm is still owed')
  accept = true
  armed().fn()
  await life.settled()
  assert.equal(life.status().alarm, null, 'a taken word clears the alarm; the morning fallback comes with the next turn end')
})

test('her first handoff is the only arrival; a door that stayed shut is retried, not skipped', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'world-arrive-'))
  const memory = createCompanionMemory({ dir })
  const runs = []
  let home = false
  let clock = at('10:00')
  const timers = []
  const life = createLifeLine({
    memory, dir, now: () => clock, available: () => home,
    workbench: { run: async request => { runs.push(request); return true } },
    config: () => ({ life: true, wakeTime: '09:00', reviewTime: '23:00' }),
    setTimer: (fn, delay) => { const handle = { fn, delay, unref() {} }; timers.push(handle); return handle },
    clearTimer: handle => { if (handle) handle.cancel = true },
  })
  t.after(async () => { life.stop(); await life.settled(); await rm(dir, { recursive: true, force: true }) })

  await life.start()
  assert.equal(runs.length, 0, 'no home yet: nothing is delivered')

  home = true
  await life.refresh({ handoff: true })
  await life.settled()
  assert.equal(runs.length, 1)
  assert.equal(runs[0].kind, 'greeting')
  assert.match(runs[0].text, /这是我的家/)

  // The same world opening again does not introduce her a second time.
  await life.refresh({ handoff: true })
  await life.settled()
  assert.equal(runs.length, 1)
  assert.equal(JSON.parse(await readFile(join(dir, 'life.json'), 'utf8')).arrived, true, 'she only arrives once, even across restarts')

  // She has said she is resting until morning: handing the desktop over again must not start a turn.
  life.cancel()
  await life.settled()
  await life.refresh({ handoff: true })
  await life.settled()
  await life.refresh({ handoff: true })
  await life.settled()
  assert.equal(runs.length, 1, 'a handoff is not a reason to speak')

  // Even if the same word is put back on disk (a stale write, an old backup), it is not said twice.
  const doc = JSON.parse(await readFile(join(dir, 'life.json'), 'utf8'))
  doc.greeting = { at: doc.lastDelivered.at, kind: 'arrival' }
  await writeFile(join(dir, 'life.json'), JSON.stringify(doc))
  await life.refresh({ handoff: true })
  await life.settled()
  assert.equal(runs.length, 1, 'the same instant is only said once')
})

test('handoffs that arrive together still say hello only once', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'world-burst-'))
  const memory = createCompanionMemory({ dir })
  const runs = []
  const timers = []
  const life = createLifeLine({
    memory, dir, now: () => at('10:00'), available: () => true,
    workbench: { run: async request => { runs.push(request); return true } },
    config: () => ({ life: true, wakeTime: '09:00', reviewTime: '23:00' }),
    setTimer: (fn, delay) => { const handle = { fn, delay, unref() {} }; timers.push(handle); return handle },
    clearTimer: handle => { if (handle) handle.cancel = true },
  })
  t.after(async () => { life.stop(); await life.settled(); await rm(dir, { recursive: true, force: true }) })
  await life.start()
  await Promise.all([life.refresh({ handoff: true }), life.refresh({ handoff: true }), life.refresh({ handoff: true })])
  await life.settled()
  assert.equal(runs.length, 1)
})

test('a hello that could not be said in time is dropped instead of waiting for the next handoff', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'world-stale-'))
  const memory = createCompanionMemory({ dir })
  const runs = []
  const timers = []
  let clock = at('10:00')
  let accept = false
  const life = createLifeLine({
    memory, dir, now: () => clock, available: () => true,
    workbench: { run: async request => { if (!accept) return false; runs.push(request); return true } },
    config: () => ({ life: true, wakeTime: '09:00', reviewTime: '23:00' }),
    setTimer: (fn, delay) => { const handle = { fn, delay, unref() {} }; timers.push(handle); return handle },
    clearTimer: handle => { if (handle) handle.cancel = true },
  })
  t.after(async () => { life.stop(); await life.settled(); await rm(dir, { recursive: true, force: true }) })
  const armed = () => timers.filter(handle => !handle.cancel).at(-1)
  await life.start()
  await life.refresh({ handoff: true })         // the door opens, but her session is busy
  await life.settled()
  assert.match(life.status().faults.map(item => item.message).join('\n'), /一分钟后再试/)

  clock = new Date(at('10:00').getTime() + 60 * 60_000)
  accept = true
  armed().fn()                                   // the retry, an hour late
  await life.settled()
  assert.equal(runs.length, 0, 'a hello an hour late is not worth saying')
  assert.notEqual(life.status().next?.kind, 'greeting', 'the clock moves on instead')
})

test('her tools answer with an object, because the host rejects anything else', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'world-tools-'))
  const memory = createCompanionMemory({ dir })
  const entries = new Map()
  const ctx = {
    inject: (_deps, callback) => callback({
      effect: fn => fn(),
      tools: { register(entry) { entries.set(entry.name, entry); return () => {} } },
    }),
  }
  registerCompanionTools(ctx, {
    lifeOf: () => ({ plan: () => '好，做到今天 21:30。', check: () => '现在没有安排，早上 09:00 会叫我。', cancel: () => '不做了。' }),
    memory, brain: { get: async () => ({ sessionId: 'fixed' }) },
  })
  assert.deepEqual([...entries.keys()], ['world_life', 'world_memory', 'world_self'])
  const exec = { agent: { session: { id: 'fixed' } } }
  for (const [name, entry] of entries) {
    assert.equal(entry.output.schema.type, 'object', `${name} declares an object`)
    const args = name === 'world_life' ? { action: 'check' } : name === 'world_memory' ? { action: 'find', query: '你好' } : { action: 'read' }
    const value = await entry.execute(args, exec)
    assert.equal(typeof value, 'object', `${name} returns an object`)
    assert.ok(value !== null && !Array.isArray(value), `${name} returns a plain object`)
    const blocks = entry.output.render(args, value)
    assert.equal(blocks[0].type, 'text')
    assert.ok(blocks[0].text.length > 0, `${name} renders something`)
  }
  assert.deepEqual(entries.get('world_life').output.schema.required, ['message'], 'the sentence is where the reader expects it')
})

test('her world is written in the first person and carries what you wrote plus what she wrote', () => {
  const text = companionInstructions({ profile: { name: '小鱼', userName: '阿林', background: '住在 world 里。', tone: 'natural' }, self: '我喜欢慢慢做事。', life: '现在没有安排，早上 09:00 会叫我。' })
  assert.match(text, /我不是一个助手，也不是一个工具/)
  assert.match(text, /住在 world 里/)
  assert.match(text, /我喜欢慢慢做事/)
  assert.match(text, /阿林的任务优先/)
  assert.match(text, /大事先问/)
  assert.match(text, /早上 09:00/)
  assert.match(text, /world_life plan/)
  const empty = companionInstructions({ profile: { background: '背景' } })
  assert.match(empty, /我还没写下自己/)
  assert.doesNotMatch(empty, /现在/)
})
