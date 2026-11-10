import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createModelFriends, renderAssembly, sessionIdOf, assistantText } from '../model-friends.js'
import { createLanChatServer, findMentions, mentionPrompt, parseMentions } from '../lan-chat/server.mjs'
import { registerLanChatTools } from '../lan-chat-tool.js'

const HOME = () => mkdtemp(join(tmpdir(), 'dsh-world-test-'))

/** 假 dsh 宿主：llm 目录 + sessionController + 事件总线，够桥接跑完一整轮。 */
function fakeHost(options = {}) {
  const handlers = Object.create(null)
  const created = []
  const selected = []
  const renamed = []
  const prompts = []
  const cancelled = []
  const inspectCalls = []
  const known = new Set(options.sessions || [])
  let respond = options.respond || defaultRespond

  function emit(name, ...args) {
    for (const fn of handlers[name] || []) fn(...args)
  }

  function defaultRespond(request) {
    const session = { header: { id: request.sessionId } }
    emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
    emit('session/event', session, { type: 'assistant/message', data: { turn: 1,
      message: { content: [{ type: 'text', text: '好的' }] } } })
    emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  }

  const controller = {
    async create(request) {
      const sessionId = 'sess-' + (created.length + 1)
      created.push({ ...request, sessionId })
      known.add(sessionId)
      return { sessionId }
    },
    async selectModel(request) { selected.push(request); return { selected: request } },
    async rename(request) { renamed.push(request); return { sessionId: request.sessionId, title: request.title } },
    async list() { return { items: [...known].map(id => ({ sessionId: id, updatedAt: 1, running: false, blank: false })) } },
    async inspect(id) {
      inspectCalls.push(id)
      if (!known.has(id)) throw new Error('session not found')
      return {}
    },
    async prompt(request) {
      prompts.push(request)
      setImmediate(() => respond(request, { emit }))
      return { accepted: true }
    },
    cancel(request) { cancelled.push(request) },
  }

  const ctx = {
    get(name) {
      if (name === 'llm') return options.llm
      if (name === 'sessionController') return controller
      if (name === 'tools') return options.tools
      return undefined
    },
    on(name, fn) {
      (handlers[name] || (handlers[name] = [])).push(fn)
      return () => {
        const list = handlers[name] || []
        const index = list.indexOf(fn)
        if (index >= 0) list.splice(index, 1)
      }
    },
    effect(fn) { return fn() },
  }

  return {
    ctx, emit, created, selected, renamed, prompts, cancelled, inspectCalls,
    setRespond(fn) { respond = fn },
    handlerCount(name) { return (handlers[name] || []).length },
  }
}

async function json(base, path, body) {
  const response = await fetch(base + path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return response.json()
}
async function waitFor(read, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('等待模型好友回复超时')
}

test('renderAssembly keeps literal sections and drops unresolved templates', () => {
  const text = renderAssembly({
    variables: { workspace: 'E:/demo' },
    sections: [
      { name: 'identity', text: '你是 dsh 助手', interpolate: false },
      { name: 'resolved', text: '工作区 {{workspace}}' },
      { name: 'missing', text: '缺失 {{unknown}}' },
      { name: 'empty', text: '' },
    ],
  })
  assert.equal(text, '你是 dsh 助手\n\n工作区 E:/demo')
})

test('session ids and assistant text are read from every host shape', () => {
  assert.equal(sessionIdOf({ header: { id: 'a' } }), 'a')
  assert.equal(sessionIdOf({ id: 'b' }), 'b')
  assert.equal(sessionIdOf({ session: { id: 'c' } }), 'c')
  assert.equal(sessionIdOf(null), '')
  assert.equal(assistantText({ content: [{ type: 'text', text: '你好' }, { type: 'tool-call' }] }), '你好')
  assert.equal(assistantText({ content: 'plain' }), 'plain')
  assert.equal(assistantText(null), '')
})

test('every configured model becomes one de-duplicated local friend', async () => {
  const llm = {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'failover', name: 'Failover' }],
    listModels: async provider => provider === 'deepseek-official'
      ? [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' }, { id: 'deepseek-v4.1-flash', name: '重复' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: '更强的模型' }]
      : [{ id: 'deepseek-v4-pro', name: '另一个路由' }],
  }
  const friends = createModelFriends(fakeHost({ llm }).ctx, { home: await HOME() })
  const list = await friends.list()
  assert.equal(list.length, 3)
  assert.equal(list[0].id, 'bot:deepseek-official/deepseek-v4.1-flash')
  assert.equal(list[0].name, 'DeepSeek-V4.1-Flash')
  assert.equal(list[1].providerName, 'DeepSeek')
  assert.equal(list[2].provider, 'failover')
  assert.equal(list[2].description, '')
})

