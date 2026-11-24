import React from 'react'
import { groundOf } from './plane.js'
import { iconObstacles, routeAroundIcons } from './walker-path.js'

const h = React.createElement

const WIDTH = 84           // 角色宽度（与 svg 一致）
const HEIGHT = 148         // 角色高度（与 svg 一致）；transform-origin 在脚底
const MAX_SPEED = 300      // px/s：慢慢走过去，不是瞬移
const ACCEL = 1500         // px/s²：起步与收步的加速度，避免一顿一顿
const KEEP = 3.2           // 距目标越近越慢：want = min(MAX_SPEED, 距离 × KEEP)
const ARRIVE = 1.2         // 剩这么点距离就直接落位，不再一步步逼近
const WALK_ON = 3.2        // 还有这么多路要走就摆腿
const WALK_OFF = 1.4       // 走到这么近就回站姿（迟滞，避免阈值附近反复切换 = 闪）
const FLIP_GAP = 5         // 横向差超过它才转身（同上，避免在目标点附近反复翻面）

/**
 * 桌面上的卡通小机器人：站在透视地面上，走向「鼠标与地面的交点」。
 *
 * 指针在屏幕上，它和地面的交点就是 (clientX, clientY)：角色的脚底走到这个点，
 * 再按地面深度缩放，于是既有左右移动、也有沿地面走近／走远两种变化。
 * 指针一换位置，目标点就换，角色会重新迈步走过去（不是瞬移，也不是只在原地转头）。
 *
 * 速度用加速度限幅：起步慢慢加速、快到点自动收步，中途改目标立刻换方向；
 * 是否摆腿靠速度阈值 + 迟滞判断，不会在 0 附近来回抖。
 *
 * 体积全靠 SVG 渐变（球面高光 + 圆柱明暗）。
 * 侧视朝右：近侧肢体（x≈45~68）比远侧（x≈20~45）亮一档，形成前后层次。
 * 动画规则在 styles.css 的 3D 段落（.world-walker / .wn-*），关掉 3D 时随地面一起隐藏。
 *
 * phase 是助手当前的活动相位（thinking / executing / …），只写到 data-phase 上：
 * 姿势全交给 CSS，走路与抓窗口仍由下面的物理循环接管（它们优先级更高）。
 */
