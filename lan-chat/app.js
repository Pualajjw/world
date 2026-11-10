/* 局域网聊天 · LAN Chat — 一份 UI，两种后端：demo（纯本地可点原型）/ live（server.mjs） */
(function () {
  'use strict'

  // Iframe input does not bubble into the desktop; relay only the fact of a real human input.
  if (window.parent !== window) {
    var reportInput = function (event) {
      if (event.isTrusted) window.parent.postMessage({ type: 'world-human-input' }, '*')
    }
    for (var inputType of ['pointerdown', 'wheel', 'keydown'])
      document.addEventListener(inputType, reportInput, { capture: true, passive: true })
  }

  var params = new URLSearchParams(location.search)
  var DEMO = Boolean(window.LAN_CHAT_DEMO) || location.protocol === 'file:' || params.has('demo')
  document.body.classList.add(DEMO ? 'lc-demo' : 'lc-live')

  var $ = function (id) { return document.getElementById(id) }
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  var esc = function (value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ESC[c] }) }

  /* ---------------------------- Markdown 与渲染缓存 ---------------------------- */
  // markdown.js 提供 mdToHtml（先转义再拼标签）；缺失时自动退化成纯文本，界面不至于空白
  var MD = window.LanChatMarkdown || null
  var MD_CACHE = new Map()          // 消息 id -> HTML，避免每次状态推送都重新解析
  var MD_CACHE_MAX = 600
  var MD_MAX_CHARS = 8000           // 超长内容不值得解析，按纯文本显示
  var MENTION_RE = /(@[\w\u4e00-\u9fa5.:\/-]+)/g

  function markdownHtml(key, text) {
    var source = String(text == null ? '' : text)
    var cacheKey = key + '\u0001' + source.length
    var cached = MD_CACHE.get(cacheKey)
    if (cached !== undefined) return cached
    var html
    if (MD && source.length <= MD_MAX_CHARS) html = MD.mdToHtml(source)
    else html = esc(source).replace(/\n/g, '<br>')
    if (MD_CACHE.size >= MD_CACHE_MAX) MD_CACHE.delete(MD_CACHE.keys().next().value)
    MD_CACHE.set(cacheKey, html)
    return html
  }
  /** 侧栏预览：去掉 Markdown 标记与代码块，只留一行可读文本。 */
  function previewText(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, ' [代码] ')
      .replace(/`([^`\n]*)`/g, '$1')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/[*_~>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }
  var TONES = ['blue', 'purple', 'orange', 'pink', 'green', 'cyan']
  function toneOf(seed) {
    var n = 0, s = String(seed || '')
    for (var i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) % 997
    return TONES[n % TONES.length]
  }
  function clock(ts) {
    var d = new Date(ts || Date.now())
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  }
  function shortTime(ts) {
    if (!ts) return ''
    var d = new Date(ts), now = new Date()
    if (d.toDateString() === now.toDateString()) return clock(ts)
    return (d.getMonth() + 1) + '/' + d.getDate()
  }
  function avatarHtml(label, tone, size, presence) {
    return '<span class="lc-avatar tone-' + (tone || 'blue') + (size ? ' ' + size : '') + '">' + esc(label) +
      (presence === undefined ? '' : '<i class="lc-presence' + (presence ? '' : ' off') + '"></i>') + '</span>'
  }

  /* 模型好友：@ 时可用显示名 / 模型 id / bot id / provider\/model 四种写法 */
  function botAliases(bot) {
    return [bot.name, bot.model, bot.id, bot.provider && bot.model ? bot.provider + '/' + bot.model : '']
      .filter(Boolean).map(String)
  }
  function mentionedBots(text, list) {
    var lower = String(text || '').toLowerCase(), out = []
    for (var bot of list || []) {
      for (var alias of botAliases(bot)) {
        if (lower.indexOf('@' + alias.toLowerCase()) >= 0) { out.push(bot); break }
      }
    }
    return out
  }

  /* ------------------------------ demo 后端 ------------------------------ */
  function demoState() {
    var now = Date.now(), m = 60000
    var me = { id: 'me-local', nickname: '林间风', name: '林间风', machine: 'DESKTOP-LIN', ip: '192.168.1.24', world: '@local/dsh-world 0.2.4', port: 53317 }
    var peers = [
      { id: 'peer-zhe', name: '阿哲', machine: 'DESKTOP-ZHE', ip: '192.168.1.31', world: '@local/dsh-world 0.2.4', online: true },
      { id: 'peer-man', name: '小满', machine: 'LAPTOP-MAN', ip: '192.168.1.42', world: '@local/dsh-world 0.2.3', online: true },
      { id: 'peer-zhou', name: '老周', machine: 'PC-ZHOU', ip: '192.168.1.58', world: '@local/dsh-world 0.2.4', online: true },
      { id: 'peer-test', name: '测试机', machine: 'WIN-TEST', ip: '192.168.1.77', world: '@local/dsh-world 0.2.1', online: false }
    ]
    var bots = [
      { id: 'bot:demo/DeepSeek-V4.1-Flash', provider: 'demo', model: 'DeepSeek-V4.1-Flash', providerName: '演示',
        name: 'DeepSeek-V4.1-Flash', machine: '本机模型', ip: '127.0.0.1', world: '本机', online: true, bot: true,
        sessionId: 'sess-demo-flash' },
      { id: 'bot:demo/DeepSeek-V4-Pro', provider: 'demo', model: 'DeepSeek-V4-Pro', providerName: '演示',
        name: 'DeepSeek-V4-Pro', machine: '本机模型', ip: '127.0.0.1', world: '本机', online: true, bot: true },
      { id: 'bot:demo/local-qwen', provider: 'demo', model: 'local-qwen', providerName: '演示',
        name: '本地小模型', machine: '本机模型', ip: '127.0.0.1', world: '本机', online: true, bot: true }
    ]
    var conversations = [
      { id: 'g-team', kind: 'group', name: '前端小队', icon: '🚀', tone: 'blue', memberIds: [me.id, 'peer-zhe', 'peer-man', 'peer-zhou'], notice: '今晚 20:00 一起过一版交互稿 🎨', unread: 2, updatedAt: now - 2 * m },
      { id: 'g-all', kind: 'group', name: '全员群', icon: '💬', tone: 'purple', memberIds: [me.id, 'peer-zhe', 'peer-man', 'peer-zhou', 'peer-test'], notice: '局域网内直接聊，不用装服务端 ✅', unread: 0, updatedAt: now - 46 * m },
      { id: 'd-peer-zhe', kind: 'direct', peerId: 'peer-zhe', name: '阿哲', icon: '哲', tone: 'orange', memberIds: [me.id, 'peer-zhe'], unread: 1, updatedAt: now - 12 * m },
      { id: 'd-peer-man', kind: 'direct', peerId: 'peer-man', name: '小满', icon: '满', tone: 'pink', memberIds: [me.id, 'peer-man'], unread: 0, updatedAt: now - 95 * m },
      { id: 'd-peer-zhou', kind: 'direct', peerId: 'peer-zhou', name: '老周', icon: '周', tone: 'green', memberIds: [me.id, 'peer-zhou'], unread: 0, updatedAt: now - 180 * m }
    ]
    function msg(convId, from, fromName, text, minutesAgo, kind) {
      return { id: convId + '-' + minutesAgo + '-' + Math.random().toString(36).slice(2, 6), conversationId: convId,
        from: from, fromName: fromName, text: text, at: now - minutesAgo * m, kind: kind || 'text' }
    }
    var messages = {
      'g-team': [
        msg('g-team', '', '', '阿哲 和 小满 加入了群聊', 62, 'system'),
        msg('g-team', 'peer-zhe', '阿哲', '新版聊天界面的原型我放共享盘了，大家看看 👀', 58),
        msg('g-team', 'peer-man', '小满', '看到了，三栏这个布局挺舒服的，右栏的雷达动画我喜欢', 55),
        msg('g-team', 'me-local', '我', '对，发现设备那块就用雷达，一眼能看出谁在线', 48),
        msg('g-team', 'peer-zhe', '阿哲', '那私聊和群聊的切换就放左栏 Tab，操作路径最短', 13),
        msg('g-team', 'peer-man', '小满', '收到～ 我先把群公告改成今晚 20:00 ✍️', 3),
        msg('g-team', 'peer-zhe', '阿哲', '@林间风 发送按钮的渐变要不要再亮一点？', 2),
        msg('g-team', 'me-local', '我', '@DeepSeek-V4-Pro 把交互稿缩成三条要点', 1)
      ],
      'g-all': [
        msg('g-all', '', '', '全员群已创建', 120, 'system'),
        msg('g-all', 'peer-zhou', '老周', '装好 world 插件就能互相看到，不用配服务器，真省事', 96),
        msg('g-all', 'me-local', '我', '对，UDP 广播自动发现，同一个网段就行 📡', 92),
        msg('g-all', 'peer-man', '小满', '我在 192.168.1.42，已经上线啦', 46)
      ],
      'd-peer-zhe': [
        msg('d-peer-zhe', 'peer-zhe', '阿哲', '你的 world 桌面现在开着几个窗口？', 34),
        msg('d-peer-zhe', 'me-local', '我', '两个，DSH 主窗口 + VSCode，可以叠着拖', 31),
        msg('d-peer-zhe', 'peer-zhe', '阿哲', '等下把聊天窗口也开上，正好试试多窗口 😄', 12)
      ],
      'd-peer-man': [
        msg('d-peer-man', 'peer-man', '小满', '设计稿的深色模式记得留一份', 95),
        msg('d-peer-man', 'me-local', '我', '留了，右上角一键切，变量都是同一套', 94)
      ],
      'd-peer-zhou': [
        msg('d-peer-zhou', 'peer-zhou', '老周', '局域网发现走的是 53318 端口，防火墙放行一下', 182),
        msg('d-peer-zhou', 'me-local', '我', '好，我在说明里写清楚', 180)
      ]
    }
    return { me: me, peers: peers, bots: bots, conversations: conversations, messages: messages, pending: {}, retrying: {} }
  }

  function createDemoBackend() {
    var state = demoState(), listeners = new Set(), replyTimers = []
    function emit() { for (var fn of listeners) fn(state) }
    function push(convId, message) {
      if (!state.messages[convId]) state.messages[convId] = []
      state.messages[convId].push(message)
      var conv = state.conversations.find(function (c) { return c.id === convId })
      if (conv) conv.updatedAt = message.at
    }
    var REPLIES = [
      '收到 👌 我看一下就回你',
      '这个想法不错，就这么定吧 ✨',
      '哈哈，正好我也在弄这块',
      '好，我在 192.168.1.x 这个网段，随时喊我',
      '稍等，我这边窗口开着，马上试一下',
      '👍 已经同步给大家了'
    ]
    // 原型里模型好友的回复故意用 Markdown，方便直接看渲染效果
    var BOT_REPLY_MD = [
      '**三条要点**',
      '',
      '1. 左栏保留「消息 / 通讯录 / 群聊」三个 Tab，路径最短',
      '2. 右栏发现设备用雷达动画，一眼能看出谁在线',
      '3. 私聊可以开成独立小窗，叠在主窗口上',
      '',
      '> 交互稿第 3 页还有个待确认点：群公告要不要支持 Markdown？',
      '',
      '```js',
      "const sum = list => list.reduce((a, b) => a + b, 0)",
      '```',
      '',
      '细节见 [设计稿](https://example.com/design)，`Enter` 发送、`Shift+Enter` 换行。'
    ].join('\n')
    return {
      start: function () { emit() },
      subscribe: function (fn) { listeners.add(fn); return function () { listeners.delete(fn) } },
      send: function (convId, text) {
        var conv = state.conversations.find(function (c) { return c.id === convId })
        if (!conv) return Promise.resolve()
        push(convId, { id: 'm' + Date.now() + Math.random(), conversationId: convId, from: state.me.id,
          fromName: state.me.nickname, text: text, at: Date.now(), kind: 'text' })
        // 原型里 @ 到模型好友就模拟一条回复，让 demo 与 live 的交互一致
        var bots = mentionedBots(text, state.bots).filter(function (bot) {
          return conv.kind !== 'group' || (conv.memberIds || []).indexOf(bot.id) >= 0
        })
        var direct = conv.kind === 'direct' ? (state.bots || []).find(function (b) { return b.id === conv.peerId }) : null
        if (!bots.length && direct) bots.push(direct)   // 显式 @ 了别人时，私聊对象不跟着回答
        bots = bots.slice(0, 4)
        if (bots.length) {
          state.pending[convId] = bots.map(function (b) { return b.name })
          emit()
          var botTimer = setTimeout(function () {
            for (var b of bots) {
              push(convId, { id: 'r' + Date.now() + Math.random(), conversationId: convId, from: b.id,
                fromName: b.name, text: BOT_REPLY_MD, at: Date.now(), kind: 'text' })
            }
            delete state.pending[convId]
            emit()
          }, 1600)
          replyTimers.push(botTimer)
          return Promise.resolve()
        }
        emit()
        var pool = conv.kind === 'group' ? state.peers.filter(function (p) { return p.online }) : state.peers.filter(function (p) { return p.id === conv.peerId })
        var peer = pool[Math.floor(Math.random() * pool.length)]
        if (!peer) return Promise.resolve()
        ui.typing = convId
        paintTyping()
        var timer = setTimeout(function () {
          push(convId, { id: 'r' + Date.now() + Math.random(), conversationId: convId, from: peer.id,
            fromName: peer.name, text: REPLIES[Math.floor(Math.random() * REPLIES.length)], at: Date.now(), kind: 'text' })
          ui.typing = ''
          paintTyping()
          emit()
        }, 1600)
        replyTimers.push(timer)
        return Promise.resolve()
      },
      createConversation: function (options) {
        var now = Date.now()
        if (options.kind === 'direct') {
          var existing = state.conversations.find(function (c) { return c.peerId === options.peerId })
          if (existing) return Promise.resolve(existing.id)
          var peer = state.peers.find(function (p) { return p.id === options.peerId }) ||
            state.bots.find(function (b) { return b.id === options.peerId }) || { name: '新成员', id: options.peerId }
          var id = 'd-' + options.peerId
          var direct = { id: id, kind: 'direct', peerId: options.peerId, name: peer.name,
            icon: peer.bot ? '🤖' : peer.name.slice(0, 1), tone: toneOf(peer.id),
            memberIds: [state.me.id, peer.id], unread: 0, updatedAt: now }
          if (peer.bot) direct.bot = true
          state.conversations.unshift(direct)
          state.messages[id] = [{ id: 'sys' + now, conversationId: id, from: '', fromName: '',
            text: peer.bot ? '已连接本机模型「' + peer.name + '」，直接发消息或 @ 它就能让它干活' : '已连接，可以开始私聊了',
            at: now, kind: 'system' }]
        } else {
          var gid = 'g-' + now.toString(36)
          var invitedBots = (state.bots || []).filter(function (bot) { return (options.botIds || []).indexOf(bot.id) >= 0 })
          state.conversations.unshift({ id: gid, kind: 'group', name: options.name, icon: '💬', tone: toneOf(gid),
            memberIds: [state.me.id].concat(options.memberIds || [], invitedBots.map(function (bot) { return bot.id })),
            botMembers: invitedBots.map(function (bot) { return Object.assign({}, bot, { ownerId: state.me.id }) }),
            allowOthersMention: options.allowOthersMention === true, notice: '欢迎加入新群聊 🎉', unread: 0, updatedAt: now })
          state.messages[gid] = [{ id: 'sys' + now, conversationId: gid, from: '', fromName: '', text: '你创建了群聊「' + options.name + '」', at: now, kind: 'system' }]
          emit()
          return Promise.resolve(gid)
        }
        emit()
        return Promise.resolve(options.kind === 'direct' ? 'd-' + options.peerId : '')
      },
      updateGroup: function (options) {
        var conv = state.conversations.find(function (row) { return row.id === options.conversationId })
        if (conv && conv.kind === 'group') {
          var added = (state.bots || []).filter(function (bot) { return (options.botIds || []).indexOf(bot.id) >= 0 })
          conv.botMembers = conv.botMembers || []
          added.forEach(function (bot) {
            if (!conv.botMembers.some(function (item) { return item.id === bot.id })) {
              conv.botMembers.push(Object.assign({}, bot, { ownerId: state.me.id }))
              conv.memberIds.push(bot.id)
            }
          })
          conv.allowOthersMention = options.allowOthersMention === true
          emit()
        }
        return Promise.resolve()
      },
      markRead: function (convId) {
        var conv = state.conversations.find(function (c) { return c.id === convId })
        if (conv && conv.unread) { conv.unread = 0; emit() }
        return Promise.resolve()
      },
      setProfile: function (nickname) { state.me.nickname = nickname; state.me.name = nickname; emit(); return Promise.resolve() },
      refresh: function () { emit(); return Promise.resolve() },
      // 原型里没有真宿主：只是让「绑定 / 新建会话」两个按钮点得动
      botSessions: function () {
        return Promise.resolve({ available: false, items: [
          { id: 'sess-demo-0001', updatedAt: Date.now() - 3600_000, blank: false },
          { id: 'sess-demo-0002', updatedAt: Date.now() - 7200_000, blank: true },
        ] })
      },
      bindBot: function (botId, sessionId) {
        var bot = state.bots.find(function (b) { return b.id === botId })
        if (bot) bot.sessionId = sessionId || ''
        emit()
        return Promise.resolve({ ok: true, sessionId: sessionId })
      },
      newBotSession: function (botId) {
        var bot = state.bots.find(function (b) { return b.id === botId })
        var id = 'sess-demo-' + Math.random().toString(36).slice(2, 8)
        if (bot) bot.sessionId = id
        emit()
        return Promise.resolve({ ok: true, sessionId: id })
      },
      dispose: function () { for (var t of replyTimers) clearTimeout(t) }
    }
  }

  /* ------------------------------ live 后端 ------------------------------ */
  function createLiveBackend() {
    var state = { me: { nickname: '我' }, peers: [], bots: [], pending: {}, retrying: {}, conversations: [], messages: {} },
      listeners = new Set(), source = null
    function emit() { for (var fn of listeners) fn(state) }
    function adopt(data) {
      if (!data) return
      state = data
      state.bots = state.bots || []       // 旧版服务没有模型好友字段时也能正常渲染
      state.pending = state.pending || {}
      state.retrying = state.retrying || {}
      emit()
    }
    function post(path, payload) {
      return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) })
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json() })
    }
    return {
      start: function () {
        return fetch('/api/state').then(function (res) { return res.json() }).then(function (data) {
          adopt(data)
          source = new EventSource('/api/events')
          source.onmessage = function (event) {
            try {
              var packet = JSON.parse(event.data)
              if (packet.type === 'state') adopt(packet.state)
            } catch (e) {}
          }
        }).catch(function (error) { toast('连接本机聊天服务失败：' + error.message) })
      },
      subscribe: function (fn) { listeners.add(fn); return function () { listeners.delete(fn) } },
      send: function (convId, text) { return post('/api/send', { conversationId: convId, text: text }).then(function (data) { adopt(data.state) }) },
      createConversation: function (options) { return post('/api/conversations', options).then(function (data) { adopt(data.state); return data.id }) },
      updateGroup: function (options) { return post('/api/group/settings', options).then(function (data) { adopt(data.state); return data }) },
      markRead: function (convId) { return post('/api/read', { conversationId: convId }).then(function (data) { adopt(data.state) }) },
      setProfile: function (nickname) { return post('/api/profile', { nickname: nickname }).then(function (data) { adopt(data.state) }) },
      refresh: function () { return fetch('/api/state').then(function (res) { return res.json() }).then(adopt) },
      botSessions: function () {
        return fetch('/api/bots/sessions').then(function (res) { return res.json() })
      },
      bindBot: function (botId, sessionId) {
        return post('/api/bind', { botId: botId, sessionId: sessionId }).then(function (data) { adopt(data.state); return data })
      },
      newBotSession: function (botId, conversationId) {
        return post('/api/context/reset', { botId: botId, conversationId: conversationId })
          .then(function (data) { adopt(data.state); return data })
      },
      dispose: function () { if (source) source.close() }
    }
  }

  /* -------------------------------- UI -------------------------------- */
  // 长会话裁剪：默认只渲染最近 MESSAGE_WINDOW 条，点「载入更早」再往前翻
  var MESSAGE_WINDOW = 60
  var backend = DEMO ? createDemoBackend() : createLiveBackend()
  var S = null
  var ui = {
    tab: 'chats', activeId: null, query: '', pop: '', typing: '', lastReadId: null, show: MESSAGE_WINDOW,
    detailHidden: false, selected: new Set(), selectedBots: new Set()
  }
  document.documentElement.setAttribute('data-theme', 'light')
  var THEME_TOKENS = ['bg-base', 'bg-layer-1', 'bg-layer-2', 'bg-layer-3', 'label-primary', 'label-secondary',
    'label-tertiary', 'border-l1', 'border-l2', 'border-l3', 'interactive-bg-hover', 'interactive-bg-active',
    'state-business-primary']
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || !event.data || event.data.type !== 'world-dsh-theme') return
    document.documentElement.setAttribute('data-theme', event.data.theme === 'dark' ? 'dark' : 'light')
    var colors = event.data.colors && typeof event.data.colors === 'object' ? event.data.colors : {}
    THEME_TOKENS.forEach(function (token) {
      var value = colors[token]
      if (typeof value === 'string' && value.length <= 80 && window.CSS && CSS.supports('color', value)) {
        document.documentElement.style.setProperty('--dsw-alias-' + token, value)
      }
    })
    var mapped = {
      '--lc-bg': colors['bg-base'], '--lc-sidebar': colors['bg-layer-1'], '--lc-chat': colors['bg-layer-1'],
      '--lc-detail': colors['bg-layer-1'], '--lc-line': colors['border-l2'], '--lc-text': colors['label-primary'],
      '--lc-muted': colors['label-secondary'], '--lc-faint': colors['label-tertiary'],
      '--lc-raised': colors['bg-layer-2'], '--lc-track': colors['bg-layer-1'], '--lc-field': colors['bg-layer-2'],
      '--lc-accent': colors['state-business-primary'], '--lc-accent-soft': colors['interactive-bg-hover'],
      '--lc-bubble-in': colors['bg-layer-2'],
    }
    Object.keys(mapped).forEach(function (name) {
      var value = mapped[name]
      if (typeof value === 'string' && value && window.CSS && CSS.supports('color', value)) {
        document.documentElement.style.setProperty(name, value)
      }
    })
  })

  function peerById(id) {
    return (S.peers || []).find(function (p) { return p.id === id }) ||
      (S.bots || []).find(function (b) { return b.id === id })
  }
  function convById(id) { return (S.conversations || []).find(function (c) { return c.id === id }) }
  function activeConv() {
    if (ui.activeId && convById(ui.activeId)) return convById(ui.activeId)
    var list = (S.conversations || []).slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0) })
    return list[0] || null
  }
  function convName(conv) {
    if (!conv) return ''
    if (conv.kind === 'direct') { var p = peerById(conv.peerId); return p ? p.name : conv.name }
    return conv.name
  }
  function convIcon(conv) {
    if (!conv) return '💬'
    if (conv.kind === 'group') return conv.icon || '👥'
    var p = peerById(conv.peerId)
    return p ? p.name.slice(0, 1) : (conv.icon || '?')
  }
  function lastMessage(conv) {
    var list = (S.messages && S.messages[conv.id]) || []
    for (var i = list.length - 1; i >= 0; i--) if (list[i].kind !== 'system') return list[i]
    return list[list.length - 1] || null
  }
  function onlineCount() { return (S.peers || []).filter(function (p) { return p.online }).length }
  function matches(text) { return !ui.query || String(text || '').toLowerCase().indexOf(ui.query.toLowerCase()) >= 0 }

  function rowHtml(conv, selected) {
    var last = lastMessage(conv)
    var preview = last
      ? (last.kind === 'system' ? last.text : (last.from === S.me.id ? '我: ' : (conv.kind === 'group' ? last.fromName + ': ' : '')) + previewText(last.text))
      : '还没有消息'
    var p = conv.kind === 'direct' ? peerById(conv.peerId) : null
    return '<button type="button" class="lc-row' + (selected ? ' on' : '') + '" data-conv="' + esc(conv.id) + '">' +
      avatarHtml(convIcon(conv), conv.tone, '', conv.kind === 'direct' ? (p ? p.online : false) : undefined) +
      '<span class="lc-row-body"><span class="lc-row-top"><span class="lc-row-name">' + esc(convName(conv)) + '</span>' +
      '<span class="lc-row-time">' + esc(shortTime(conv.updatedAt)) + '</span></span>' +
      '<span class="lc-row-sub"><span>' + esc(preview) + '</span>' +
      (conv.unread ? '<span class="lc-badge">' + conv.unread + '</span>' : '') + '</span></span></button>'
  }

  function renderSidebar() {
    var list = $('lcList'), html = ''
    var conversations = (S.conversations || []).slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0) })
    if (ui.tab === 'chats' || ui.tab === 'groups') {
      var rows = conversations.filter(function (c) {
        return (ui.tab === 'groups' ? c.kind === 'group' : true) && (matches(convName(c)) || matches(lastMessage(c) && lastMessage(c).text))
      })
      html += '<div class="lc-list-title">' + (ui.tab === 'groups' ? '群聊 · ' + rows.length + ' 个' : '最近会话') + '</div>'
      html += rows.length ? rows.map(function (c) { return rowHtml(c, c.id === (activeConv() && activeConv().id)) }).join('')
        : '<div class="lc-empty"><strong>没有匹配的会话</strong>换个关键词，或新建一个群聊</div>'
    } else {
      var peers = (S.peers || []).filter(function (p) { return matches(p.name) || matches(p.machine) || matches(p.ip) })
      var bots = (S.bots || []).filter(function (b) { return matches(b.name) || matches(b.model) || matches(b.provider) })
      if (bots.length) {
        html += '<div class="lc-list-title">本机模型 · ' + bots.length + ' <span class="lc-list-hint">@ 可派活</span></div>'
        html += bots.map(function (b) {
          return '<button type="button" class="lc-row lc-row-bot" data-peer="' + esc(b.id) + '" title="' + esc(b.provider + ' / ' + b.model) + '">' +
            avatarHtml('🤖', toneOf(b.id), '', true) +
            '<span class="lc-row-body"><span class="lc-row-top"><span class="lc-row-name">' + esc(b.name) + '</span>' +
            '<span class="lc-row-time">本机</span></span>' +
            '<span class="lc-row-sub"><span>' + esc(b.providerName || b.provider) + '</span>' +
            '<span class="lc-bot-session">' + (b.sessionId ? '会话 ' + esc(shortSessionId(b.sessionId)) : '未绑会话') + '</span></span></span></button>'
        }).join('')
      }
      var groups = [['在线设备', true], ['离线设备', false]]
      for (var g of groups) {
        var part = peers.filter(function (p) { return Boolean(p.online) === g[1] })
        if (!part.length) continue
        html += '<div class="lc-list-title">' + g[0] + ' · ' + part.length + '</div>'
        html += part.map(function (p) {
          return '<button type="button" class="lc-row" data-peer="' + esc(p.id) + '" title="' + esc(p.ip) + '">' +
            avatarHtml(p.name.slice(0, 1), toneOf(p.id), '', p.online) +
            '<span class="lc-row-body"><span class="lc-row-top"><span class="lc-row-name">' + esc(p.name) + '</span>' +
            '<span class="lc-row-time">' + esc((p.world || '').replace('@local/dsh-world', 'world')) + '</span></span>' +
            '<span class="lc-row-sub"><span>' + esc(p.machine) + ' · ' + esc(p.ip) + '</span></span></span></button>'
        }).join('')
      }
      if (!peers.length && !bots.length) html += '<div class="lc-empty"><strong>还没有发现设备</strong>同一局域网里启动其它机器的聊天服务即可自动出现</div>'
    }
    list.innerHTML = html
    for (var tab of $('lcTabs').children) {
      tab.classList.toggle('on', tab.dataset.tab === ui.tab)
      tab.setAttribute('aria-selected', tab.dataset.tab === ui.tab ? 'true' : 'false')
    }
  }

  function renderHead() {
    var conv = activeConv(), head = $('lcChatHead')
    if (!conv) { head.innerHTML = '<div class="lc-head-info"><strong>还没有会话</strong><span class="lc-head-sub">从通讯录选一个人开始私聊</span></div>'; return }
    var p = conv.kind === 'direct' ? peerById(conv.peerId) : null
    var members = (conv.memberIds || []).map(peerById).filter(Boolean)
    var sub = p && p.bot
      ? '本机模型 · ' + p.provider + '/' + p.model + ' · @ 它派活'
      : (conv.kind === 'group'
        ? (conv.memberIds || []).length + ' 位成员 · ' + members.filter(function (x) { return x.online }).length + ' 人在线'
        : (p ? (p.online ? '在线' : '离线') + ' · ' + p.ip + ' · ' + p.machine : '私聊'))
    head.innerHTML = avatarHtml(convIcon(conv), conv.tone, 'lg') +
      '<div class="lc-head-info"><strong>' + esc(convName(conv)) + '</strong><span class="lc-head-sub"><i></i>' + esc(sub) + '</span></div>' +
      '<div class="lc-head-actions">' +
      '<button class="lc-head-btn" type="button" data-action="search" title="搜索会话">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10.8" cy="10.8" r="6.6"/><path d="M16 16l4.5 4.5"/></svg></button>' +
      '<button class="lc-head-btn' + (ui.detailHidden ? '' : ' on') + '" type="button" data-action="detail" title="成员与设备">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.6-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><circle cx="17.5" cy="9.2" r="2.4"/><path d="M16.6 14.6c2.2.2 3.6 1.6 4 4"/></svg></button>' +
      '<button class="lc-head-btn" type="button" data-action="refresh" title="刷新状态">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 5v6h-6"/></svg></button></div>'
  }

  // 长会话裁剪：默认只渲染最近 MESSAGE_WINDOW 条，点「载入更早」再往前翻
  var lastMessagesKey = ''

  function renderMessages(options) {
    var box = $('lcMessages'), conv = activeConv()
    if (!conv) {
      lastMessagesKey = ''
      box.innerHTML = '<div class="lc-empty"><strong>开始一段聊天</strong>左侧「通讯录」里点一个人，就能直接私聊</div>'
      return
    }
    var list = (S.messages && S.messages[conv.id]) || []
    var key = [conv.id, list.length, list.length ? list[list.length - 1].id : '', ui.show, S.me.id, S.me.nickname].join('|')
    // 只有「消息集合 / 窗口大小 / 我」变化时才重建，纯在线状态推送不碰 DOM
    if (key === lastMessagesKey && !(options && options.force)) return
    lastMessagesKey = key

    var stick = box.scrollHeight - box.scrollTop - box.clientHeight < 140
    var top = box.scrollTop
    var start = Math.max(0, list.length - ui.show)
    var html = ''
    if (start > 0) {
      html += '<div class="lc-more"><button type="button" data-action="more">载入更早的 ' +
        Math.min(MESSAGE_WINDOW, start) + ' 条</button><span>共 ' + list.length + ' 条</span></div>'
    }
    html += '<div class="lc-day"><span>今天</span></div>'
    if (!list.length) html += '<div class="lc-empty"><strong>还没有消息</strong>发一句「在吗」打个招呼吧 👋</div>'
    // 同一个人 5 分钟内连续说的几条合成一组：只留第一个头像、第一个时间，
    // 气泡之间收紧到 5px，尾角只画在最后一条上——一屏能多看清一两条消息。
    var GROUP_GAP = 5 * 60000
    var plain = list.filter(function (m) { return m.kind !== 'system' })
    var groupOf = {}
    for (var g = 0; g < plain.length; g += 1) {
      var prevPlain = plain[g - 1], nextPlain = plain[g + 1]
      groupOf[plain[g].id] = {
        cont: Boolean(prevPlain && prevPlain.from === plain[g].from && plain[g].at - prevPlain.at < GROUP_GAP && plain[g].at >= prevPlain.at),
        end: !(nextPlain && nextPlain.from === plain[g].from && nextPlain.at - plain[g].at < GROUP_GAP && nextPlain.at >= plain[g].at),
      }
    }
    for (var index = start; index < list.length; index += 1) {
      var message = list[index]
      if (message.kind === 'system') { html += '<div class="lc-system"><span>' + esc(message.text) + '</span></div>'; continue }
      var mine = message.from === S.me.id
      var sender = mine ? S.me.nickname : message.fromName
      var group = groupOf[message.id] || { cont: false, end: true }
      html += '<div class="lc-msg ' + (mine ? 'out' : 'in') + (group.cont ? ' is-cont' : ' is-start') + (group.end ? ' is-end' : '') + '">' +
        (group.cont ? '' : avatarHtml(mine ? S.me.nickname.slice(0, 1) : String(sender || '?').slice(0, 1), mine ? 'me' : toneOf(message.from), 'sm')) +
        '<div class="lc-msg-body">' +
        (group.cont ? '' : '<div class="lc-msg-meta">' +
          (conv.kind === 'group' && !mine ? '<strong>' + esc(sender) + '</strong>' : '') +
          '<span>' + esc(clock(message.at)) + '</span></div>') +
        '<div class="lc-bubble lc-md">' + markdownHtml(message.id, message.text) + '</div></div></div>'
    }
    box.innerHTML = html
    if (stick) { box.scrollTop = box.scrollHeight; pinnedToBottom = true }
    else if (options && options.fromBottom) {
      // 往前翻历史时按「距底部的距离」定位，并临时关掉平滑滚动，避免整屏滑动
      var previous = box.style.scrollBehavior
      box.style.scrollBehavior = 'auto'
      box.scrollTop = Math.max(0, box.scrollHeight - options.fromBottom)
      box.style.scrollBehavior = previous
    } else box.scrollTop = top
  }

  function shortSessionId(id) { return String(id || '').slice(0, 8) }

  /**
   * 模型私聊里的「dsh 会话」卡片。
   * 模型上下文在 dsh 会话里（由 dsh 负责压缩 / 持久化），聊天记录在本机另存一份，
   * 所以既能换会话从头开始，又不会把聊天记录弄丢。
   */
  function sessionCardHtml(bot) {
    var sessionId = bot.sessionId || ''
    return '<div class="lc-panel-card lc-session-card">' +
      '<div class="lc-panel-title">dsh 会话 <span>' + (sessionId ? '已绑定' : '未绑定') + '</span></div>' +
      '<div class="lc-session-id' + (sessionId ? '' : ' empty') + '" title="' + esc(sessionId) + '">' +
      (sessionId ? esc(shortSessionId(sessionId)) : '第一次派活时自动新建一个') + '</div>' +
      '<div class="lc-session-actions">' +
      '<button type="button" data-action="bot-session-new" data-bot="' + esc(bot.id) + '">新建会话</button>' +
      '<button type="button" data-action="bot-session-pick" data-bot="' + esc(bot.id) + '">绑定已有</button>' +
      (sessionId ? '<button type="button" class="lc-session-clear" data-action="bot-session-clear" data-bot="' + esc(bot.id) + '">解绑</button>' : '') +
      '</div>' +
      '<p class="lc-session-hint">模型看到的是 dsh 会话里的上下文；这里的聊天记录另外存在本机，重启 dsh 后都还在。</p></div>'
  }

  function renderDetail() {
    var detail = $('lcDetail'), conv = activeConv()
    if (!conv) { detail.innerHTML = ''; return }
    var botId = conv.ownerBotId || (conv.kind === 'direct' && String(conv.peerId || '').indexOf('bot:') === 0 ? conv.peerId : '')
    var bot = botId ? (S.bots || []).find(function (b) { return b.id === botId }) : null
    var members = (conv.memberIds || []).map(function (id) {
      if (id === S.me.id) return { id: id, name: S.me.nickname, machine: S.me.machine, ip: S.me.ip, online: true, me: true, world: S.me.world }
      var p = peerById(id)
      var invited = (conv.botMembers || []).find(function (item) { return item.id === id })
      if (!p && invited) p = invited
      var botOwner = invited && invited.ownerId === S.me.id
        ? null : invited && (S.peers || []).find(function (peer) { return peer.id === invited.ownerId })
      return p ? Object.assign({}, p, { me: false,
        machine: p.bot ? (invited && invited.ownerId === S.me.id ? '本机模型' : '模型好友') : p.machine,
        ip: p.bot ? p.provider + '/' + p.model : p.ip,
        online: p.bot ? (invited ? invited.ownerId === S.me.id || Boolean(botOwner && botOwner.online) : p.online) : p.online }) : null
    }).filter(Boolean)
    var online = members.filter(function (m) { return m.online }), offline = members.filter(function (m) { return !m.online })
    var html = '<div class="lc-panel-card"><div class="lc-profile">' +
      avatarHtml(convIcon(conv), conv.tone, 'lg') + '<strong>' + esc(convName(conv)) + '</strong>' +
      '<span>' + (conv.kind === 'group' ? '群聊 · ' + members.length + ' 位成员'
        : (conv.bot ? '私聊 · 本机模型' : '私聊 · ' + (members[1] ? esc(members[1].ip) : ''))) + '</span>' +
      '<span class="lc-chip"><span class="lc-pulse"></span>' + (conv.kind === 'group' ? online.length + ' 人在线' : '局域网直连') + '</span></div>' +
      (conv.notice ? '<div class="lc-notice"><strong>群公告</strong>' + esc(conv.notice) + '</div>' : '') + '</div>'
    if (bot) html += sessionCardHtml(bot)

    var membersHtml = '<div class="lc-panel-card lc-members-card"><div class="lc-panel-title">成员 <span>' + online.length + ' 在线 / ' + members.length + '</span></div>'
    var twoGroups = Boolean(online.length && offline.length)
    for (var group of [['在线', online], ['离线', offline]]) {
      if (!group[1].length) continue
      // 只有一组时不重复写「在线」：标题里已经说了
      if (twoGroups) membersHtml += '<div class="lc-group-label">' + group[0] + '</div>'
      membersHtml += group[1].map(function (m) {
        return '<div class="lc-member">' + avatarHtml(m.name.slice(0, 1), m.me ? 'me' : toneOf(m.id), 'sm', m.online) +
          '<div class="lc-member-body"><strong>' + esc(m.name) + (m.me ? ' · 我' : '') + '</strong><span>' + esc(m.machine) + ' · ' + esc(m.ip) + '</span></div>' +
          '<span class="lc-member-state' + (m.online ? ' on' : '') + '">' + (m.bot ? '模型' : (m.online ? '在线' : '离线')) + '</span></div>'
      }).join('')
    }
    if (conv.kind === 'group') {
      membersHtml += '<div class="lc-group-settings"><div><strong>群内模型</strong><span>' +
        ((conv.botMembers || []).length ? (conv.botMembers || []).length + ' 个已邀请' : '默认不加入模型好友') +
        '</span></div><div><strong>其他成员 @ 模型</strong><span>' + (conv.allowOthersMention ? '允许' : '关闭') +
        '</span></div>' + (conv.id !== 'g-lan-lobby' && (!conv.ownerId || conv.ownerId === S.me.id)
          ? '<button type="button" class="lc-btn" data-action="group-settings">管理模型与 @ 权限</button>' : '') + '</div>'
    }
    membersHtml += '</div>'

    var devices = [{ name: S.me.nickname + '（本机）', ip: S.me.ip, world: S.me.world, online: true, me: true }].concat(
      (S.peers || []).map(function (p) { return { name: p.name, ip: p.ip, world: p.world, online: p.online } }))
      .filter(function (d) { return d.online })
    // 雷达上的点跟着在线台数走，别固定画三个
    var radarDots = devices.slice(0, 3).map(function (_, i) {
      return '<i class="lc-radar-dot d' + (i + 1) + '"></i>'
    }).join('')
    var discoverHtml = '<div class="lc-panel-card"><div class="lc-panel-title">局域网发现 <span>' + devices.length + ' 台在线</span></div>' +
      '<div class="lc-radar"><div class="lc-radar-sweep"></div>' + radarDots + '</div>' +
      devices.map(function (d) {
        return '<div class="lc-device"><i class="' + (d.online ? '' : 'off') + '"></i><div class="lc-device-body"><strong>' + esc(d.name) + '</strong>' +
          '<span>' + esc(d.ip) + '</span></div><span class="lc-device-version">' + esc(String(d.world || '').replace('@local/dsh-world ', 'world ')) + '</span></div>'
      }).join('') + '</div>'
    var safeHtml = '<div class="lc-safe-note"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex:0 0 13px;margin-top:1px"><path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6l8-3z"/></svg>' +
      '<span>自动发现同一网段中装有 world 插件的设备；消息点对点传输，不经过任何外部服务器。</span></div>'
    // 网络健康：UDP 收不到时，先看这里，不用再猜「为什么对方看不到我」
    var net = S.network || {}
    var inboundAgo = net.lastInboundAt ? Math.max(0, Math.round((Date.now() - net.lastInboundAt) / 1000)) : null
    var netWarn = net.warnings && net.warnings.length ? net.warnings[0] : ''
    var netHtml = '<div class="lc-net-health' + (netWarn ? ' is-warn' : '') + '">' +
      '<div class="lc-net-line"><i></i><span>UDP ' + esc(String(net.discoveryPort || 53318)) +
        (net.udpBound ? ' 已就绪' : ' 未绑定') + ' · ' +
        (inboundAgo === null ? '尚未收到广播' : '收到广播 ' + inboundAgo + ' 秒前') +
        (net.onlinePeers === undefined ? '' : ' · ' + net.onlinePeers + ' 台在线') + '</span>' +
      '<button type="button" class="lc-net-copy" data-action="copy-diagnostics">复制诊断</button></div>' +
      (netWarn ? '<div class="lc-net-warn">' + esc(netWarn) + '</div>' : '') + '</div>'
    // 发现卡排在成员卡前面：局域网状态是这个应用最需要一眼看到的信息
    detail.innerHTML = html + discoverHtml + netHtml + membersHtml + safeHtml
  }

  function paintTyping() {
    var id = ui.activeId
    var retry = (S && S.retrying && id && S.retrying[id]) || []
    var names = (S && S.pending && id && S.pending[id]) || []
    var text = ''
    if (retry.length) {
      text = '🤖 ' + retry.map(function (r) { return r.name + ' 重试 ' + r.attempt + '/' + r.attempts }).join('、') + '…'
    } else if (names.length) {
      text = '🤖 ' + names.join('、') + ' 正在思考…'
    } else if (ui.typing) {
      text = '对方正在输入…'
    }
    $('lcTyping').textContent = text
  }

  function render() {
    if (!S) return
    $('lcOnlineCount').textContent = onlineCount() + ' 人在线'
    $('lcMyName').textContent = S.me.nickname || '我'
    $('lcMyStatus').textContent = '在线 · ' + (S.me.ip || '本机')
    $('lcMeAvatar').textContent = (S.me.nickname || '我').slice(0, 1)
    if (!ui.activeId && activeConv()) ui.activeId = activeConv().id
    var active = activeConv()
    if (active && active.unread && ui.lastReadId !== active.id) {
      ui.lastReadId = active.id
      Promise.resolve(backend.markRead(active.id)).catch(function () {})
    }
    renderSidebar(); renderHead(); renderMessages(); renderDetail(); paintTyping()
    document.body.classList.toggle('lc-detail-hidden', ui.detailHidden)
    syncSend()
  }

  /** 发送按钮只有「有会话 + 输入框里有字」才亮起来。 */
  function syncSend() {
    $('lcSend').disabled = !activeConv() || !$('lcInput').value.trim()
  }

  backend.subscribe(function (next) { S = next; render() })

  /* ------------------------------ 交互 ------------------------------ */
  function toast(message) {
    var el = $('lcToast'); el.textContent = message; el.hidden = false
    clearTimeout(toast.timer); toast.timer = setTimeout(function () { el.hidden = true }, 2200)
  }

  /** 把 /api/diagnostics 的完整结果复制给用户；排查时直接贴给另一边或贴到工单里。 */
  function copyDiagnostics() {
    if (DEMO) { toast('演示模式没有本机诊断'); return }
    fetch('/api/diagnostics').then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }).then(function (data) {
      var text = JSON.stringify(data, null, 2)
      if (!navigator.clipboard || !navigator.clipboard.writeText) { toast('当前环境不支持复制'); return }
      navigator.clipboard.writeText(text).then(function () { toast('诊断信息已复制') }, function () { toast('复制失败') })
    }).catch(function (error) { toast('读取诊断失败：' + error.message) })
  }
  var lcTools = document.querySelector('.lc-tools')
  function closePop() {
    ui.pop = ''; $('lcEmojiPop').hidden = true; $('lcQuickPop').hidden = true; $('lcMentionPop').hidden = true
    for (var b of lcTools.querySelectorAll('button')) b.classList.remove('on')
  }
  /** @ 面板：本机模型好友排在真人前面，点一下把「@名字 」插进输入框。 */
  function mentionHtml() {
    var conv = activeConv()
    var invited = conv && conv.kind === 'group' ? (conv.botMembers || []) : (S.bots || [])
    var bots = invited.map(function (member) {
      return (S.bots || []).find(function (bot) { return bot.id === member.id }) || member
    }).filter(function (b) { return matches(b.name) || matches(b.model) || matches(b.provider) })
    var people = []
    if (conv) {
      var ids = conv.kind === 'group' ? (conv.memberIds || []).filter(function (id) { return String(id).indexOf('bot:') !== 0 }) : [conv.peerId]
      people = ids.map(peerById).filter(function (p) { return p && p.id !== S.me.id && !p.bot })
    }
    var rows = bots.map(function (b) {
      var member = invited.find(function (item) { return item.id === b.id })
      return { name: b.name, sub: (member && member.ownerId === S.me.id ? '本机模型 · ' : '模型好友 · ') + b.provider + '/' + b.model, bot: true }
    }).concat(people.map(function (p) {
      return { name: p.name, sub: p.machine + ' · ' + p.ip, bot: false }
    }))
    if (!rows.length) return '<div class="lc-mention-empty">还没有可 @ 的成员</div>'
    return '<div class="lc-mention-title">点一下插入 @，后面直接写任务</div>' + rows.map(function (r) {
      return '<button type="button" data-insert="' + esc('@' + r.name + ' ') + '">' +
        '<span class="lc-mention-avatar">' + (r.bot ? '🤖' : esc(r.name.slice(0, 1))) + '</span>' +
        '<span class="lc-mention-body"><strong>' + esc(r.name) + '</strong><span>' + esc(r.sub) + '</span></span></button>'
    }).join('')
  }
  function openPop(name) {
    var wasOpen = ui.pop === name
    closePop()
    if (wasOpen) return
    ui.pop = name
    var emoji = ['😀', '😄', '😊', '🥰', '😉', '😍', '🤔', '😅', '😂', '🥳', '👍', '👏', '🙌', '💪', '🙏', '✨', '🎉', '🚀', '💡', '✅', '❤️', '🔥', '👀', '📡']
    var quick = ['收到 👌 我看一下就回你', '在吗？方便一起看个问题吗？', '我这边窗口开着，随时喊我', '好，就这么定 ✨']
    var pop = name === 'emoji' ? $('lcEmojiPop') : name === 'quick' ? $('lcQuickPop') : $('lcMentionPop')
    var button = lcTools.querySelector('[data-tool="' + name + '"]')
    pop.innerHTML = name === 'emoji'
      ? emoji.map(function (e) { return '<button type="button" data-insert="' + esc(e) + '">' + e + '</button>' }).join('')
      : name === 'quick'
        ? quick.map(function (q) { return '<button type="button" data-insert="' + esc(q) + '">' + esc(q) + '</button>' }).join('')
        : mentionHtml()
    pop.hidden = false
    if (button) button.classList.add('on')
  }
  function insertText(text) {
    var input = $('lcInput')
    input.value += (input.value && !/\s$/.test(input.value) ? ' ' : '') + text
    input.focus(); autoHeight(); syncSend()
  }
  function autoHeight() {
    var input = $('lcInput')
    input.style.height = 'auto'
    input.style.height = Math.min(120, Math.max(34, input.scrollHeight)) + 'px'
  }
  function sendCurrent() {
    var input = $('lcInput'), text = input.value.trim(), conv = activeConv()
    if (!text || !conv) return
    input.value = ''; autoHeight(); closePop(); syncSend()
    backend.send(conv.id, text).catch(function (e) { toast('发送失败：' + e.message) })
  }
  function openConversation(id) {
    if (ui.activeId !== id) ui.show = MESSAGE_WINDOW
    ui.activeId = id
    backend.markRead(id)
    render()
  }
  function openPeer(peerId) {
    var existing = (S.conversations || []).find(function (c) { return c.peerId === peerId })
    if (existing) return openConversation(existing.id)
    backend.createConversation({ kind: 'direct', peerId: peerId }).then(function (id) {
      if (id) openConversation(id)
    }).catch(function (e) { toast('无法建立私聊：' + e.message) })
  }

  $('lcTabs').addEventListener('click', function (e) {
    var button = e.target.closest('[data-tab]'); if (!button) return
    ui.tab = button.dataset.tab; render()
  })
  $('lcList').addEventListener('click', function (e) {
    var conv = e.target.closest('[data-conv]'), peer = e.target.closest('[data-peer]')
    if (conv) openConversation(conv.dataset.conv)
    else if (peer) openPeer(peer.dataset.peer)
  })
  $('lcSearch').addEventListener('input', function (e) { ui.query = e.target.value.trim(); render() })
  $('lcInput').addEventListener('input', function () { autoHeight(); syncSend() })
  $('lcInput').addEventListener('keydown', function (e) {
    // 选词回车由输入法处理；229 兼容仍用旧键码标记合成输入的环境。
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent() }
  })
  $('lcSend').addEventListener('click', sendCurrent)
  $('lcMessages').addEventListener('click', function (e) {
    var more = e.target.closest('[data-action="more"]')
    if (more) {
      var box = $('lcMessages')
      var fromBottom = box.scrollHeight - box.scrollTop
      ui.show += MESSAGE_WINDOW
      renderMessages({ force: true, fromBottom: fromBottom })
      return
    }
    var copy = e.target.closest('.lc-code-copy')
    if (!copy) return
    var holder = copy.closest('.lc-code')
    var code = holder && holder.querySelector('pre code')
    var restore = function () { copy.textContent = '复制' }
    if (!navigator.clipboard || !navigator.clipboard.writeText) { toast('当前环境不支持复制'); return }
    navigator.clipboard.writeText(code ? code.textContent : '').then(function () {
      copy.textContent = '已复制'; setTimeout(restore, 1400)
    }, function () { toast('复制失败，请手动选择文本') })
  })
  lcTools.addEventListener('click', function (e) {
    var button = e.target.closest('[data-tool]'); if (!button) return
    openPop(button.dataset.tool)
  })
  for (var pop of [$('lcEmojiPop'), $('lcQuickPop'), $('lcMentionPop')]) pop.addEventListener('click', function (e) {
    var button = e.target.closest('[data-insert]'); if (!button) return
    insertText(button.dataset.insert); closePop()
  })
  $('lcChatHead').addEventListener('click', function (e) {
    var button = e.target.closest('[data-action]'); if (!button) return
    if (button.dataset.action === 'search') $('lcSearch').focus()
    if (button.dataset.action === 'detail') { ui.detailHidden = !ui.detailHidden; render() }
    if (button.dataset.action === 'refresh') backend.refresh().then(function () { toast('状态已刷新') }).catch(function () {})
  })

  /* --------------- 模型 ⇄ dsh 会话：绑定、换新、解绑 --------------- */

  function closeSessionPop() { $('lcSessionPop').hidden = true }

  function openSessionPicker(botId) {
    var pop = $('lcSessionPop')
    pop.innerHTML = '<div class="lc-pop-title">绑定到一个 dsh 会话</div><div class="lc-session-loading">正在读取会话列表…</div>'
    pop.hidden = false
    var close = function (html) { pop.innerHTML = '<div class="lc-pop-title">绑定到一个 dsh 会话</div>' + html }
    backend.botSessions().then(function (data) {
      var items = (data && data.items) || []
      if (!items.length) {
        close('<div class="lc-session-loading">' + (data && data.available === false
          ? '这个环境读不到 dsh 会话列表（独立模式没有宿主）' : 'dsh 里还没有别的会话') + '</div>')
        return
      }
      close(items.map(function (item) {
        return '<button type="button" class="lc-session-row" data-bind="' + esc(item.id) + '" data-bot="' + esc(botId) + '">' +
          '<span class="lc-session-row-id">' + esc(shortSessionId(item.id)) + '</span>' +
          '<span class="lc-session-row-meta">' + (item.blank ? '空会话' : '有内容') +
          (item.botId ? ' · 已被 ' + esc(item.botId.replace('bot:', '')) + ' 占用' : '') + '</span></button>'
      }).join(''))
    }, function (error) { close('<div class="lc-session-loading">读取失败：' + esc(error.message) + '</div>') })
  }

  $('lcDetail').addEventListener('click', function (e) {
    var button = e.target.closest('[data-action]'); if (!button) return
    var botId = button.dataset.bot
    if (button.dataset.action === 'copy-diagnostics') { copyDiagnostics(); return }
    if (button.dataset.action === 'group-settings') { openGroupSettingsModal(); return }
    if (button.dataset.action === 'bot-session-pick') { openSessionPicker(botId); return }
    if (button.dataset.action === 'bot-session-new') {
      toast('正在新建 dsh 会话…')
      backend.newBotSession(botId, ui.activeId).then(function (data) {
        toast(data && data.sessionId ? '已换到新会话 ' + shortSessionId(data.sessionId) : '已新建会话')
        render()
      }).catch(function (error) { toast('新建失败：' + error.message) })
      return
    }
    if (button.dataset.action === 'bot-session-clear') {
      backend.bindBot(botId, '').then(function () { toast('已解绑，下次派活会重新建会话'); render() })
        .catch(function (error) { toast('解绑失败：' + error.message) })
    }
  })

  $('lcSessionPop').addEventListener('click', function (e) {
    var button = e.target.closest('[data-bind]'); if (!button) return
    var sessionId = button.dataset.bind
    backend.bindBot(button.dataset.bot, sessionId).then(function () {
      closeSessionPop()
      toast('已绑定到会话 ' + shortSessionId(sessionId))
      render()
    }).catch(function (error) { toast('绑定失败：' + error.message) })
  })

  document.addEventListener('click', function (e) {
    if ($('lcSessionPop').hidden) return
    if (e.target.closest('#lcSessionPop') || e.target.closest('[data-action="bot-session-pick"]')) return
    closeSessionPop()
  })

  /* 模态：新建群聊 / 修改昵称 */
  function closeModal() { $('lcModalRoot').hidden = true; $('lcModalRoot').innerHTML = '' }
  function openGroupModal() {
    var peers = (S.peers || []).filter(function (p) { return p.online })
    var bots = S.bots || []
    ui.selected = new Set()
    ui.selectedBots = new Set()
    $('lcModalRoot').innerHTML = '<div class="lc-modal"><h3>新建群聊</h3><p>选择设备成员；模型好友默认不加入，需要时单独邀请。</p>' +
      '<input class="lc-field" id="lcGroupName" placeholder="群聊名称，例如：交付小组" maxlength="30" />' +
      '<label class="lc-modal-label">选择成员 · ' + peers.length + ' 人在线</label>' +
      '<div class="lc-check-list" id="lcGroupMembers">' + (peers.length ? peers.map(function (p) {
        return '<button type="button" class="lc-check" data-member="' + esc(p.id) + '"><span class="lc-check-box">✓</span>' +
          avatarHtml(p.name.slice(0, 1), toneOf(p.id), 'sm') +
          '<span class="lc-check-body"><strong>' + esc(p.name) + '</strong><span>' + esc(p.machine) + ' · ' + esc(p.ip) + '</span></span></button>'
      }).join('') : '<div class="lc-empty">暂无在线设备成员</div>') + '</div>' +
      '<label class="lc-modal-label">邀请模型好友 · ' + bots.length + ' 个（默认不选）</label>' +
      '<div class="lc-check-list" id="lcGroupBots">' + (bots.length ? bots.map(function (bot) {
        return '<button type="button" class="lc-check" data-bot-member="' + esc(bot.id) + '"><span class="lc-check-box">✓</span>' +
          avatarHtml('🤖', 'blue', 'sm') + '<span class="lc-check-body"><strong>' + esc(bot.name) +
          '</strong><span>' + esc(bot.provider + '/' + bot.model) + '</span></span></button>'
      }).join('') : '<div class="lc-empty">本机尚未配置模型好友</div>') + '</div>' +
      '<label class="lc-setting-check"><input id="lcAllowOthersMention" type="checkbox" /><span><strong>允许其他群成员 @ 已邀请的模型好友</strong><small>默认关闭；开启后由模型所在设备处理 @ 消息。</small></span></label>' +
      '<div class="lc-modal-actions"><button class="lc-btn" type="button" data-modal="cancel">取消</button>' +
      '<button class="lc-btn primary" type="button" data-modal="create">创建群聊</button></div></div>'
    $('lcModalRoot').hidden = false
    $('lcGroupName').focus()
  }
  function openGroupSettingsModal() {
    var conv = activeConv()
    if (!conv || conv.kind !== 'group') return
    ui.selectedBots = new Set()
    var members = new Set((conv.botMembers || []).map(function (bot) { return bot.id }))
    var available = (S.bots || []).filter(function (bot) { return !members.has(bot.id) })
    var invited = (conv.botMembers || []).map(function (bot) {
      return '<div class="lc-group-invited"><span>🤖</span><strong>' + esc(bot.name) + '</strong><small>已加入群聊</small></div>'
    }).join('')
    $('lcModalRoot').innerHTML = '<div class="lc-modal"><h3>群聊设置 · ' + esc(conv.name) + '</h3>' +
      '<p>模型好友需要显式邀请。是否允许其他群成员 @ 模型也由这里控制。</p>' +
      (invited ? '<label class="lc-modal-label">已加入的模型好友</label>' + invited : '') +
      '<label class="lc-modal-label">邀请本机模型好友</label>' +
      '<div class="lc-check-list">' + (available.length ? available.map(function (bot) {
        return '<button type="button" class="lc-check" data-bot-member="' + esc(bot.id) + '"><span class="lc-check-box">✓</span>' +
          avatarHtml('🤖', 'blue', 'sm') + '<span class="lc-check-body"><strong>' + esc(bot.name) +
          '</strong><span>' + esc(bot.provider + '/' + bot.model) + '</span></span></button>'
      }).join('') : '<div class="lc-empty">没有可邀请的新模型好友</div>') + '</div>' +
      '<label class="lc-setting-check"><input id="lcAllowOthersMention" type="checkbox" ' + (conv.allowOthersMention ? 'checked' : '') + ' />' +
      '<span><strong>允许其他群成员 @ 已邀请的模型好友</strong><small>关闭时只有模型所在设备的用户可以 @ 它。</small></span></label>' +
      '<div class="lc-modal-actions"><button class="lc-btn" type="button" data-modal="cancel">取消</button>' +
      '<button class="lc-btn primary" type="button" data-modal="save-group-settings">保存设置</button></div></div>'
    $('lcModalRoot').hidden = false
  }
  function openProfileModal() {
    $('lcModalRoot').innerHTML = '<div class="lc-modal"><h3>我的昵称</h3><p>局域网里的其它人会看到这个名字，随时可以改。</p>' +
      '<input class="lc-field" id="lcNickInput" maxlength="24" value="' + esc(S.me.nickname || '') + '" />' +
      '<div class="lc-modal-actions"><button class="lc-btn" type="button" data-modal="cancel">取消</button>' +
      '<button class="lc-btn primary" type="button" data-modal="save">保存</button></div></div>'
    $('lcModalRoot').hidden = false
    $('lcNickInput').focus(); $('lcNickInput').select()
  }
  $('lcNewGroup').addEventListener('click', openGroupModal)
  $('lcMe').addEventListener('click', openProfileModal)
  $('lcModalRoot').addEventListener('click', function (e) {
    if (e.target === $('lcModalRoot')) return closeModal()
    var member = e.target.closest('[data-member]')
    if (member) {
      var id = member.dataset.member
      if (ui.selected.has(id)) ui.selected.delete(id); else ui.selected.add(id)
      member.classList.toggle('on', ui.selected.has(id))
      return
    }
    var botMember = e.target.closest('[data-bot-member]')
    if (botMember) {
      var botId = botMember.dataset.botMember
      if (ui.selectedBots.has(botId)) ui.selectedBots.delete(botId); else ui.selectedBots.add(botId)
      botMember.classList.toggle('on', ui.selectedBots.has(botId))
      return
    }
    var action = e.target.closest('[data-modal]'); if (!action) return
    if (action.dataset.modal === 'cancel') return closeModal()
    if (action.dataset.modal === 'save') {
      var nickname = $('lcNickInput').value.trim()
      if (!nickname) return toast('昵称不能为空')
      backend.setProfile(nickname).then(function () { closeModal(); toast('昵称已更新') }).catch(function (err) { toast('保存失败：' + err.message) })
      return
    }
    if (action.dataset.modal === 'save-group-settings') {
      var group = activeConv()
      if (!group || group.kind !== 'group') return closeModal()
      backend.updateGroup({ conversationId: group.id, botIds: Array.from(ui.selectedBots),
        allowOthersMention: $('lcAllowOthersMention').checked }).then(function () {
        closeModal(); toast('群聊设置已保存')
      }).catch(function (err) { toast('保存失败：' + err.message) })
      return
    }
    if (action.dataset.modal === 'create') {
      var name = $('lcGroupName').value.trim()
      if (!name) return toast('给群聊起个名字吧')
      if (!ui.selected.size && !ui.selectedBots.size) return toast('至少选择一位成员或模型好友')
      backend.createConversation({ kind: 'group', name: name, memberIds: Array.from(ui.selected),
        botIds: Array.from(ui.selectedBots), allowOthersMention: $('lcAllowOthersMention').checked }).then(function (id) {
        closeModal(); if (id) openConversation(id); toast('群聊「' + name + '」已创建')
      }).catch(function (err) { toast('创建失败：' + err.message) })
    }
  })

  /* 原型窗口控制（只在 demo 模式生效） */
  function restoreWindow() {
    document.body.classList.remove('lc-win-min', 'lc-win-closed')
    $('lcTaskbarApp').classList.remove('is-min')
  }
  if (DEMO) {
    $('lcTitlebar').addEventListener('click', function (e) {
      var button = e.target.closest('[data-win]'); if (!button) return
      var action = button.dataset.win
      if (action === 'min') { document.body.classList.add('lc-win-min'); $('lcTaskbarApp').classList.add('is-min') }
      if (action === 'max') document.body.classList.toggle('lc-win-max')
      if (action === 'close') { document.body.classList.add('lc-win-closed'); $('lcTaskbarApp').classList.add('is-min') }
    })
    $('lcTitlebar').addEventListener('dblclick', function (e) { if (!e.target.closest('button')) document.body.classList.toggle('lc-win-max') })
    $('lcTaskbarApp').addEventListener('click', restoreWindow)
    $('lcDesktopIcon').addEventListener('dblclick', restoreWindow)
    var tick = function () {
      var now = new Date()
      $('lcClockTime').textContent = clock(now.getTime())
      $('lcClockDate').textContent = now.getFullYear() + '/' + (now.getMonth() + 1) + '/' + now.getDate()
    }
    tick(); setInterval(tick, 15000)
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closePop(); closeModal() }
    if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); $('lcSearch').focus() }
  })
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.lc-pop') && !e.target.closest('.lc-tools') && ui.pop) closePop()
  })

  /* 贴着底部看的时候，窗口变矮 / 输入框长高都不该把最新一条顶出去 */
  var msgBox = $('lcMessages'), pinnedToBottom = true
  msgBox.addEventListener('scroll', function () {
    pinnedToBottom = msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight < 40
  }, { passive: true })
  if (window.ResizeObserver) {
    new ResizeObserver(function () {
      if (!pinnedToBottom) return
      // 必须显式 instant：写 scrollTop 会被 CSS 的 smooth 接管，
      // 动画途中的 scroll 事件会把自己判成「用户已经离开底部」，于是再也不回底
      msgBox.scrollTo({ top: msgBox.scrollHeight, behavior: 'instant' })
    }).observe(msgBox)
  }

  backend.start()
  window.addEventListener('beforeunload', function () { backend.dispose() })
})()