test('ask() prompts the bound dsh session and returns the assistant text', async () => {
  const host = fakeHost()
  const friends = createModelFriends(host.ctx, { home: await HOME(), timeoutMs: 2000 })
  const answer = await friends.ask({ sessionId: 'sess-9', text: '帮我改一版文案' })
  assert.equal(answer, '好的')
  assert.equal(host.prompts.length, 1)
  assert.equal(host.prompts[0].sessionId, 'sess-9')
  assert.equal(host.prompts[0].mode, 'queue')
  assert.deepEqual(host.prompts[0].content, [{ type: 'text', text: '帮我改一版文案' }])
  assert.match(host.prompts[0].requestId, /^lan-chat-/)
  assert.equal(host.handlerCount('session/event'), 1)   // 只订阅一次
})

test('ask() ignores the previous turn and only settles on its own turn/end', async () => {
  const host = fakeHost()
  host.setRespond((request, { emit }) => {
    const session = { header: { id: request.sessionId } }
    emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    emit('session/event', session, { type: 'turn/start', data: { turn: 2 } })
    emit('session/event', session, { type: 'assistant/message', data: { turn: 1,
      message: { content: [{ type: 'text', text: '上一轮的话' }] } } })
    emit('session/event', session, { type: 'assistant/message', data: { turn: 2,
      message: { content: [{ type: 'text', text: '这一轮的话' }] } } })
    emit('session/event', session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  })
  const friends = createModelFriends(host.ctx, { home: await HOME(), timeoutMs: 2000 })
  assert.equal(await friends.ask({ sessionId: 'sess-1', text: '继续' }), '这一轮的话')
})

test('ask() surfaces turn failures and empty replies as readable errors', async () => {
  const host = fakeHost()
  host.setRespond((request, { emit }) => {
    const session = { header: { id: request.sessionId } }
    emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
    emit('session/event', session, { type: 'turn/end', data: { turn: 1,
      reason: { kind: 'error', error: { message: '配额不足', status: 402 } } } })
  })
  const friends = createModelFriends(host.ctx, { home: await HOME(), timeoutMs: 2000, attempts: 3, backoffMs: 1 })
  await assert.rejects(() => friends.ask({ sessionId: 's', text: '干活' }),
    error => { assert.match(error.message, /配额不足/); assert.equal(error.attempts, 1); return true })
  assert.equal(host.prompts.length, 1)   // 契约类错误不重试

  const empty = fakeHost()
  empty.setRespond((request, { emit }) => {
    const session = { header: { id: request.sessionId } }
    emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
    emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  })
  const emptyFriends = createModelFriends(empty.ctx, { home: await HOME(), timeoutMs: 2000, attempts: 1 })
  await assert.rejects(() => emptyFriends.ask({ sessionId: 's', text: '干活' }), /没有返回文本内容/)
})

test('transient turn failures are retried once and reported to the caller', async () => {
  const host = fakeHost()
  let calls = 0
  host.setRespond((request, { emit }) => {
    calls += 1
    const session = { header: { id: request.sessionId } }
    emit('session/event', session, { type: 'turn/start', data: { turn: calls } })
    if (calls === 1) {
      emit('session/event', session, { type: 'turn/end', data: { turn: 1,
        reason: { kind: 'error', error: { message: 'fetch failed', code: 'ECONNRESET' } } } })
      return
    }
    emit('session/event', session, { type: 'assistant/message', data: { turn: 2,
      message: { content: [{ type: 'text', text: '第二次成功' }] } } })
    emit('session/event', session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  })
  const retries = []
  const friends = createModelFriends(host.ctx, { home: await HOME(), timeoutMs: 2000, attempts: 2, backoffMs: 2 })
  const answer = await friends.ask({ sessionId: 's', text: '干活', onRetry: info => retries.push(info) })
  assert.equal(answer, '第二次成功')
  assert.equal(host.prompts.length, 2)
  assert.equal(retries.length, 1)
  assert.equal(retries[0].attempt, 2)
})

test('ask() cancels the turn and fails when the budget runs out', async () => {
  const host = fakeHost()
  host.setRespond(() => {})   // 永远不结束
  const friends = createModelFriends(host.ctx, { home: await HOME(), timeoutMs: 80, attempts: 1 })
  await assert.rejects(() => friends.ask({ sessionId: 's', text: '干活' }), /超时/)
  assert.equal(host.cancelled.length, 1)
  assert.equal(host.cancelled[0].sessionId, 's')
})

test('createSession() makes a real dsh session, picks the model and titles it', async () => {
  const host = fakeHost()
  const home = await HOME()
  const friends = createModelFriends(host.ctx, { home, timeoutMs: 1000 })
  const sessionId = await friends.createSession({ provider: 'p', model: 'm', title: '局域网聊天 · 小明' })
  assert.equal(sessionId, 'sess-1')
  assert.equal(host.created[0].cwd, join(home, 'lan-chat', 'workspace'))
  assert.deepEqual(host.selected[0], { sessionId: 'sess-1', provider: 'p', model: 'm' })
  assert.equal(host.renamed[0].title, '局域网聊天 · 小明')
  assert.equal(await friends.hasSession('sess-1'), true)
  assert.equal(await friends.hasSession('nope'), false)
  assert.deepEqual((await friends.listSessions()).map(row => row.id), ['sess-1'])
})

test('@ parsing prefers the longest alias and strips mentions from the prompt', () => {
  const bots = [
    { id: 'bot:p/DeepSeek-V4-Pro', provider: 'p', model: 'DeepSeek-V4-Pro', name: 'DeepSeek-V4-Pro' },
    { id: 'bot:p/Flash', provider: 'p', model: 'Flash', name: '闪电' },
  ]
  const text = '@DeepSeek-V4-Pro @闪电 把这段缩成三条'
  const hits = findMentions(text, bots)
  assert.equal(hits.length, 2)
  assert.equal(hits[0].bot.id, bots[0].id)
  assert.deepEqual(parseMentions(text, bots).map(bot => bot.id), [bots[0].id, bots[1].id])
  assert.equal(mentionPrompt(text, bots), '把这段缩成三条')
  assert.deepEqual(parseMentions('普通聊天，没有提到模型', bots), [])
})

/** 假桥接：服务端只认这些方法，不需要真的 dsh。 */
function fakeModels(overrides = {}) {
  const calls = []
  const bot = { id: 'bot:p/DeepSeek-V4-Pro', provider: 'p', model: 'DeepSeek-V4-Pro', name: 'DeepSeek-V4-Pro', providerName: 'P' }
  return {
    calls,
    list: async () => [bot, { id: 'bot:p/Flash', provider: 'p', model: 'Flash', name: '闪电', providerName: 'P' }],
    createSession: async options => { calls.push({ kind: 'create', ...options }); return 'sess-A' },
    hasSession: async id => id === 'sess-A',
    listSessions: async () => [{ id: 'sess-A', updatedAt: 1, running: false, blank: false }],
    ask: async args => {
      calls.push({ kind: 'ask', ...args })
      await new Promise(resolve => setTimeout(resolve, 20))
      if (String(args.text).includes('失败')) {
        args.onRetry?.({ attempt: 2, attempts: 2, delayMs: 5, error: new Error('模拟上游不可用') })
        const error = new Error('模拟上游不可用')
        error.attempts = 2
        throw error
      }
      return '三条要点：一、二、三'
    },
    ...overrides,
  }
}

test('chat service binds a model to a real dsh session and saves the transcript separately', async () => {
  const home = await HOME()
  const models = fakeModels()
  const port = 54000 + Math.floor(Math.random() * 800)
  const service = createLanChatServer({ port, discoveryPort: port + 1000, models, home })
  try {
    const info = await service.start()
    assert.equal(info.bots, 2)
    const base = 'http://127.0.0.1:' + info.port

    const state = await json(base, '/api/state')
    assert.equal(state.bots.length, 2)
    assert.equal(state.bots[0].sessionId, '')   // 还没绑，懒创建

    const created = await json(base, '/api/conversations', { kind: 'direct', peerId: 'bot:p/DeepSeek-V4-Pro' })
    assert.equal(created.id, 'd-bot:p/DeepSeek-V4-Pro')
    assert.equal(created.state.bots[0].sessionId, '')   // 私聊窗口不预先建 dsh 会话

    const sent = await json(base, '/api/send', { conversationId: created.id, text: '@DeepSeek-V4-Pro 把这段缩成三条' })
    assert.equal(sent.ok, true)
    const answered = await waitFor(async () => {
      const current = await json(base, '/api/state')
      return current.messages[created.id]?.some(message => message.from === 'bot:p/DeepSeek-V4-Pro') ? current : null
    })
    const reply = answered.messages[created.id].find(message => message.from === 'bot:p/DeepSeek-V4-Pro')
    assert.equal(reply.fromName, 'DeepSeek-V4-Pro')
    assert.match(reply.text, /三条要点/)
    assert.equal(answered.pending[created.id], undefined)
    assert.equal(answered.bots[0].sessionId, 'sess-A')   // 第一次派活时懒创建并记住

    assert.deepEqual(models.calls[0], { kind: 'create', provider: 'p', model: 'DeepSeek-V4-Pro', title: '局域网聊天 · DeepSeek-V4-Pro' })

    const ask = models.calls.find(call => call.kind === 'ask')
    assert.equal(ask.sessionId, 'sess-A')
    assert.match(ask.text, /把这段缩成三条/)
    assert.match(ask.text, /局域网聊天/)      // 只是场景说明，真正的上下文在 dsh 会话里
    assert.equal(ask.history, undefined)      // 不再自己拼多轮

    // 私聊里显式 @ 另一个模型：只有被 @ 的那个回答，并且各自绑到自己的会话
    await json(base, '/api/send', { conversationId: created.id, text: '@闪电 只叫你' })
    await waitFor(async () => {
      const current = await json(base, '/api/state')
      return current.messages[created.id]?.some(message => message.from === 'bot:p/Flash') ? current : null
    })
    const askFlash = models.calls.filter(call => call.kind === 'ask').pop()
    assert.match(askFlash.text, /只叫你/)

    await json(base, '/api/send', { conversationId: created.id, text: '这次会失败' })
    const failed = await waitFor(async () => {
      const current = await json(base, '/api/state')
      return current.messages[created.id]?.some(message => message.kind === 'system'
        && message.text.includes('仍失败')) ? current : null
    })
    const failure = failed.messages[created.id].find(message => message.kind === 'system' && message.text.includes('仍失败'))
    assert.match(failure.text, /重试 2 次仍失败/)
    assert.match(failure.text, /模拟上游不可用/)
    assert.equal(failed.retrying[created.id], undefined)

    // 聊天记录另外保存：不依赖 dsh 会话（写盘有防抖，等它落下来）
    const stateFile = join(home, 'lan-chat', 'state.json')
    const saved = await waitFor(async () => {
      try { return JSON.parse(await readFile(stateFile, 'utf8')) } catch { return null }
    })
    assert.equal(saved.bindings['bot:p/DeepSeek-V4-Pro'], 'sess-A')
    assert.ok(saved.messages[created.id].some(message => message.text.includes('三条要点')))
  } finally {
    await service.stop()
  }
})

test('chat transcript, conversations and bindings survive a restart', async () => {
  const home = await HOME()
  const port = 54600 + Math.floor(Math.random() * 400)
  let service = createLanChatServer({ port, discoveryPort: port + 1000, models: fakeModels(), home })
  let base
  try {
    const info = await service.start()
    base = 'http://127.0.0.1:' + info.port
    const created = await json(base, '/api/conversations', { kind: 'direct', peerId: 'bot:p/DeepSeek-V4-Pro' })
    await json(base, '/api/send', { conversationId: created.id, text: '记住这句话：蓝色鲸鱼' })
    await waitFor(async () => {
      const current = await json(base, '/api/state')
      return current.messages[created.id]?.some(message => message.from.startsWith('bot:')) ? current : null
    })
  } finally {
    await service.stop()
  }

  service = createLanChatServer({ port, discoveryPort: port + 1000, models: fakeModels(), home })
  try {
    const info = await service.start()
    const state = await json('http://127.0.0.1:' + info.port, '/api/state')
    const conv = state.conversations.find(row => row.id === 'd-bot:p/DeepSeek-V4-Pro')
    assert.ok(conv, '聊天会话应当恢复')
    assert.ok(state.messages[conv.id].some(message => message.text.includes('蓝色鲸鱼')), '聊天记录应当恢复')
    assert.equal(state.bindings['bot:p/DeepSeek-V4-Pro'], 'sess-A', '绑定关系应当恢复')
  } finally {
    await service.stop()
  }
})

test('chat history query works across conversations for dsh sessions', async () => {
  const home = await HOME()
  const service = createLanChatServer({ port: 55100 + Math.floor(Math.random() * 400),
    discoveryPort: 55500, models: fakeModels(), home })
  try {
    const info = await service.start()
    const base = 'http://127.0.0.1:' + info.port
    await json(base, '/api/send', { conversationId: 'g-lan-lobby', text: '明天十点对一下蓝色鲸鱼' })
    const created = await json(base, '/api/conversations', { kind: 'direct', peerId: 'bot:p/Flash' })
    await json(base, '/api/send', { conversationId: created.id, text: '另一句毫不相干的话' })

    const conversations = service.listConversations()
    assert.ok(conversations.some(row => row.id === 'g-lan-lobby' && row.messages >= 1))
    assert.ok(conversations.some(row => row.id === created.id))

    const hits = service.searchMessages({ query: '蓝色鲸鱼' })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].conversationId, 'g-lan-lobby')
    assert.equal(hits[0].fromName.length > 0, true)

    const scoped = service.searchMessages({ conversationId: created.id })
    assert.ok(scoped.every(row => row.conversationId === created.id))
    assert.equal(service.searchMessages({ query: '不存在的词' }).length, 0)
    assert.equal(service.searchMessages({ query: '蓝色鲸鱼', until: 1 }).length, 0)
  } finally {
    await service.stop()
  }
})