export function DeskWalker({ phase = 'idle' } = {}) {
  const hostRef = React.useRef(null)

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const wrap = host.parentElement          // 与图标共用层叠上下文，按脚底深度排序
    const face = host.querySelector('.world-walker-face')
    if (!wrap || !face) return

    const viewW = () => window.innerWidth || 1280
    const viewH = () => window.innerHeight || 800

    // 位置一律存「视口坐标」，绘制时再减掉容器的 rect：这样即使地面做视差位移，
    // 脚底也始终钉在鼠标那个点上。
    const state = { x: 0, y: 0, speed: 0, dir: -1, walking: false }
    const goal = { x: 0, y: 0 }
    let pointer = null
    let pointerDirty = false
    /** 「抓着哪扇窗」有没有算过：null（指针在桌面上）也是结果，不能每帧重算。 */
    let gripChecked = false
    let last = performance.now()
    let raf = 0
    let path = []
    let grip = null
    let targetKey = ''
    let lastTransform = ''
    let lastFace = ''
    let lastGrabbing = ''

    // 地面只在视口尺寸变化时变（任务栏高度读的是 CSS 变量，靠 resize 兜底）。
    // 逐帧读会 getComputedStyle 一次根元素，等于每帧强制一次样式计算。
    let groundCache = null, groundKey = ''
    const ground = () => {
      const key = `${viewW()}x${viewH()}`
      if (key !== groundKey) { groundKey = key; groundCache = groundOf(viewW(), viewH()) }
      return groundCache
    }

    // 图标 rect 与图层列表同理：只有当图标增删、容器尺寸或平面/景深切换时才需要重读。
    // 缓存住以后，静止与行走的每一帧都只剩一次 wrap.getBoundingClientRect。
    let layout = null
    const invalidate = () => { layout = null }
    const measure = () => {
      const icons = [...wrap.querySelectorAll('.world-desktop-icon')]
      const rects = icons.map(el => el.getBoundingClientRect())
      // 容器的位置一起量：每帧再读一次会让「写 transform → 读 rect」变成强制同步布局
      layout = { rect: wrap.getBoundingClientRect(), ground: ground(), icons, rects,
        plane: icons.map(el => Boolean(el.parentElement && el.parentElement.classList.contains('is-plane'))) }
      return layout
    }
    const plan = () => layout || measure()

    const windowTarget = () => {
      if (!pointer) return null
      // 先把可见性和 z-index 一次读出来再排序：比较器里现读会让每次指针移动
      // 都按 n log n 次 getComputedStyle 排队（八扇窗就是四十来次），而它们一帧内不会变。
      const frames = [...document.querySelectorAll('.world-window-frame, .world-vscode-window, .world-plugin-window, .world-external-window')]
        .map(el => {
          const style = getComputedStyle(el)
          return { el, z: Number(style.zIndex) || 0,
            visible: style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' }
        })
        .filter(item => item.visible)
        .sort((a, b) => b.z - a.z)
      for (const { el } of frames) {
        const r = el.getBoundingClientRect()
        if (pointer.x < r.left || pointer.x > r.right || pointer.y < r.top || pointer.y > r.bottom) continue
        const world = ground()
        // Raised arm: shoulder (61.5,62), hand (85.5,62), relative to feet (42,148).
        const slope = (1 - world.scaleAt(world.horizon)) / (world.near - world.horizon)
        const base = world.scaleAt(world.horizon) - slope * world.horizon
        const y = world.clampY((pointer.y + 86 * base) / (1 - 86 * slope))
        const scale = world.scaleAt(y)
        const choices = [{ x: r.left - 43.5 * scale, y, dir: 1, edge: r.left },
          { x: r.right + 43.5 * scale, y, dir: -1, edge: r.right }]
          .filter(p => p.x >= WIDTH / 2 * scale && p.x <= viewW() - WIDTH / 2 * scale)
        // A maximized window may leave no reachable side on the desktop.
        if (!choices.length) return { x: state.x, y: state.y, dir: state.dir, unreachable: true }
        return choices.sort((a, b) => Math.hypot(a.x - state.x, a.y - state.y) - Math.hypot(b.x - state.x, b.y - state.y))[0]
      }
      return null
    }

    const reroute = () => {
      const current = plan()
      // 平面上的图标才是障碍；宽高为 0 的（隐藏或还没量到）不算
      const rects = current.rects.filter((rect, i) => current.plane[i] && rect.width && rect.height)
      path = routeAroundIcons(state, goal, iconObstacles(rects, current.ground, WIDTH, HEIGHT), current.ground, WIDTH)
    }

    const aim = (clientX, clientY) => {
      const world = ground()
      const y = world.clampY(clientY)
      // 远处的角色更小，横向留边也要按缩放后的宽度算
      const margin = WIDTH * world.scaleAt(y) / 2 + 4
      goal.x = Math.min(Math.max(clientX, margin), viewW() - margin)
      goal.y = y
      reroute()
    }

    const reset = () => {
      const world = ground()
      state.x = viewW() * .62
      state.y = world.near - 96
      state.speed = 0
      goal.x = state.x
      goal.y = state.y
    }

    // 只写真正变了的样式：transform 每帧重写会让层合成器每帧重建，
    // z-index 每帧全区重写会连带触发整棵图标层的样式重算。
    const paint = () => {
      const current = plan()
      const scale = current.ground.scaleAt(state.y)
      const tx = state.x - current.rect.left - WIDTH / 2
      const ty = state.y - current.rect.top - HEIGHT
      const transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0) scale(${scale.toFixed(3)})`
      if (transform !== lastTransform) { lastTransform = transform; host.style.transform = transform }
      const faceTransform = `scaleX(${state.dir})`
      if (faceTransform !== lastFace) { lastFace = faceTransform; face.style.transform = faceTransform }
      if (document.body.dataset.worldDepth !== 'on') return
      const layers = current.icons.map((el, i) => ({ el, y: current.rects[i].bottom }))
      layers.push({ el: host, y: state.y })
      // 同一深度时它站在图标后面：绕行终点正好是图标底边，平手就压住图标的字是没道理的。
      layers.sort((a, b) => (a.y - b.y) || (a.el === host ? -1 : b.el === host ? 1 : 0))
      layers.forEach(({ el }, i) => { const z = String(i + 1); if (el.style.zIndex !== z) el.style.zIndex = z })
    }

    const step = now => {
      raf = 0
      const dt = Math.min(Math.max((now - last) / 1000, 0), .05)
      last = now
      if (!dt) { raf = window.requestAnimationFrame(step); return }

      // 只有指针真的动过才重新找「抓着哪扇窗」：每找一次要对每个窗口做三次
      // getComputedStyle，而上一帧刚写过 transform，这一次读就是强制同步样式计算——
      // 走动时每帧一次，实测 2 秒里 121 次样式重算。窗口移动必然伴随指针移动，不会漏；
      // 「指针不在窗口上」也是有效结果，不能因为拿到 null 就每帧重找。
      const dirty = pointerDirty || !gripChecked
      pointerDirty = false
      gripChecked = true
      const nextGrip = dirty ? windowTarget() : grip
      const key = nextGrip ? `${nextGrip.x},${nextGrip.y},${nextGrip.dir}` : ''
      if (key !== targetKey) {
        targetKey = key
        grip = nextGrip
        if (grip) { goal.x = grip.x; goal.y = grip.y; reroute() }
        else if (pointer) aim(pointer.x, pointer.y)
      } else if (dirty && pointer && !grip) {
        aim(pointer.x, pointer.y)
      }

      const target = path[0] || state
      const dx = target.x - state.x
      const dy = target.y - state.y
      const dist = Math.hypot(dx, dy)

      if (dist < ARRIVE) {
        // 最后一点距离直接落位，免得在目标附近无限逼近（那样会一直“走”却不动）
        state.x = target.x
        state.y = target.y
        if (path.length) path.shift()
        state.speed = 0
      } else {
        const want = Math.min(MAX_SPEED, dist * KEEP)
        state.speed = want > state.speed
          ? Math.min(want, state.speed + ACCEL * dt)
          : Math.max(want, state.speed - ACCEL * 2.4 * dt)
        const travel = Math.min(dist, state.speed * dt)
        state.x += dx / dist * travel
        state.y += dy / dist * travel
      }

      if (dx > FLIP_GAP) state.dir = 1
      else if (dx < -FLIP_GAP) state.dir = -1

      // 摆不摆腿看「还有没有路要走」，不看瞬时速度：速度在收步时会一路掉到 0，
      // 拿阈值判会在终点附近反复开关（= 一顿一顿）。迟滞再兜一层。
      const remaining = path.reduce((sum, point, i) => {
        const from = i ? path[i - 1] : state
        return sum + Math.hypot(point.x - from.x, point.y - from.y)
      }, 0)
      const walking = state.walking ? remaining > WALK_OFF : remaining > WALK_ON
      const grabbing = grip && !grip.unreachable && !walking && Math.hypot(state.x - grip.x, state.y - grip.y) < ARRIVE
      const grabbingValue = grabbing ? 'on' : 'off'
      if (grabbingValue !== lastGrabbing) { lastGrabbing = grabbingValue; host.dataset.grabbing = grabbingValue }
      if (grabbing) state.dir = grip.dir
      if (walking !== state.walking) {
        state.walking = walking
        host.dataset.walking = walking ? 'on' : 'off'
      }
      paint()

      // 站定了就停掉循环：没有目标、指针也没动时，桌面上一帧都不用算。
      // 指针一动、图标/窗口变化或视口改变都会 wake()，所以不会漏掉响应。
      if (path.length || dirty) raf = window.requestAnimationFrame(step)
    }

    const wake = () => {
      if (raf) return
      last = performance.now()
      raf = window.requestAnimationFrame(step)
    }

    // 指针只做记录：真正的选目标、重排路线都交给下一帧的 step，
    // 免得 pointermove 每秒几百次时每次都跑一遍 windowTarget（每个窗口三次 getComputedStyle）。
    const onMove = event => {
      pointer = { x: event.clientX, y: event.clientY }
      pointerDirty = true
      wake()
    }

    const onResize = () => {
      invalidate()
      gripChecked = false
      if (pointer) aim(pointer.x, pointer.y)
      else aim(goal.x, goal.y)
      wake()
    }

    // 图标增删、3D/平面切换、窗口开关都会改变障碍与图层顺序：缓存作废并立刻重排。
    const iconWatcher = new MutationObserver(() => { invalidate(); wake() })
    iconWatcher.observe(wrap, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    const depthWatcher = new MutationObserver(() => { invalidate(); wake() })
    depthWatcher.observe(document.body, { attributes: true, attributeFilter: ['data-world-depth'] })
    // 容器自己的位置/尺寸变了（宿主侧栏收起、任务栏换高度都不经过 window resize）：
    // 缓存的 rect 与图标矩形一起作废，否则它会在错位的地方走。
    const sizeWatcher = new ResizeObserver(() => { invalidate(); wake() })
    sizeWatcher.observe(wrap)
    // 右键菜单里的「整理图标」只写 style.left/top，既不改 class 也不增删节点，
    // 上面几个观察器都看不见。按一次指针就把缓存作废一次（每个手势多量一遍图标，可忽略）。
    const onPointerDown = () => { invalidate(); gripChecked = false; wake() }
    window.addEventListener('pointerdown', onPointerDown, { passive: true })

    reset()
    paint()
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerover', onMove, { passive: true })
    window.addEventListener('resize', onResize)
    wake()
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerover', onMove)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointerdown', onPointerDown)
      iconWatcher.disconnect()
      depthWatcher.disconnect()
      sizeWatcher.disconnect()
      if (raf) window.cancelAnimationFrame(raf)
    }
  }, [])

  return h('div', { className: 'world-walker', ref: hostRef, 'data-walking': 'off', 'data-grabbing': 'off',
    'data-phase': phase, 'aria-hidden': true },
    h('i', { className: 'world-walker-face' },
      h('i', { className: 'world-walker-shadow' }),
      h('svg', { className: 'world-walker-body', width: 84, height: 148, viewBox: '0 0 84 148', fill: 'none' },
        h('defs', null,
          h('radialGradient', { id: 'worldWalkerHead', cx: '33%', cy: '24%', r: '80%' },
            h('stop', { offset: '0', stopColor: '#ffffff' }),
            h('stop', { offset: '.5', stopColor: '#dceaf8' }),
            h('stop', { offset: '1', stopColor: '#8aa6c4' })),
          h('linearGradient', { id: 'worldWalkerShell', x1: '16%', y1: '0%', x2: '90%', y2: '100%' },
            h('stop', { offset: '0', stopColor: '#f6fbff' }),
            h('stop', { offset: '.44', stopColor: '#bdd6ec' }),
            h('stop', { offset: '1', stopColor: '#6b8aab' })),
          h('linearGradient', { id: 'worldWalkerLimbNear', x1: '0%', y1: '0%', x2: '100%', y2: '10%' },
            h('stop', { offset: '0', stopColor: '#a7c3dd' }),
            h('stop', { offset: '.40', stopColor: '#f0f8ff' }),
            h('stop', { offset: '1', stopColor: '#7e9cb9' })),
          h('linearGradient', { id: 'worldWalkerLimbFar', x1: '0%', y1: '0%', x2: '100%', y2: '10%' },
            h('stop', { offset: '0', stopColor: '#4c6885' }),
            h('stop', { offset: '.45', stopColor: '#849fbb' }),
            h('stop', { offset: '1', stopColor: '#3f5a74' })),
          h('linearGradient', { id: 'worldWalkerVisor', x1: '10%', y1: '0%', x2: '90%', y2: '100%' },
            h('stop', { offset: '0', stopColor: '#1d5278' }),
            h('stop', { offset: '.55', stopColor: '#0d2c44' }),
            h('stop', { offset: '1', stopColor: '#061a2a' }))),

        // ── 远侧肢体：先画，被躯干压住，颜色暗一档
        h('g', { className: 'wn-limb-far' },
          h('g', { className: 'wn-arm wn-arm-b' },
            h('rect', { x: 23, y: 61, width: 9, height: 24, rx: 4.5, fill: 'url(#worldWalkerLimbFar)' }),
            h('circle', { cx: 27.5, cy: 62, r: 5, fill: '#6f8ba7' }),
            h('circle', { cx: 27.5, cy: 86, r: 4.8, fill: '#5a7693' })),
          h('g', { className: 'wn-leg wn-leg-b' },
            h('rect', { x: 31, y: 92, width: 13, height: 38, rx: 6.5, fill: 'url(#worldWalkerLimbFar)' }),
            h('g', { className: 'wn-foot wn-foot-b' },
              h('rect', { x: 27, y: 126, width: 21, height: 11, rx: 5.5, fill: '#4b6782' })))),

        // ── 躯干分组：走路时整体轻微起伏
        h('g', { className: 'wn-torso' },
          h('rect', { x: 20, y: 60, width: 13, height: 28, rx: 6, fill: '#3d5c79' }),
          h('rect', { x: 27, y: 52, width: 36, height: 46, rx: 15, fill: 'url(#worldWalkerShell)' }),
          h('rect', { x: 27, y: 52, width: 36, height: 46, rx: 15, fill: 'none', stroke: 'rgba(255,255,255,.55)' }),
          h('circle', { cx: 45, cy: 74, r: 5.6, fill: '#0f3a58' }),
          h('circle', { className: 'wn-core', cx: 45, cy: 74, r: 3.4, fill: '#6fe3ff' }),
          h('circle', { cx: 45, cy: 74, r: 3.4, fill: 'none', stroke: 'rgba(160,240,255,.75)', strokeWidth: 1.4 }),

          // 头
          h('g', { className: 'wn-head' },
            h('line', { x1: 44, y1: 12, x2: 44, y2: 5, stroke: '#8ba9c6', strokeWidth: 2.4, strokeLinecap: 'round' }),
            h('circle', { className: 'wn-lamp', cx: 44, cy: 5, r: 3.2, fill: '#7fe6ff' }),
            h('circle', { cx: 44, cy: 30, r: 19.5, fill: 'url(#worldWalkerHead)' }),
            h('rect', { x: 32, y: 21.5, width: 28, height: 18.5, rx: 9.2, fill: 'url(#worldWalkerVisor)' }),
            h('rect', { x: 35, y: 24, width: 9.5, height: 5.5, rx: 2.8, fill: 'rgba(255,255,255,.30)' }),
            h('circle', { className: 'wn-eye', cx: 41, cy: 30.8, r: 2.6, fill: '#8cf0ff' }),
            h('circle', { className: 'wn-eye', cx: 49.5, cy: 30.8, r: 2.6, fill: '#8cf0ff' }))),

        // ── 近侧肢体：最后画，最亮；手臂贴着躯干侧面，不横出来
        h('g', { className: 'wn-limb-near' },
          h('g', { className: 'wn-arm wn-arm-a' },
            h('rect', { x: 57, y: 60, width: 9, height: 25, rx: 4.5, fill: 'url(#worldWalkerShell)' }),
            h('circle', { cx: 61.5, cy: 62, r: 5.2, fill: '#e4f0fb' }),
            h('circle', { cx: 61.5, cy: 86, r: 5, fill: '#cfdfee' })),
          h('g', { className: 'wn-leg wn-leg-a' },
            h('rect', { x: 45, y: 92, width: 13, height: 38, rx: 6.5, fill: 'url(#worldWalkerLimbNear)' }),
            h('g', { className: 'wn-foot wn-foot-a' },
              h('rect', { x: 41, y: 126, width: 21, height: 11, rx: 5.5, fill: '#e9f3fd' }),
              h('rect', { x: 41, y: 131, width: 21, height: 5, rx: 2.5, fill: '#9bb7cf' })))),

        // ── 相位点缀：默认为 0 不透明度，只有对应活动相位才现身（见 styles.css）
        // 脚下一圈工作环：正在调工具时才亮，像它在屋里忙
        h('ellipse', { className: 'wn-workring', cx: 42, cy: 142, rx: 32, ry: 8, fill: 'none',
          stroke: '#7fe6ff', strokeWidth: 1.3 }),
        // 头顶三个上浮的点：思考
        h('g', { className: 'wn-bubble' },
          h('circle', { className: 'wn-dot wn-dot-a', cx: 56, cy: 14, r: 3.1, fill: '#8cf0ff' }),
          h('circle', { className: 'wn-dot wn-dot-b', cx: 61.5, cy: 8.5, r: 2.5, fill: '#8cf0ff' }),
          h('circle', { className: 'wn-dot wn-dot-c', cx: 66.5, cy: 3.5, r: 1.9, fill: '#8cf0ff' })),
        // 手边的敲击火花：执行工具
        h('g', { className: 'wn-spark', stroke: '#bff3ff', strokeWidth: 1.7, strokeLinecap: 'round' },
          h('path', { className: 'wn-spark-a', d: 'M70 86 l5.5 -3.5' }),
          h('path', { className: 'wn-spark-b', d: 'M71.5 92 l6.5 0' }),
          h('path', { className: 'wn-spark-c', d: 'M70 98 l5.5 3.5' })),
        // 打盹的 Z：暂停 / 停下
        h('g', { className: 'wn-zzz', fill: 'none', stroke: '#cfe0ee', strokeWidth: 2.1,
          strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { className: 'wn-z wn-z-a', d: 'M52 -15 h13 l-13 13 h13' })))))
}
