/**
 * 手机软键盘：把「键盘吃掉的高度」压成一次提交，交给 CSS 变量 --world-keyboard。
 *
 * 为什么不直接跟着 visualViewport 写：
 *
 * 1. 键盘弹起是一段 200~350ms 的动画，动画期间 visualViewport 每帧都 resize 一次。
 *    一个事件写一次变量，窗口就一帧一个高度——看着就是「整个界面在跳」。
 * 2. 我们缩窗口会让浏览器重新算一次「光标得露出来」，它可能顺手把页面滚一下，
 *    于是 offsetTop 变、算出来的高度也变，两边互相追，抖得更厉害。
 *
 * 所以这里只干两件事：
 *   - 合并事件流：中间的每一帧只记候选值，静下来 120ms 再提交一次（最长等 420ms，
 *     一直有事件也不会永远不落地）；
 *   - 给阈值：低于 120px 不算键盘（那是地址栏收起、滚动回弹），已经开过一次的降到
 *     60px 才算收起，免得在阈值附近来回闪。
 *
 * 纯逻辑，不碰 DOM：`createKeyboardSettle` 的 clock 可注入，`node --test` 直接测。
 */

/** 认成键盘的最小高度：手机地址栏收起只有 ~50px，键盘不会这么矮。 */
export const KEYBOARD_MIN = 120
/** 键盘已经开过之后，降到这个高度以下才算收起（迟滞，避免在 120 附近闪）。 */
export const KEYBOARD_RELEASE_MIN = 60
/** 静多久算「键盘动画结束了」。 */
export const KEYBOARD_QUIET_MS = 120
/** 事件一直不断时的兜底等待：到点就先落地，别让界面一直缩着或一直不缩。 */
export const KEYBOARD_MAX_MS = 420

/**
 * 原始重叠高度 → 这一次认不认它是键盘。
 * @param {number} overlap 视口被吃掉的高度（px）
 * @param {number} committed 当前已经提交的高度
 */
export function normalizeOverlap(overlap, committed = 0) {
  const value = Math.round(Number(overlap) || 0)
  if (value <= 0) return 0
  const floor = committed > 0 ? KEYBOARD_RELEASE_MIN : KEYBOARD_MIN
  return value >= floor ? value : 0
}

const realClock = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: id => clearTimeout(id),
}

/**
 * 事件流 → 一次提交。
 * @param {{ commit:(height:number)=>void, quiet?:number, max?:number, clock?:object }} options
 */
export function createKeyboardSettle({ commit, quiet = KEYBOARD_QUIET_MS, max = KEYBOARD_MAX_MS, clock = realClock } = {}) {
  let committed = 0
  let pending = 0
  let timer = null
  // 不能用 0 当「还没开始」：t=0 那一帧 push 进来时，0 是假值，会被当成新的开始
  let burst = null

  const stop = () => {
    if (timer === null) return
    clock.clear(timer)
    timer = null
  }
  const flush = () => {
    stop()
    burst = null
    if (pending === committed) return
    committed = pending
    commit(committed)
  }

  return {
    /** 收到一帧原始重叠高度。返回 true 表示这一帧直接落地了。 */
    push(overlap) {
      pending = normalizeOverlap(overlap, committed)
      if (pending === committed) {
        stop()
        burst = null
        return false
      }
      const now = clock.now()
      if (burst === null) burst = now
      stop()
      // 事件太密（一直在 resize / scroll）：别无限等，先落一版，下一帧重新攒。
      if (now - burst >= max) {
        flush()
        return true
      }
      timer = clock.set(flush, quiet)
      return false
    },
    flush,
    /** 已经提交的高度（px）。 */
    get value() { return committed },
    /** 没有待提交的值。 */
    get settled() { return timer === null },
  }
}