test('model friends are opt-in group members and remote @ follows the group setting', async () => {
  const home = await HOME()
  const models = fakeModels()
  const port = 55200 + Math.floor(Math.random() * 300)
  const service = createLanChatServer({ port, discoveryPort: port + 1000, models, home })
  try {
    const info = await service.start()
    const base = 'http://127.0.0.1:' + info.port
    const initial = await json(base, '/api/state')
    const lobby = initial.conversations.find(row => row.id === 'g-lan-lobby')
    assert.equal(lobby.memberIds.some(id => id.startsWith('bot:')), false, 'lobby must not auto-add model friends')
    assert.deepEqual(lobby.botMembers, [])
    assert.equal((await json(base, '/api/group/settings', { conversationId: lobby.id, botIds: ['bot:p/DeepSeek-V4-Pro'] })).error,
      '局域网大厅不支持邀请模型或修改 @ 权限')

    await json(base, '/api/send', { conversationId: lobby.id, text: '@DeepSeek-V4-Pro 大厅里不应自动触发' })
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(models.calls.filter(call => call.kind === 'ask').length, 0, 'uninvited model must ignore group mentions')

    const created = await json(base, '/api/conversations', {
      kind: 'group', name: '模型协作群', botIds: ['bot:p/DeepSeek-V4-Pro'], allowOthersMention: false,
    })
    const conv = created.state.conversations.find(row => row.id === created.id)
    assert.deepEqual(conv.botMembers.map(bot => bot.id), ['bot:p/DeepSeek-V4-Pro'])
    assert.equal(conv.allowOthersMention, false)
    assert.equal(conv.botMembers[0].ownerId, created.state.me.id)

    await json(base, '/api/send', { conversationId: conv.id, text: '@DeepSeek-V4-Pro 本机用户可以派活' })
    await waitFor(async () => {
      const current = await json(base, '/api/state')
      return current.messages[conv.id]?.some(message => message.from === 'bot:p/DeepSeek-V4-Pro')
    })
    const asksBeforeRemote = models.calls.filter(call => call.kind === 'ask').length

    const receive = text => json(base, '/api/receive', {
      type: 'message', from: { id: 'peer-remote:53317', nickname: '远端成员' },
      conversation: conv,
      message: { id: 'remote-' + Math.random().toString(36).slice(2), conversationId: conv.id, text, at: Date.now(), kind: 'text' },
    })
    await receive('@DeepSeek-V4-Pro 权限关闭时不应触发')
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(models.calls.filter(call => call.kind === 'ask').length, asksBeforeRemote,
      'remote member mention must respect the default-deny setting')

    await json(base, '/api/group/settings', { conversationId: conv.id, botIds: [], allowOthersMention: true })
    const settingEnabled = await json(base, '/api/state')
    assert.equal(settingEnabled.conversations.find(row => row.id === conv.id).allowOthersMention, true)
    await receive('@DeepSeek-V4-Pro 现在可以响应群成员')
    await waitFor(async () => {
      const current = await json(base, '/api/state')
      return current.messages[conv.id]?.filter(message => message.from === 'bot:p/DeepSeek-V4-Pro').length >= 2
    })
    assert.equal(models.calls.filter(call => call.kind === 'ask').length, asksBeforeRemote + 1)
  } finally {
    await service.stop()
  }
})

