// Configuration-space obstacles: the moving point is the robot's feet.
// Each icon blocks its whole screen footprint; the robot must walk around it instead of
// disappearing behind (or standing inside) the glyph. The footprint is widened by the
// robot's scaled half-width so its body never clips the icon's edges.
const EPS = 1e-7
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

export function iconObstacles(rects, ground, width) {
  return rects.map(rect => {
    const half = width / 2 * ground.scaleAt(rect.bottom)
    return { top: rect.top, bottom: rect.bottom, left: rect.left - half, right: rect.right + half }
  }).filter(rect => rect.bottom >= ground.horizon && rect.top <= ground.near)
}

const inside = (p, r) => p.y > r.top + EPS && p.y < r.bottom - EPS
  && p.x > r.left + EPS && p.x < r.right - EPS

/** Segment vs open rectangle (Liang–Barsky); sliding along an edge is contact, not penetration. */
function blocked(a, b, obstacles) {
  return obstacles.some(r => {
    const dx = b.x - a.x, dy = b.y - a.y
    const p = [-dx, dx, -dy, dy]
    const q = [a.x - r.left, r.right - a.x, a.y - r.top, r.bottom - a.y]
    let enter = 0, exit = 1
    for (let i = 0; i < 4; i++) {
      if (Math.abs(p[i]) < EPS) { if (q[i] <= EPS) return false; continue }
      const t = q[i] / p[i]
      if (p[i] < 0) enter = Math.max(enter, t)
      else exit = Math.min(exit, t)
      if (enter > exit - EPS) return false
    }
    return true
  })
}

export function routeAroundIcons(start, requested, obstacles, ground, width) {
  const valid = p => p.y >= ground.horizon && p.y <= ground.near
    && p.x >= width / 2 * ground.scaleAt(p.y) && p.x <= ground.width - width / 2 * ground.scaleAt(p.y)
    && !obstacles.some(r => inside(p, r))
  const corners = obstacles.flatMap(r => [
    { x: r.left, y: r.top }, { x: r.right, y: r.top },
    { x: r.left, y: r.bottom }, { x: r.right, y: r.bottom },
  ])
  let goal = requested
  if (!valid(goal)) {
    const candidates = [...corners]
    for (const r of obstacles) {
      const vertices = [{ x: r.left, y: r.top }, { x: r.right, y: r.top },
        { x: r.right, y: r.bottom }, { x: r.left, y: r.bottom }]
      vertices.forEach((a, i) => {
        const b = vertices[(i + 1) % 4]
        const dx = b.x - a.x, dy = b.y - a.y
        if (!dx && !dy) return
        const t = Math.max(0, Math.min(1, ((goal.x - a.x) * dx + (goal.y - a.y) * dy) / (dx * dx + dy * dy)))
        candidates.push({ x: a.x + dx * t, y: a.y + dy * t })
      })
    }
    goal = candidates.filter(valid).sort((a, b) => distance(a, requested) - distance(b, requested))[0]
    if (!goal) return []
  }
  const nodes = [start, goal, ...corners.filter(valid)]
  const costs = nodes.map(() => Infinity), previous = [], visited = new Set()
  costs[0] = 0
  while (visited.size < nodes.length) {
    let current = -1
    nodes.forEach((_, i) => { if (!visited.has(i) && (current < 0 || costs[i] < costs[current])) current = i })
    if (current < 0 || !Number.isFinite(costs[current])) return []
    if (current === 1) {
      const path = []
      for (let i = 1; i !== 0; i = previous[i]) path.unshift(nodes[i])
      return path
    }
    visited.add(current)
    nodes.forEach((node, i) => {
      if (visited.has(i) || blocked(nodes[current], node, obstacles)) return
      const cost = costs[current] + distance(nodes[current], node)
      if (cost < costs[i]) { costs[i] = cost; previous[i] = current }
    })
  }
  return []
}
