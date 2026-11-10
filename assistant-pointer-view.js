import React from 'react'

const h = React.createElement

/** Paint synchronously on action coordinates, without rerendering the desktop for each drag step. */
export function AssistantPointer({ control, pointer, name = '助手' }) {
  const layer = React.useRef(null), cursor = React.useRef(null), label = React.useRef(null)
  const lastPulse = React.useRef(0)
  React.useLayoutEffect(() => {
    const pulseNode = (point, bounds) => {
      const doc = layer.current.ownerDocument, node = doc.createElement('span')
      node.className = `world-assistant-pulse is-${point.kind}`
      node.dataset.worldAssistantPulse = point.kind
      node.setAttribute('aria-hidden', 'true')
      node.style.left = `${point.x - bounds.left}px`
      node.style.top = `${point.y - bounds.top}px`
      const remove = () => node.remove()
      layer.current.append(node)
      // Keep a short trail at most; a burst of clicks must not grow the DOM without bound.
      const pulses = layer.current.querySelectorAll('.world-assistant-pulse')
      for (let index = 0; index < pulses.length - 6; index++) pulses[index].remove()
      // animationend is the fast path; the timer also covers reduced-motion, where no animation runs.
      node.addEventListener('animationend', remove, { once: true })
      window.setTimeout(remove, 700)
    }
    const paint = () => {
      const point = pointer.getSnapshot(), grant = control.getSnapshot(), node = cursor.current
      if (!node || !layer.current) return
      const visible = point.visible && grant.owner === 'assistant' && point.controlId === grant.controlId
      node.style.display = visible ? 'block' : 'none'
      if (!visible) { lastPulse.current = point.pulse?.id || lastPulse.current; return }
      const bounds = layer.current.getBoundingClientRect()
      node.style.transform = `translate(${point.x - bounds.left}px, ${point.y - bounds.top}px)`
      node.dataset.x = String(point.x); node.dataset.y = String(point.y)
      const size = label.current.getBoundingClientRect()
      const x = point.x + 20 + size.width > bounds.right ? Math.max(bounds.left, point.x - 20 - size.width) : point.x + 20
      const y = point.y + 20 + size.height > bounds.bottom ? Math.max(bounds.top, point.y - 20 - size.height) : point.y + 20
      label.current.style.left = `${x - point.x}px`; label.current.style.top = `${y - point.y}px`
      if (point.pulse && point.pulse.id !== lastPulse.current) {
        lastPulse.current = point.pulse.id
        pulseNode(point.pulse, bounds)
      }
    }
    const offPointer = pointer.subscribe(paint), offControl = control.subscribe(() => { pointer.sync(); paint() })
    const resize = () => { pointer.resize(); paint() }
    const observer = new ResizeObserver(resize)
    observer.observe(layer.current)
    window.addEventListener('resize', resize)
    pointer.sync(); paint()
    const layerNode = layer.current
    return () => {
      offPointer(); offControl(); observer.disconnect(); window.removeEventListener('resize', resize)
      for (const node of layerNode.querySelectorAll('.world-assistant-pulse')) node.remove()
    }
  }, [control, pointer, name])
  return h('div', { ref: layer, className: 'world-assistant-pointer-layer', 'data-world-assistant-pointer-layer': true, 'aria-hidden': true },
    h('div', { ref: cursor, className: 'world-assistant-pointer', 'data-world-assistant-pointer': true, style: { display: 'none' } },
      h('svg', { width: 28, height: 28, viewBox: '0 0 28 28', fill: 'currentColor', stroke: '#fff', strokeWidth: 1, strokeLinejoin: 'round' },
        h('path', { d: 'M0 0v24l7-7 5 10 5-2.5-5-9L24 14Z' })),
      h('span', { ref: label, className: 'world-assistant-pointer-label' }, name)))
}