test('group model invitations and @ permissions sync across LAN peers and only the owner host runs the model', async () => {
  const homeA = await HOME(), homeB = await HOME()
  const portA = 56600 + Math.floor(Math.random() * 100)
  const portB = portA + 200
  const modelsA = fakeModels(), modelsB = fakeModels()
  const serviceA = createLanChatServer({ port: portA, discoveryPort: portA + 700, models: modelsA, home: homeA })
  const serviceB = createLanChatServer({ port: portB, discoveryPort: portB + 700, models: modelsB, home: homeB })
  try {
    const infoA = await serviceA.start(), infoB = await serviceB.start()
    const baseA = 'http://127.0.0.1:' + infoA.port, baseB = 'http://127.0.0.1:' + infoB.port
    const meA = await json(baseA, '/api/ping'), meB = await json(baseB, '/api/ping')
    const presence = (id, name, machine, port, world) => ({
      proto: 'dsh-world-lan-chat/1', type: 'presence', id, name, machine, port, world, worldInstalled: true,
    })
    await json(baseA, '/api/presence', presence(meB.id, meB.nickname, meB.machine, infoB.port, meB.world))
    await json(baseB, '/api/presence', presence(meA.id, meA.nickname, meA.machine, infoA.port, meA.world))

    const created = await json(baseA, '/api/conversations', {
      kind: 'group', name: '跨设备模型群', memberIds: [meB.id], botIds: ['bot:p/DeepSeek-V4-Pro'], allowOthersMention: false,
    })
    const remoteConv = await waitFor(async () => {
      const state = await json(baseB, '/api/state')
      return state.conversations.find(row => row.id === created.id && row.botMembers?.length) || null
    })
    assert.equal(remoteConv.allowOthersMention, false)
    assert.equal((await json(baseB, '/api/group/settings', {
      conversationId: created.id, botIds: [], allowOthersMention: true,
    })).error, '只有建群者可以修改群设置')

    await json(baseB, '/api/send', { conversationId: created.id, text: '@DeepSeek-V4-Pro 暂不允许其他成员调用' })
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(modelsA.calls.filter(call => call.kind === 'ask').length, 0)
    assert.equal(modelsB.calls.filter(call => call.kind === 'ask').length, 0)

    await json(baseA, '/api/group/settings', { conversationId: created.id, botIds: [], allowOthersMention: true })
    await waitFor(async () => {
      const state = await json(baseB, '/api/state')
      return state.conversations.find(row => row.id === created.id)?.allowOthersMention === true
    })
    await json(baseB, '/api/send', { conversationId: created.id, text: '@DeepSeek-V4-Pro 现在由模型所属设备处理' })
    const answered = await waitFor(async () => {
      const state = await json(baseA, '/api/state')
      return state.messages[created.id]?.some(message => message.from === 'bot:p/DeepSeek-V4-Pro') ? state : null
    })
    assert.ok(answered.messages[created.id].some(message => message.from === 'bot:p/DeepSeek-V4-Pro'))
    assert.equal(modelsA.calls.filter(call => call.kind === 'ask').length, 1)
    assert.ok(modelsA.calls.filter(call => call.kind === 'ask')[0].text.includes('发言人：' + meB.nickname))
    assert.equal(modelsB.calls.filter(call => call.kind === 'ask').length, 0, 'another host with the same model id must not run it')
  } finally {
    await serviceA.stop()
    await serviceB.stop()
  }
})

