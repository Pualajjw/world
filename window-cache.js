import React from 'react'

// Coalesce drag updates. Flush the last committed snapshot even when a page/window
// disappears before the timer; a clean, idle window never overwrites another writer.
export function useWindowCache(save, deps) {
  const latest = React.useRef(save), pending = React.useRef(null), timer = React.useRef(0)
  const flush = React.useCallback(() => {
    clearTimeout(timer.current); timer.current = 0
    const write = pending.current; pending.current = null; write?.()
  }, [])
  const schedule = React.useCallback(() => {
    pending.current = latest.current
    if (!timer.current) timer.current = setTimeout(flush, 300)
  }, [flush])
  React.useLayoutEffect(() => { latest.current = save; schedule() }, deps)
  React.useLayoutEffect(() => {
    const hide = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush); document.addEventListener('visibilitychange', hide)
    return () => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', hide); flush() }
  }, [flush])
  return { flush, schedule }
}
