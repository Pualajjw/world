// Inherited menu types can qualify their ancestor with a backtick (m_base`m_file).
const typeHeader = /^(global\s+)?type\s+([\w\p{L}$#-]+)\s+from\s+([\w\p{L}$#`-]+)(?:\s+within\s+([\w\p{L}$#-]+))?/iu
const lifeHeader = /^on\s+([\w\p{L}$#-]+)\.([\w$#-]+)/iu

/** PB menu exports often put the painter properties and item order in on <item>.create,
 * not in the type declaration. Read only literal initializers; never run the script. */
export function createMenuReader(literal) {
  const orders = new Map()
  let continuation = null
  function read(obj, line) {
    if (continuation?.obj === obj || /^(?:this\.)?item\s*=/i.test(line)) {
      if (!continuation || continuation.obj !== obj) continuation = { obj, parts: [] }
      const more = line.endsWith('&')
      continuation.parts.push(more ? line.slice(0, -1) : line)
      if (more) return
      line = continuation.parts.join(' '); continuation = null
      const array = /^(?:this\.)?item\s*=\s*\{([^{}]*)\}\s*;?$/i.exec(line)
      if (array) {
        const slots = new Map()
        const tokens = array[1].split(',')
        for (const [i, token] of tokens.entries()) {
          const ref = /^(?:this\.)?([\w\p{L}$#-]+)$/iu.exec(token.trim())
          if (ref) slots.set(i + 1, ref[1].toLowerCase())
        }
        orders.set(obj, { slots, last: tokens.length })
      }
      return
    }
    const item = /^(?:this\.)?item\s*\[\s*(\d+|upperbound\s*\(\s*(?:this\.)?item\s*\)\s*\+\s*1)\s*\]\s*=\s*(?:this\.)?([\w\p{L}$#-]+)\s*;?$/iu.exec(line)
    if (item) {
      let order = orders.get(obj)
      if (!order) orders.set(obj, order = { slots: new Map(), last: 0 })
      const slot = /^\d/.test(item[1]) ? Number(item[1]) : order.last + 1
      order.slots.set(slot, item[2].toLowerCase()); order.last = Math.max(order.last, slot)
      return
    }
    const prop = /^(?:this\.)?([\w$#-]+)\s*=\s*("(?:~.|[^"~])*"|'(?:~.|[^'~])*'|true|false|-?\d+(?:\.\d+)?|\w+!)\s*;?$/i.exec(line)
    if (prop) obj.props[prop[1].toLowerCase()] = literal(prop[2])
  }
  function link(model) {
    const append = (parent, item) => {
      if (!parent || !item || item === model.root || item.menuParent || item === parent || item.nonvisual || item.base.toLowerCase() === 'structure') return
      item.menuParent = parent.id; (parent.menuItems ||= []).push(item)
    }
    // Explicit Item[] describes the display hierarchy; within is the fallback for partial exports.
    for (const [parent, { slots }] of orders) {
      for (const [, id] of [...slots].sort((a, b) => a[0] - b[0])) append(parent, model.objects.get(id))
    }
    for (const item of model.objects.values()) append(model.objects.get(item.within), item)
  }
  return { read, link, typeHeader, lifeHeader }
}
