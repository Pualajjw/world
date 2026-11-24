import { markdownTestCollector, markdownTestEvent } from './highlight.js'

const sameState = (a, b) => a.fence === b.fence && a.fenceLang === b.fenceLang && a.pbFence === b.pbFence &&
  a.native === b.native && a.quote === b.quote && a.blockComment === b.blockComment
export function* indexMarkdownTests(doc, cache) {
  const out = markdownTestCollector()
  let state = {}, base = 1, emitted = 0
  function* visit(node) {
    const incoming = state
    let hit = cache.get(node)
    if (node.children) {
      // Only event-free branches have summaries. They can still change the lexer
      // state (e.g. a long comment); only skip them for the same incoming state.
      if (hit && sameState(hit.incoming, incoming)) {
        state = hit.outgoing; base += node.lines
        yield
      } else {
        const before = emitted
        for (const child of node.children) yield* visit(child)
        if (emitted === before) cache.set(node, {incoming, outgoing: state})
      }
      return
    }
    if (!hit || !sameState(hit.incoming, incoming)) {
      state = { ...incoming }; const events = []; let offset = 0
      for (const line of node.iterLines()) {
        const event = markdownTestEvent(line, state)
        if (event !== null) events.push([offset, event])
        offset++
      }
      hit = { incoming, outgoing: state, events }; cache.set(node, hit)
    } else state = hit.outgoing
    for (const [offset, event] of hit.events) out.accept(event, base + offset)
    emitted += hit.events.length; base += node.lines
    yield
  }
  yield* visit(doc)
  return out.finish()
}

export function scheduleTestIndex(doc, cache, publish, delay = 0) {
  const scan = indexMarkdownTests(doc, cache)
  function step() {
    const until = performance.now() + 4
    do {
      const part = scan.next()
      if (part.done) { publish(part.value); return }
    } while (performance.now() < until)
    timer = setTimeout(step, 0)
  }
  let timer = setTimeout(step, delay)
  return () => clearTimeout(timer)
}
