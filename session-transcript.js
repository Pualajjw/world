const LIMIT = 8
const TEXT_LIMIT = 16000
const textOf = message => (Array.isArray(message?.content) ? message.content : [])
  .filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
const assistantId = data => `assistant:${data.turn}:${data.step}`

/** A bounded public projection; reasoning, context prompts and tool payloads never enter it. */
export function createSessionTranscript() {
  let messages = [], tools = [], attempt = null
  const put = entry => {
    const existing = messages.findIndex(row => row.id === entry.id)
    const row = { ...entry, text: entry.text.slice(0, TEXT_LIMIT), truncated: entry.text.length > TEXT_LIMIT }
    messages = existing < 0 ? [...messages, row].slice(-LIMIT) : messages.map((item, index) => index === existing ? row : item)
  }
  return {
    snapshot: () => ({ messages: structuredClone(messages), toolEvents: structuredClone(tools) }),
    event(event) {
      const data = event.data || {}, time = Number(event.time) || Date.now()
      if (event.type === 'user/message') {
        if (data.source?.kind && data.source.kind !== 'user') return false
        if (String(data.source?.rpcId || '').startsWith('world-workbench-')) return false
        const text = textOf(data)
        if (!text) return false
        put({ id: String(data.id || `user:${event.seq ?? time}`), role: 'user', text, time, streaming: false })
      } else if (event.type === 'assistant/message') {
        const id = assistantId(data), text = textOf(data.message)
        if (attempt?.id === id) attempt = null
        if (!text) { messages = messages.filter(row => row.id !== id); return true }
        put({ id, role: 'assistant', text, time, streaming: false })
      } else if (event.type === 'tool/call') {
        tools = [...tools.filter(row => row.id !== data.callId), { id: data.callId,
          name: String(data.name || '工具').slice(0, 80), state: 'running', time }].slice(-LIMIT)
      } else if (event.type === 'tool/result') {
        const id = data.message?.toolCallId || data.message?.callId
        tools = tools.map(row => row.id === id ? { ...row, state: data.message?.isError ? 'error' : 'completed', time } : row)
      } else return false
      return true
    },
    stream(frame) {
      if (frame.type === 'start') {
        attempt = { attemptId: frame.attemptId, id: assistantId(frame), parts: new Map(), time: Date.now(), nextIndex: 0 }
        return false
      }
      if (!attempt || frame.attemptId !== attempt.attemptId) return false
      if (frame.type === 'end') {
        if (frame.outcome?.kind === 'abandoned') messages = messages.filter(row => row.id !== attempt.id)
        else messages = messages.map(row => row.id === attempt.id ? { ...row, streaming: false } : row)
        attempt = null
        return true
      }
      const chunk = frame.chunk
      if (frame.type !== 'chunk' || !chunk) return false
      if (Number.isSafeInteger(frame.index)) {
        if (frame.index < attempt.nextIndex) return false
        attempt.nextIndex = frame.index + 1
      }
      if (chunk.type === 'text-delta') {
        const previous = attempt.parts.get(chunk.index) || ''
        attempt.parts.set(chunk.index, (previous + String(chunk.text || '')).slice(0, TEXT_LIMIT + 1))
      } else if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
        attempt.parts.set(chunk.index, String(chunk.block.text || '').slice(0, TEXT_LIMIT + 1))
      } else return false
      const text = [...attempt.parts.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join('\n')
      put({ id: attempt.id, role: 'assistant', text, time: attempt.time, streaming: true })
      return true
    },
  }
}