test('lan chat tools list conversations and search history read-only', async () => {
  const registered = []
  const tools = { register(definition) { registered.push(definition); return () => {} } }
  const host = fakeHost({ tools })
  const chat = {
    listConversations: () => [{ id: 'g-lan-lobby', name: '局域网大厅', kind: 'group', members: 2,
      messages: 3, updatedAt: 1000, bot: false, ownerBotId: '' }],
    searchMessages: options => (options.query === '没这个词' ? [] : [{ conversationId: 'g-lan-lobby',
      conversation: '局域网大厅', kind: 'group', id: 'm1', from: 'me', fromName: '我',
      at: 1000, text: '蓝色鲸鱼在吗', system: false, options }]),
  }
  registerLanChatTools(host.ctx, { chat: () => chat })
  assert.equal(registered.length, 2)
  assert.deepEqual(registered.map(tool => tool.name), ['lan_chat_conversations', 'lan_chat_history'])
  for (const tool of registered) {
    assert.ok(tool.output?.schema, tool.name + ' 必须声明 output.schema')
    assert.equal(typeof tool.output.render, 'function', tool.name + ' 必须声明 output.render')
  }

  const list = await registered[0].execute({}, {})
  assert.equal(list.total, 1)
  assert.match(list.text, /局域网大厅/)
  const history = await registered[1].execute({ query: '蓝色鲸鱼', limit: 5 }, {})
  assert.equal(history.total, 1)
  assert.match(history.text, /蓝色鲸鱼在吗/)
  assert.equal(history.rows[0].options.limit, 5)
  const empty = await registered[1].execute({ query: '没这个词' }, {})
  assert.equal(empty.total, 0)
})

