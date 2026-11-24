// A loose bounding-box tree in parent-local canvas pixels. Leaves retain only declaration
// indices; the painter still decides exact visibility, nesting and stacking as before.
const FANOUT = 16
export function indexSrwSiblings(children, styleOf) {
  if (children.length < 4 * FANOUT) return null
  let level = [], minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i < children.length; i++) {
    const style = styleOf(children[i])
    if (!style) continue
    const left = style.left || 0, top = style.top || 0
    minX = Math.min(minX, left); maxX = Math.max(maxX, left)
    minY = Math.min(minY, top); maxY = Math.max(maxY, top)
    level.push({ i, left, top, right: left + (style.width ?? Infinity), bottom: top + (style.height ?? Infinity) })
  }
  // PB declaration order is paint order, not necessarily spatial order.
  level.sort(maxY - minY >= maxX - minX ? (a, b) => a.top - b.top || a.left - b.left : (a, b) => a.left - b.left || a.top - b.top)
  let leaves = true
  do {
    const next = []
    for (let i = 0; i < level.length; i += FANOUT) {
      const batch = level.slice(i, i + FANOUT)
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
      for (const b of batch) {
        left = Math.min(left, b.left); top = Math.min(top, b.top)
        right = Math.max(right, b.right); bottom = Math.max(bottom, b.bottom)
      }
      next.push({ left, top, right, bottom, ...(leaves ? { orders: batch.map(b => b.i) } : { groups: batch }) })
    }
    level = next; leaves = false
  } while (level.length > 1)
  return level[0] ?? { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity, orders: [] }
}

// Owned by one mounted designer and one parsed model, not by the Layout tab or a
// process-wide path cache. A nested sibling set needs no tree until its parent paints.
export function createSrwIndexLookup(boundsOf) {
  const byParent = new WeakMap()
  return parent => {
    let index = byParent.get(parent)
    if (index === undefined) {
      index = indexSrwSiblings(parent.children, boundsOf)
      byParent.set(parent, index)
    }
    return index
  }
}

export function srwPaintCandidates(index, viewport, x, y) {
  const orders = []
  function visit(b) {
    if (x + b.left > viewport.right || y + b.top > viewport.bottom || x + b.right < viewport.x || y + b.bottom < viewport.y) return
    if (b.orders) orders.push(...b.orders)
    else for (const group of b.groups) visit(group)
  }
  visit(index)
  return orders.sort((a, b) => a - b)
}
