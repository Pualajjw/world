/**
 * 虚拟窗口的叠放次序。
 *
 * 窗口按「最近一次激活」排成一条从底到顶的栈：点谁谁入栈顶，最小化 / 关闭就出栈，
 * 前台交给栈里剩下的最上面那个。钉住的窗口不改变激活历史，但永远排在未钉住窗口之上，
 * 钉住之间仍按最近一次激活排序。
 */

/** 窗口 z-index 的起点；任务栏 100、开始菜单 101、宿主弹窗 1000，留足空间。 */
export const WINDOW_Z_BASE = 10

/** 把窗口提到栈顶（已经在上面的不重复搬）。 */
export function raiseWindow(stack, id) {
  if (stack.at(-1) === id) return stack
  return [...stack.filter(item => item !== id), id]
}

/** 从栈里移除一个或多个窗口，保持其余顺序不变。 */
export function dropWindows(stack, ids) {
  const gone = ids instanceof Set ? ids : new Set(Array.isArray(ids) ? ids : [ids])
  return stack.some(id => gone.has(id)) ? stack.filter(id => !gone.has(id)) : stack
}

/** 钉住的浮到上面：未钉住的保持原有先后，再拼上钉住的（同样保持原有先后）。 */
export function orderByPin(stack, pinned) {
  const set = pinned instanceof Set ? pinned : new Set(pinned || [])
  return [
    ...stack.filter(id => !set.has(id)),
    ...stack.filter(id => set.has(id)),
  ]
}

/** 某个窗口在这一帧应该拿到的 z-index；不在栈里时退回起点。 */
export function zIndexFor(stack, pinned, id) {
  const index = orderByPin(stack, pinned).indexOf(id)
  return WINDOW_Z_BASE + Math.max(0, index)
}

/** 前台窗口关闭 / 最小化后，栈里剩下的最上面那个；空了就回桌面。 */
export function topWindow(stack) {
  return stack.at(-1) || 'desktop'
}