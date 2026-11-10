/**
 * 宿主原生设置面板没有对外服务：它的开关状态住在 `sidebar.settings` 这个单席位的
 * store 里（`defineStore({ open, activeId })`），只有注册项本身能驱动。world 在
 * 开始菜单和桌面上开这个入口时，直接拿注册项的 store 调 `actions.open()`。
 *
 * 面板本体是 body 级浮层模态，world 的样式会把它钉在当前 DSH 窗口的矩形里，所以
 * 打开前必须保证 DSH 窗口可见（调用方负责还原窗口），否则它被 `visibility:hidden`
 * 藏起来，看起来像"点了没反应"。
 *
 * @param slots 宿主的 slot 服务（`entriesOfSlot` / `entries` 二者其一即可）。
 * @returns 是否真的把面板打开了；宿主改版或面板未注册时返回 false。
 */
export function openNativeSettings(slots) {
  let entries
  try {
    entries = typeof slots?.entriesOfSlot === 'function'
      ? slots.entriesOfSlot('sidebar.settings')
      : typeof slots?.entries === 'function' ? slots.entries('sidebar.settings') : []
  } catch {
    return false
  }
  for (const entry of entries || []) {
    // store 既可能是 defineStore 的句柄（要 create() 拿实例），也可能已经是实例。
    const store = entry?.store ?? entry?.options?.store
    if (!store) continue
    try {
      const instance = typeof store.create === 'function' ? store.create() : store
      const actions = instance?.actions ?? store.actions
      if (typeof actions?.open !== 'function') continue
      actions.open()
      return true
    } catch {
      continue
    }
  }
  return false
}