test('standalone mode without a host has no model friends and never invokes anything', async () => {
  const home = await HOME()
  const port = 55600 + Math.floor(Math.random() * 300)
  const service = createLanChatServer({ port, discoveryPort: port + 1000, home })
  try {
    const info = await service.start()
    assert.equal(info.bots, 0)
    const base = 'http://127.0.0.1:' + info.port
    const state = await json(base, '/api/state')
    assert.deepEqual(state.bots, [])
    const sent = await json(base, '/api/send', { conversationId: 'g-lan-lobby', text: '@任意模型 干活' })
    assert.equal(sent.ok, true)
    const current = await json(base, '/api/state')
    assert.equal(current.messages['g-lan-lobby'].filter(message => message.kind === 'text').length, 1)
  } finally {
    await service.stop()
  }
})

test('retry status reaches the UI snapshot only while the model is being retried', async () => {
  const home = await HOME()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const models = fakeModels({
    ask: async args => {
      args.onRetry?.({ attempt: 2, attempts: 2, delayMs: 5, error: new Error('502 Bad Gateway') })
      await gate
      return '重试后成功'
    },
  })
  const port = 56000 + Math.floor(Math.random() * 400)
  const service = createLanChatServer({ port, discoveryPort: port + 1000, models, home })
  try {
    const info = await service.start()
    const base = 'http://127.0.0.1:' + info.port
    const created = await json(base, '/api/conversations', { kind: 'direct', peerId: 'bot:p/DeepSeek-V4-Pro' })
    await json(base, '/api/send', { conversationId: created.id, text: '继续' })
    const during = await waitFor(async () => {
      const current = await json(base, '/api/state')
      const list = current.retrying[created.id] || []
      return list.length ? list : null
    })
    assert.deepEqual(during[0], { name: 'DeepSeek-V4-Pro', attempt: 2, attempts: 2 })

    release()
    const done = await waitFor(async () => {
      const current = await json(base, '/api/state')
      return current.messages[created.id]?.some(message => message.text.includes('重试后成功')) ? current : null
    })
    assert.equal(done.retrying[created.id], undefined)
    assert.equal(done.pending[created.id], undefined)
  } finally {
    release()
    await service.stop()
  }
})
