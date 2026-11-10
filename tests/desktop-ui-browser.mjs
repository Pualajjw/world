import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createDesktopBridge } from '../desktop-bridge.js'
import { desktopToolDefinitions } from '../desktop-tools.js'

const root = join(import.meta.dirname, '..')
const require = createRequire(join(root, '../workflow-studio/package.json'))
const { chromium } = require('playwright-core')
let build
try { ({ build } = await import('esbuild')) }
catch { ({ build } = await import(pathToFileURL(join(root, '../pbpkg/node_modules/esbuild/lib/main.js')))) }
const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/workflow-ui-entry.jsx'], bundle: true,
  alias: { '@deepseek-ai/dsh-client-ui-primitives': join(root, 'tests/workflow-primitives-fixture.jsx') },
  platform: 'browser', format: 'iife', target: 'es2022', write: false, nodePaths: [join(root, '../workflow-studio/node_modules')], loader: { '.css': 'text' } })
const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
const bridge = createDesktopBridge()
const documents = new Map()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
try {
  await page.exposeBinding('__worldDesktopCall', (_source, operation, payload) => bridge.call(operation, payload))
  await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
  await page.exposeBinding('__worldWorkflowCall', (_source, operation, payload) => {
    if (operation === 'list') return { ok: true, value: [...documents.values()].map(item => ({ id: item.id, name: item.name, revision: item.revision })) }
    if (operation === 'catalog') return { ok: true, value: { tools: [], sessions: [], providers: [], cwd: '/workspace', agentAvailable: false } }
    if (operation === 'history') return { ok: true, value: [] }
    if (operation === 'save') { const value = { ...payload.document, revision: (payload.document.revision || 0) + 1 }; documents.set(value.id, value); return { ok: true, value } }
    if (operation === 'validate') return { ok: true, value: {} }
    return { ok: false, error: { message: `Unexpected fixture operation ${operation}` } }
  })
  await page.route('http://127.0.0.1/world-ui-fixture', route => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{width:100vw;height:100vh}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
  await page.goto('http://127.0.0.1/world-ui-fixture')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.locator('[data-world-control-button]').click()
  await page.waitForFunction(() => document.querySelector('[data-world-control-button]')?.getAttribute('aria-pressed') === 'true')
  const tools = desktopToolDefinitions({ bridge, brain: { get: async () => ({ sessionId: 'session-1' }) } })
  const exec = { agent: { session: { id: 'session-1' } } }
  const state = () => tools[0].execute({}, exec)
  let controlId = (await state()).state.control.controlId
  const pointerSvg = page.locator('[data-world-assistant-pointer] > svg')
  const pointerPosition = () => page.locator('[data-world-assistant-pointer]').evaluate(node => ({ x: Number(node.dataset.x), y: Number(node.dataset.y) }))
  const assertPointer = async point => {
    assert.deepEqual(await pointerPosition(), point)
    const svg = await pointerSvg.boundingBox()
    assert.ok(Math.abs(svg.x - point.x) < .05 && Math.abs(svg.y - point.y) < .05, 'the arrow tip uses actual viewport CSS coordinates')
  }
  await pointerSvg.waitFor()
  await assertPointer({ x: 800, y: 496 })
  const pointerStyle = await page.locator('[data-world-assistant-pointer]').evaluate(node => {
    const svg = node.querySelector('svg'), label = node.querySelector('span'), bounds = node.getBoundingClientRect(), box = label.getBoundingClientRect()
    return { width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height, color: getComputedStyle(node).color,
      stroke: getComputedStyle(svg).stroke, strokeWidth: getComputedStyle(svg).strokeWidth, pointerEvents: getComputedStyle(node).pointerEvents,
      labelX: box.x - bounds.x, labelY: box.y - bounds.y, labelFont: getComputedStyle(label).fontSize, labelPadding: getComputedStyle(label).padding,
      labelRadius: getComputedStyle(label).borderRadius, labelBackground: getComputedStyle(label).backgroundColor }
  })
  assert.deepEqual(pointerStyle, { width: 28, height: 28, color: 'rgb(76, 194, 255)', stroke: 'rgb(255, 255, 255)', strokeWidth: '1px',
    pointerEvents: 'none', labelX: 20, labelY: 20, labelFont: '12px', labelPadding: '2px 6px', labelRadius: '4px', labelBackground: 'rgba(32, 32, 34, 0.82)' })
  await page.mouse.move(50, 70)
  await assertPointer({ x: 800, y: 496 })
  assert.equal((await state()).state.control.owner, 'assistant', 'physical mouse movement remains independent')
  await page.locator('[data-world-assistant-toggle]').click()
  assert.equal(await pointerSvg.isVisible(), true, 'collapsing the card keeps the pointer visible')
  await page.evaluate(() => {
    window.__assistantPointerMotion = []
    window.addEventListener('mousemove', event => {
      if (event.isTrusted) return
      const node = document.querySelector('[data-world-assistant-pointer]')
      window.__assistantPointerMotion.push({ x: Number(node.dataset.x), y: Number(node.dataset.y), eventX: event.clientX, eventY: event.clientY })
    }, true)
  })
  const windowId = 'plugin:workflow-studio'
  const act = args => tools[1].execute({ controlId, windowId, ...args }, exec)
  const inspect = async () => (await tools[2].execute({ controlId, windowId, maxElements: 1000 }, exec)).layout.windows[0]
  const find = (layout, predicate) => { const node = layout.elements.find(predicate); assert.ok(node, 'Missing target: ' + predicate); return node }
  const operate = async (action, predicate, extra = {}) => {
    const layout = await inspect(), target = find(layout, predicate)
    const point = { x: target.visibleRect.x + target.visibleRect.width / 2, y: target.visibleRect.y + target.visibleRect.height / 2 }
    try {
      const result = await act({ action, snapshotId: layout.snapshotId, targetId: target.id, ...extra })
      if (['click', 'double_click', 'context_click', 'hover', 'scroll'].includes(action)) await assertPointer(point)
      if (['click', 'double_click', 'context_click', 'fill', 'type_text', 'select_option'].includes(action)) {
        const pulse = page.locator('.world-assistant-pulse').last()
        await pulse.waitFor()
        const kind = action === 'double_click' ? 'double' : action === 'context_click' ? 'context'
          : ['fill', 'type_text', 'select_option'].includes(action) ? 'type' : 'click'
        assert.equal(await pulse.getAttribute('data-world-assistant-pulse'), kind)
        const box = await pulse.boundingBox()
        assert.ok(Math.abs(box.x + box.width / 2 - point.x) <= 1 && Math.abs(box.y + box.height / 2 - point.y) <= 1,
          'the action pulse lands on the operated point')
      }
      return result
    }
    catch (error) { error.operation = { action, target }; throw error }
  }
  await act({ action: 'open_app', appId: windowId })
  await act({ action: 'maximize_window' })
  await page.locator('[data-testid="workflow-canvas"]').waitFor()
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length === 2)
  await page.waitForTimeout(250)
  const all = (await tools[2].execute({ controlId }, exec)).layout
  assert.ok(all.windows.some(win => win.windowId === windowId))
  await operate('fill', item => item.role === 'textbox' && item.name === '工作流名称', { text: '由 world 操作的工作流' })
  assert.equal(await page.getByLabel('工作流名称', { exact: true }).inputValue(), '由 world 操作的工作流')
  await operate('click', item => item.role === 'button' && item.name.endsWith('智能体'))
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length === 3)
  await operate('fill', item => item.role === 'textbox' && item.name === '节点名称', { text: '可操作的节点' })
  assert.equal(await page.getByLabel('节点名称', { exact: true }).inputValue(), '可操作的节点')
  await page.waitForTimeout(400)
  let layout = await inspect()
  const node = find(layout, item => item.attributes['data-id'] && item.name.includes('可操作的节点'))
  const nodeId = node.attributes['data-id']
  const before = await page.locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox()
  await act({ action: 'drag', snapshotId: layout.snapshotId, targetId: node.id,
    toX: before.x + before.width / 2 + 60, toY: before.y + before.height / 2 + 60 })
  const after = await page.locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox()
  await assertPointer({ x: before.x + before.width / 2 + 60, y: before.y + before.height / 2 + 60 })
  const motion = await page.evaluate(() => window.__assistantPointerMotion)
  assert.ok(motion.length >= 12, 'dragging paints the pointer at intermediate operation positions')
  assert.ok(motion.every(point => Math.abs(point.x - point.eventX) <= 1 && Math.abs(point.y - point.eventY) <= 1))
  assert.ok(Math.abs(after.x - before.x) > 10 || Math.abs(after.y - before.y) > 10, 'drag must move the real ReactFlow node')
  layout = await inspect()
  const source = find(layout, item => item.attributes['data-nodeid'] === 'start' && item.attributes['data-handlepos'] === 'right')
  const destination = find(layout, item => item.attributes['data-nodeid'] === nodeId && item.attributes['data-handlepos'] === 'left')
  await act({ action: 'drag', snapshotId: layout.snapshotId, targetId: source.id, toTargetId: destination.id })
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__edge').length === 2)
  await operate('press_key', item => item.name === '工作流画布', { key: 'Control+z' })
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__edge').length === 1)
  await operate('click', item => item.role === 'button' && item.name === '保存')
  await page.waitForFunction(() => document.querySelector('.wf-page [role="status"]')?.textContent.includes('已保存'))
  assert.equal([...documents.values()][0].name, '由 world 操作的工作流')
  await page.evaluate(() => {
    const controls = document.createElement('div')
    controls.style.cssText = 'position:fixed;left:250px;top:180px;width:320px;background:white;z-index:30'
    controls.innerHTML = '<input aria-label="测试文本"/><input type="checkbox" aria-label="测试勾选"/><select aria-label="测试选项"><option value="">默认</option><option value="b">选项 B</option></select><button aria-label="测试鼠标" ondblclick="this.dataset.double=1" oncontextmenu="event.preventDefault();this.dataset.context=1">鼠标</button><button disabled aria-label="已禁用控件">不可点</button><div role="region" aria-label="测试滚动" style="height:80px;overflow:auto"><p style="height:800px">长内容</p></div>'
    document.querySelector('.world-plugin-body').append(controls)
  })
  await operate('fill', item => item.role === 'textbox' && item.name === '测试文本', { text: '原始值' })
  await operate('press_key', item => item.role === 'textbox' && item.name === '测试文本', { key: 'Control+a' })
  await operate('type_text', item => item.role === 'textbox' && item.name === '测试文本', { text: '插入值' })
  assert.equal(await page.getByLabel('测试文本', { exact: true }).inputValue(), '插入值')
  await operate('press_key', item => item.role === 'textbox' && item.name === '测试文本', { key: 'Control+z' })
  assert.equal(await page.getByLabel('测试文本', { exact: true }).inputValue(), '原始值')
  await operate('click', item => item.name === '测试勾选')
  assert.equal(await page.getByLabel('测试勾选', { exact: true }).isChecked(), true)
  await operate('select_option', item => item.name === '测试选项', { value: 'b' })
  assert.equal(await page.getByLabel('测试选项', { exact: true }).inputValue(), 'b')
  await operate('select_option', item => item.name === '测试选项', { value: '' })
  await operate('double_click', item => item.name === '测试鼠标')
  await operate('context_click', item => item.name === '测试鼠标')
  assert.equal(await page.getByLabel('测试鼠标', { exact: true }).getAttribute('data-double'), '1')
  assert.equal(await page.getByLabel('测试鼠标', { exact: true }).getAttribute('data-context'), '1')
  await operate('scroll', item => item.name === '测试滚动', { deltaY: 140 })
  assert.ok(await page.getByLabel('测试滚动', { exact: true }).evaluate(node => node.scrollTop > 0))
  await assert.rejects(operate('click', item => item.name === '已禁用控件'), { code: 'WORLD_UI_DISABLED' })
  await page.evaluate(() => {
    const button = document.createElement('button'); button.setAttribute('aria-label', '边缘鼠标目标'); button.textContent = '·'
    button.style.cssText = 'position:fixed;right:0;bottom:48px;width:24px;height:24px;z-index:31'
    document.querySelector('.world-plugin-body').append(button)
  })
  await operate('click', item => item.name === '边缘鼠标目标')
  const edgeLabel = await page.locator('.world-assistant-pointer-label').boundingBox()
  assert.ok(edgeLabel.x >= 0 && edgeLabel.x + edgeLabel.width <= 1600 && edgeLabel.y >= 40 && edgeLabel.y + edgeLabel.height <= 952, 'the label stays within the desktop near its edges')
  assert.equal(await page.evaluate(() => !document.elementFromPoint(1588, 940)?.closest('[data-world-assistant-pointer-layer]')), true)
  await page.evaluate(() => {
    const modal = document.createElement('div'); modal.dataset.uiOccluder = 'true'; modal.setAttribute('role', 'dialog')
    modal.style.cssText = 'position:fixed;left:240px;top:170px;width:350px;height:160px;z-index:40;background:white'
    document.querySelector('.world-plugin-body').append(modal)
  })
  await assert.rejects(operate('fill', item => item.name === '测试文本', { text: '不应穿透对话框' }), { code: 'WORLD_UI_OCCLUDED' })
  await page.locator('[data-ui-occluder]').evaluate(node => node.remove())
  await page.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.dataset.uiFixtureFrame = 'true'
    frame.style.cssText = 'position:fixed;left:250px;top:500px;width:300px;height:100px;z-index:30'
    frame.srcdoc = '<html><body><input aria-label="frame 输入"/></body></html>'
    document.querySelector('.world-plugin-body').append(frame)
  })
  await page.frameLocator('[data-ui-fixture-frame]').getByLabel('frame 输入').waitFor()
  const framed = await inspect(), framedInput = find(framed, item => item.name === 'frame 输入')
  assert.ok(framedInput.frameId && framedInput.parentId, 'same-origin frame controls retain their layout hierarchy')
  await operate('click', item => item.name === 'frame 输入')
  await operate('fill', item => item.name === 'frame 输入', { text: '同源窗口内部输入' })
  assert.equal((await state()).state.control.owner, 'assistant', 'assistant iframe focus is not human takeover')
  assert.equal(await page.frameLocator('[data-ui-fixture-frame]').getByLabel('frame 输入').inputValue(), '同源窗口内部输入')
  await page.frameLocator('[data-ui-fixture-frame]').getByLabel('frame 输入').click()
  assert.equal((await state()).state.control.owner, 'human', 'real input in a readable frame immediately takes over')
  assert.equal(await pointerSvg.isVisible(), false, 'human input hides the assistant pointer immediately')
  await page.locator('[data-ui-fixture-frame]').evaluate(node => node.remove())
  await page.locator('[data-world-control-button]').click()
  controlId = (await state()).state.control.controlId
  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'password'; input.value = 'fixture-secret'; input.setAttribute('aria-label', '测试密码'); input.style.cssText = 'position:fixed;left:250px;top:120px'; document.querySelector('.world-plugin-body').append(input) })
  const redacted = await inspect()
  assert.equal(find(redacted, item => item.name === '测试密码').valueOmitted, true)
  assert.ok(!JSON.stringify(redacted).includes('fixture-secret'))
  const stale = await inspect(), name = find(stale, item => item.role === 'textbox' && item.name === '工作流名称')
  await page.getByLabel('工作流名称', { exact: true }).evaluate(node => { node.style.transform = 'translateX(4px)' })
  await assert.rejects(act({ action: 'fill', snapshotId: stale.snapshotId, targetId: name.id, text: '不应写入' }), { code: 'WORLD_UI_STALE' })
  await page.getByLabel('工作流名称', { exact: true }).evaluate(node => { node.style.transform = '' })
  assert.equal(await page.getByLabel('工作流名称', { exact: true }).inputValue(), '由 world 操作的工作流')
  const fresh = await inspect()
  const moving = find(fresh, item => item.attributes['data-id'] === nodeId)
  const pendingDrag = act({ action: 'drag', snapshotId: fresh.snapshotId, targetId: moving.id,
    toX: moving.rect.x + moving.rect.width / 2 + 40, toY: moving.rect.y + moving.rect.height / 2 + 40 })
  const rejected = assert.rejects(pendingDrag, { code: 'WORLD_DESKTOP_TAKEN_OVER' })
  await page.waitForTimeout(40)
  await page.locator('.world-start-button').click()
  await rejected
  assert.equal(await pointerSvg.isVisible(), false)
  const stopped = await page.locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox()
  await page.waitForTimeout(120)
  assert.deepEqual(await page.locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox(), stopped, 'cancelled drag never resumes')
  await assert.rejects(act({ action: 'click', snapshotId: fresh.snapshotId, targetId: find(fresh, item => item.role === 'button' && item.name === '保存').id }), { code: 'WORLD_DESKTOP_TAKEN_OVER' })
  assert.equal((await state()).state.control.owner, 'human')
  await page.waitForTimeout(800)
  assert.equal(await page.locator('.world-assistant-pulse').count(), 0, 'action pulses are transient and clean themselves up')
  assert.deepEqual(errors, [])
  const shots = process.env.WORLD_UI_SHOTS_DIR || join(tmpdir(), 'world-ui-input-shots')
  await mkdir(shots, { recursive: true })
  await page.screenshot({ path: join(shots, 'workflow-controlled.png'), animations: 'disabled' })
  console.log(`World UI passed with real workflow editor: ${JSON.stringify({ before, after, windows: all.windows.length, controls: fresh.elements.length, nodeId, pointerStyle, pointerMoves: motion.length })}; click, fill, node drag, port connection, keyboard undo, save, redaction, stale layout, independent pointer and takeover.`)
  await page.locator('[data-world-control-button]').click()
  controlId = (await state()).state.control.controlId
  const closingLayout = await inspect(), closingNode = find(closingLayout, item => item.attributes['data-id'] === nodeId)
  const closingDrag = act({ action: 'drag', snapshotId: closingLayout.snapshotId, targetId: closingNode.id,
    toX: closingNode.rect.x + closingNode.rect.width / 2 + 30, toY: closingNode.rect.y + closingNode.rect.height / 2 + 30 })
  const disconnected = assert.rejects(closingDrag, error => ['WORLD_DESKTOP_OFFLINE', 'WORLD_DESKTOP_TAKEN_OVER'].includes(error.code))
  await page.waitForTimeout(40)
  await page.evaluate(() => window.__worldTesting.dispose())
  await disconnected
  await page.evaluate(() => { window.__uiMovement = 0; window.addEventListener('mousemove', () => { window.__uiMovement++ }) })
  await page.mouse.move(61, 61)
  assert.ok(await page.evaluate(() => window.__uiMovement > 0), 'unloading during drag releases all input guards')
  assert.deepEqual(errors, [])
} finally { await browser.close(); bridge.dispose() }
