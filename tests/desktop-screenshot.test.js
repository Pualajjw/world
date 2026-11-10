import assert from 'node:assert/strict'
import test from 'node:test'
import { desktopToolDefinitions } from '../desktop-tools.js'

function harness(overrides = {}) {
  const commands = []
  let saved = null
  const bridge = { async request(command, options) {
    commands.push({ command, options })
    return { dataUrl: `data:image/png;base64,${Buffer.from('shot').toString('base64')}`, mediaType: 'image/png',
      width: 640, height: 360, scale: .5, region: { x: 0, y: 40, width: 1280, height: 760 },
      redacted: ['webview'], capturedAt: 1700000000000, ...overrides.shot }
  } }
  const attachments = { async saveImage(input) {
    saved = input
    return { attachmentId: 'att-shot', mediaType: input.mediaType, bytes: input.data.length, width: 640, height: 360, name: input.name }
  } }
  const tools = desktopToolDefinitions({
    bridge,
    brain: { get: async () => ({ sessionId: 'fixed' }) },
    workbench: null, editor: {}, sessions: {},
    getAttachments: () => 'attachments' in overrides ? overrides.attachments : attachments,
  })
  return { tool: tools.find(item => item.name === 'world_desktop_screenshot'), commands, saved: () => saved }
}

test('screenshot tool belongs to the fixed assistant, carries controlId and returns an image block', async () => {
  const { tool, commands, saved } = harness()
  const exec = { agent: { session: { id: 'fixed' } } }
  const value = await tool.execute({ controlId: 'control-1', desktopId: 'desk-1', maxWidth: 800, format: 'jpeg', quality: .7 }, exec)
  assert.equal(commands.length, 1)
  assert.equal(commands[0].command.action, 'screenshot')
  assert.equal(commands[0].command.controlId, 'control-1')
  assert.deepEqual(commands[0].command.actor, { sessionId: 'fixed' })
  assert.equal(commands[0].command.maxWidth, 800)
  assert.equal(commands[0].command.format, 'jpeg')
  assert.equal(commands[0].command.quality, .7)
  assert.equal(commands[0].options.desktopId, 'desk-1')
  assert.equal(saved().mediaType, 'image/png')
  assert.match(saved().name, /^world-desktop-.*\.jpe?g$/)
  assert.equal(value.image.attachmentId, 'att-shot')
  assert.deepEqual(value.redacted, ['webview'])
  const blocks = tool.output.render({}, value)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /隐私占位：webview/)
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].attachment.attachmentId, 'att-shot')
  assert.match(tool.description, /webview/)
  assert.match(tool.description, /不会截到系统桌面/)
})

test('screenshot tool rejects other sessions, missing controlId and invalid sizing without touching the desktop', async () => {
  const { tool, commands } = harness()
  await assert.rejects(tool.execute({ controlId: 'control-1' }, { agent: { session: { id: 'other' } } }), { code: 'WORLD_DESKTOP_BRAIN' })
  await assert.rejects(tool.execute({}, { agent: { session: { id: 'fixed' } } }), /controlId/)
  await assert.rejects(tool.execute({ controlId: 'control-1', maxWidth: 9999 }, { agent: { session: { id: 'fixed' } } }), /maxWidth/)
  await assert.rejects(tool.execute({ controlId: 'control-1', format: 'gif' }, { agent: { session: { id: 'fixed' } } }), /format/)
  assert.equal(commands.length, 0)
})

test('screenshot tool reports a missing attachment service and a failed attachment write', async () => {
  const missing = harness({ attachments: null })
  await assert.rejects(missing.tool.execute({ controlId: 'control-1' }, { agent: { session: { id: 'fixed' } } }), { code: 'WORLD_SHOT_ATTACHMENT' })
  const failing = harness({ attachments: { saveImage: async () => { throw new Error('too many pixels') } } })
  await assert.rejects(failing.tool.execute({ controlId: 'control-1' }, { agent: { session: { id: 'fixed' } } }), /too many pixels/)
})
