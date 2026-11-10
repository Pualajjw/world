/**
 * 有些宿主页面自己声明了子槽位，搬不动：例如「插件」管理页同时声明了 `plugins.tab`、
 * `plugins.detail.section` 等 9 个子槽位，子槽位全站只能声明一次，镜像进 world 的窗口
 * 必然撞 `already declared`。这类页面按「设置」的模式处理——不搬页面本身，只把 DSH
 * 窗口立起来，再让宿主的 layout 选中那个面板，效果是「点了就切过去」。
 *
 * 调用方负责先把 DSH 窗口还原出来：面板渲染在宿主 `main` 席位里，窗口最小化时看不到。
 */

/** 只能在 DSH 窗口里打开的宿主页面（出现在开始菜单与搜索里，不占桌面）。 */
export const HOST_PANELS = [
  { id: 'plugins', label: '插件', note: '插件管理 · 打开在 DSH 窗口里' },
]

/**
 * @param layout 宿主 `ctx.layout` 服务（`selectPanel(panelId)`）。
 * @param id 目标主面板 id。
 * @returns 是否真的切过去了；服务缺失或面板没注册时返回 false，由调用方提示。
 */
export function openHostPanel(layout, id) {
  if (!id || typeof layout?.selectPanel !== 'function') return false
  try {
    layout.selectPanel(id)
    return true
  } catch {
    return false
  }
}
