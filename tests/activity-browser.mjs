import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopBridge } from '../desktop-bridge.js'
import { createAssistantActivity } from '../assistant-activity.js'

/** Real Host activity tracking and long-poll transport drive the existing on-screen card. */
export async function checkAssistantActivity(browser, bundleText) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const handlers = new Map()
  const agent = { id: 'session-1', status: 'idle' }
  const brain = { peek: () => ({ sessionId: 'session-1' }), get: async () => ({ sessionId: 'session-1' }) }
  const ctx = { agents: { get: () => agent }, on(name, listener) {
    const set = handlers.get(name) || new Set(); set.add(listener); handlers.set(name, set)
    return () => set.delete(listener)
  } }
  const emit = (name, ...args) => [...(handlers.get(name) || [])].map(listener => listener(...args))
  const event = (type, data = {}) => emit('session/event', { id: 'session-1' }, { type, data })
  const bridge = createDesktopBridge()
  const workbenchState = { mode: 'workbench', enabled: true, running: false, paused: false, summary: '本轮任务已完成。' }
  const workbenchListeners = new Set()
  const workbench = {
    getState: () => workbenchState,
    subscribe(listener) { workbenchListeners.add(listener); return () => workbenchListeners.delete(listener) },
    setState(next) { Object.assign(workbenchState, next); for (const listener of workbenchListeners) listener() },
    call(operation) {
      if (operation === 'pause') workbench.setState({ paused: true })
      if (operation === 'resume') workbench.setState({ paused: false })
      return { ...workbenchState }
    },
  }
  const activity = createAssistantActivity(ctx, { brain, bridge, workbench })
  try {
    await activity.ready
    await page.exposeBinding('__worldDesktopCall', (_source, operation, payload) => bridge.call(operation, payload))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.exposeBinding('__worldWorkbenchCall', (_source, operation) => workbench.call(operation))
    await page.setContent('<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>#root{position:relative;width:100vw;height:100vh}.app-frame{position:relative;width:100%;height:100%;padding-top:40px;box-sizing:border-box}#host-ui{position:absolute;inset:40px 0 0;background:#262626}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>')
    await page.addScriptTag({ content: bundleText })
    await page.waitForFunction(() => document.body.dataset.worldWindow === 'closed')
    await page.locator('[data-world-control-button]').click()
    const status = page.locator('[data-world-assistant-activity]')
    // 0.2.58 · 等模型时不能像卡死：卡片状态要能被样式读到（相位类名 + 三段动画）。
    const motion = () => page.locator('.world-control-card').evaluate(node => {
      const read = selector => getComputedStyle(node.querySelector(selector))
      return { phase: node.dataset.worldAssistantPhase,
        orbit: read('.world-presence-orbit').animationDuration,
        orbitName: read('.world-presence-orbit').animationName,
        ping: read('.world-presence-ping').animationName,
        shimmer: read('.world-control-activity p').animationName }
    })
    const waitPhase = phase => page.waitForFunction(value => document.querySelector('[data-world-assistant-activity]')?.dataset.worldAssistantActivity === value, phase)
    // 0.2.59 · 桌上的小机器人跟着相位做动作：相位要真的传到 walker 上，姿势要真的不一样
    const walkerPhase = phase => page.waitForFunction(value =>
      document.querySelector('.world-walker')?.dataset.phase === value, phase)
    const walkerPose = () => page.locator('.world-walker').evaluate(node => {
      const head = getComputedStyle(node.querySelector('.wn-head')).transform
      const arm = getComputedStyle(node.querySelector('.wn-arm-a')).transform
      return { phase: node.dataset.phase, head, arm }
    })
    await waitPhase('starting')
    assert.match(await status.innerText(), /正在启动/)
    agent.status = 'running'
    emit('agent/status', { agent, status: 'running' })
    event('turn/start', { turn: 1 })
    event('step/start', { turn: 1, step: 1 })
    await waitPhase('thinking')
    await walkerPhase('thinking')
    assert.match(await status.innerText(), /正在思考/)
    assert.deepEqual(await motion(), { phase: 'thinking', orbit: '4.4s', orbitName: 'world-presence-orbit',
      ping: 'world-presence-ping', shimmer: 'world-status-shimmer' })
    event('user/message', { id: 'public-user', source: { kind: 'user' }, content: [{ type: 'text', text: '请检查工作台的浏览器。' }] })
    emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'stream-1', turn: 1, step: 1 } })
    emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'stream-1', index: 0,
      chunk: { type: 'reasoning-delta', index: 0, text: 'hidden reasoning' } } })
    emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'stream-1', index: 1,
      chunk: { type: 'text-delta', index: 1, text: '正在接收会话通知，' } } })
    emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'stream-1', index: 2,
      chunk: { type: 'text-delta', index: 1, text: '回复会实时出现在这里。' } } })
    event('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '正在接收会话通知，回复会实时出现在这里。' }] } })
    await page.locator('[data-fixture-variant="embedded"]').waitFor()
    assert.equal(await page.locator('[data-world-session-content]').count(), 0, 'native Conversation replaces the public-summary projection')
    const timing = page.locator('[data-world-assistant-timing]')
    const firstTime = await timing.innerText()
    await page.waitForFunction(previous => document.querySelector('[data-world-assistant-timing]')?.innerText !== previous,
      firstTime, { timeout: 3000 })
    assert.match(await timing.innerText(), /已运行.*秒.*最近活动/)
    if (process.env.WORLD_ACTIVITY_SHOTS_DIR) {
      await mkdir(process.env.WORLD_ACTIVITY_SHOTS_DIR, { recursive: true })
      await page.screenshot({ path: join(process.env.WORLD_ACTIVITY_SHOTS_DIR, 'assistant-thinking.png'), animations: 'disabled' })
    }
    // 动画本身没法被 animations:'disabled' 拍到（会被快进到末帧），所以把它停在指定毫秒再拍。
    if (process.env.WORLD_MOTION_SHOTS_DIR) {
      await mkdir(process.env.WORLD_MOTION_SHOTS_DIR, { recursive: true })
      for (const [name, at] of [['thinking-a', 900], ['thinking-b', 2100]]) {
        await page.evaluate(time => {
          for (const animation of document.getAnimations()) { animation.currentTime = time; animation.pause() }
        }, at)
        await page.screenshot({ path: join(process.env.WORLD_MOTION_SHOTS_DIR, `${name}.png`) })
      }
      await page.evaluate(() => { for (const animation of document.getAnimations()) animation.play() })
    }
    // 逐帧把动画时间轴推到指定毫秒再拍，用来拼一段能直接看的动图（异步网络不会影响帧的间隔）。
    if (process.env.WORLD_MOTION_FRAMES_DIR) {
      const dir = process.env.WORLD_MOTION_FRAMES_DIR
      await mkdir(dir, { recursive: true })
      const box = await page.locator('.world-control-card').boundingBox()
      const clip = { x: Math.max(0, Math.round(box.x) - 18), y: Math.max(0, Math.round(box.y) - 18),
        width: Math.round(box.width) + 36, height: Math.round(box.height) + 54 }
      for (let frame = 0; frame < 40; frame++) {
        await page.evaluate(time => {
          for (const animation of document.getAnimations()) { animation.currentTime = time; animation.pause() }
        }, frame * 80)
        await page.screenshot({ path: join(dir, `frame-${String(frame).padStart(2, '0')}.png`), clip })
      }
      await page.evaluate(() => { for (const animation of document.getAnimations()) animation.play() })
    }
    // These are Host signals; no world_desktop_action / explain call is made by a model.
    event('tool/call', { callId: 'tool-1', name: 'pwsh', arguments: 'hidden tool arguments' })
    await waitPhase('executing')
    await walkerPhase('executing')
    const typingPose = await walkerPose()
    assert.match(await status.innerText(), /pwsh/)
    event('approval/asked', { id: 'approval-1' })
    await waitPhase('waiting')
    await walkerPhase('waiting')
    assert.match(await status.innerText(), /等你答一句/)
    const waitingMotion = await motion()
    assert.equal(waitingMotion.ping, 'none', '轮到你了就安静下来：灯光不再打声呐')
    assert.equal(waitingMotion.shimmer, 'none', '等待确认时状态文字不该还在流动')
    if (process.env.WORLD_ACTIVITY_SHOTS_DIR)
      await page.screenshot({ path: join(process.env.WORLD_ACTIVITY_SHOTS_DIR, 'assistant-waiting.png'), animations: 'disabled' })
    event('approval/decided', { id: 'approval-1' })
    event('tool/result', { message: { toolCallId: 'tool-1', content: 'hidden tool result' } })
    await waitPhase('thinking')
    event('turn/end', { reason: { kind: 'completed' } })
    agent.status = 'idle'
    emit('agent/status', { agent, status: 'idle' })
    await waitPhase('idle')
    await walkerPhase('idle')
    const idlePose = await walkerPose()
    assert.notEqual(idlePose.head, typingPose.head, '空闲与执行工具的姿势必须不同')
    assert.match(await status.innerText(), /我在/)
    // 0.2.56 · 自动推进刹车：暂停只停新轮次，不撤桌面授权，卡片与活动行同步
    const pauseButton = page.locator('[data-world-assistant-pause]')
    assert.equal(await pauseButton.getAttribute('data-world-assistant-pause'), 'running')
    await pauseButton.click()
    await waitPhase('paused')
    await walkerPhase('paused')
    assert.notEqual((await walkerPose()).head, idlePose.head, '暂停时机器人要垂头，不能还站着发呆')
    assert.match(await status.innerText(), /先停一下/)
    assert.equal((await motion()).orbit, '34s', 'paused slows the satellite to a stop-drift')
    assert.equal(await pauseButton.getAttribute('data-world-assistant-pause'), 'paused')
    assert.equal(await pauseButton.innerText(), '继续')
    assert.match(await page.locator('.world-control-hint').innerText(), /停在这儿了/)
    assert.equal(await page.locator('[data-world-control-button]').getAttribute('aria-pressed'), 'true', 'pausing keeps the desktop grant')
    if (process.env.WORLD_ACTIVITY_SHOTS_DIR)
      await page.screenshot({ path: join(process.env.WORLD_ACTIVITY_SHOTS_DIR, 'assistant-paused.png'), animations: 'disabled' })
    await pauseButton.click()
    await waitPhase('idle')
    assert.equal(await pauseButton.getAttribute('data-world-assistant-pause'), 'running')
    assert.equal(await pauseButton.innerText(), '暂停')
    if (process.env.WORLD_ACTIVITY_SHOTS_DIR)
      await page.screenshot({ path: join(process.env.WORLD_ACTIVITY_SHOTS_DIR, 'assistant-public-reply.png'), animations: 'disabled' })
    for (let index = 0; index < 10; index++) event('user/message', { id: `log-${index}`, source: { kind: 'user' },
      content: [{ type: 'text', text: `通知 ${index}\n${'会话内容\n'.repeat(8)}` }] })
    await page.locator('.world-assistant-conversation').hover()
    await page.mouse.wheel(0, -150)
    assert.equal(await page.locator('[data-world-control-button]').getAttribute('aria-pressed'), 'true', 'reading the panel does not interrupt the assistant')
    if (process.env.WORLD_ACTIVITY_SHOTS_DIR)
      await page.screenshot({ path: join(process.env.WORLD_ACTIVITY_SHOTS_DIR, 'assistant-live-session.png'), animations: 'disabled' })
    assert.ok(!(await page.locator('[data-world-control-overlay]').innerText()).includes('hidden'))
    event('turn/end', { reason: { kind: 'error' } })
    await waitPhase('error')
    await walkerPhase('error')
    assert.match(await status.innerText(), /出错了/)
    await page.locator('[data-world-control-button]').click()
    assert.equal(await page.locator('[data-world-control-overlay]').count(), 0)
    await page.locator('[data-world-control-button]').click()
    await page.waitForFunction(() => document.querySelector('[data-world-control-button]')?.getAttribute('aria-pressed') === 'true')
    const connection = await page.evaluate(() => window.__worldTesting.calls.filter(call => call.method === 'world-desktop/poll').at(-1).payload)
    await bridge.call('disconnect', connection)
    await page.waitForFunction(() => document.querySelector('[data-world-control-button]')?.getAttribute('aria-pressed') === 'false')
    assert.match(await page.locator('.world-toast').innerText(), /连接已断开/)
    await page.evaluate(() => window.__worldTesting.dispose())
    console.log('Assistant activity passed: Host thinking/tools/approval/idle/error visible without model explain calls; elapsed text ticks and takeover still works.')
  } finally {
    activity.dispose()
    bridge.dispose()
    await page.close()
  }
}
