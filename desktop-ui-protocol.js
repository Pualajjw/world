export const UI_ACTIONS = ['click', 'double_click', 'context_click', 'hover', 'focus_element', 'drag', 'scroll', 'type_text', 'fill', 'press_key', 'select_option']
const fail = message => { throw Object.assign(new Error(message), { code: 'WORLD_UI_INVALID' }) }
const string = (value, name, max) => {
  if (typeof value !== 'string' || !value || value.length > max) fail(`${name} 无效。`)
  return value
}

/** Shared Host/renderer validation; callers never submit selectors, scripts, or another actor. */
export function validateUiCommand(args) {
  const command = { action: args.action }
  if (args.windowId !== undefined) command.windowId = string(args.windowId, 'windowId', 160)
  if (args.action === 'layout') {
    if (args.maxElements !== undefined && (!Number.isSafeInteger(args.maxElements) || args.maxElements < 1 || args.maxElements > 1000)) fail('maxElements 必须是 1 到 1000 的整数。')
    command.maxElements = args.maxElements || 400
    return command
  }
  if (!UI_ACTIONS.includes(args.action)) fail('不支持的界面操作。')
  command.windowId = string(args.windowId, 'windowId', 160)
  command.snapshotId = string(args.snapshotId, 'snapshotId', 128)
  for (const name of ['targetId', 'toTargetId']) if (args[name] !== undefined) command[name] = string(args[name], name, 128)
  for (const name of ['x', 'y', 'toX', 'toY', 'deltaX', 'deltaY']) if (args[name] !== undefined) {
    if (typeof args[name] !== 'number' || !Number.isFinite(args[name]) || Math.abs(args[name]) > 1000000) fail(`${name} 必须是有限的坐标或滚动量。`)
    command[name] = args[name]
  }
  if ((args.x === undefined) !== (args.y === undefined) || (args.toX === undefined) !== (args.toY === undefined)) fail('坐标必须成对提供。')
  if (!command.targetId && command.x === undefined) fail('请提供布局中的 targetId 或窗口内的 x / y 坐标。')
  if (args.action === 'drag' && !command.toTargetId && command.toX === undefined) fail('drag 需要 toTargetId 或 toX / toY。')
  if (['type_text', 'fill'].includes(args.action)) {
    if (typeof args.text !== 'string' || args.text.length > 16000) fail('text 必须是不超过 16000 字的文字。')
    command.text = args.text
  }
  if (args.action === 'press_key') command.key = string(args.key, 'key', 100)
  if (args.action === 'select_option') {
    if (typeof args.value !== 'string' || args.value.length > 2000) fail('value 必须是不超过 2000 字的选项值。')
    command.value = args.value
  }
  if (args.action === 'scroll' && command.deltaX === undefined && command.deltaY === undefined) fail('scroll 需要 deltaX 或 deltaY。')
  if (args.modifiers !== undefined) {
    if (!Array.isArray(args.modifiers) || args.modifiers.length > 4 || args.modifiers.some(value => !['Control', 'Shift', 'Alt', 'Meta'].includes(value))) fail('modifiers 仅支持 Control / Shift / Alt / Meta。')
    command.modifiers = [...new Set(args.modifiers)]
  }
  return command
}
