/** Parsers share the same endpoint contract; ownership is checked by the process service. */
const TCP_STATES = { '01': 'ESTABLISHED', '02': 'SYN_SENT', '03': 'SYN_RECV', '04': 'FIN_WAIT1',
  '05': 'FIN_WAIT2', '06': 'TIME_WAIT', '07': 'CLOSE', '08': 'CLOSE_WAIT', '09': 'LAST_ACK',
  '0A': 'LISTEN', '0B': 'CLOSING', '0C': 'NEW_SYN_RECV' }

function procEndpoint(text) {
  const [hex, port] = text.split(':')
  if (!/^(?:[a-f0-9]{8}|[a-f0-9]{32})$/iu.test(hex) || !/^[a-f0-9]{4}$/iu.test(port)) return null
  const bytes = Buffer.from(hex, 'hex')
  for (let index = 0; index < bytes.length; index += 4) bytes.subarray(index, index + 4).reverse()
  const address = bytes.length === 4 ? [...bytes].join('.')
    : Array.from({ length: 8 }, (_, index) => bytes.readUInt16BE(index * 2).toString(16)).join(':')
  return { address, port: parseInt(port, 16) }
}
export function parseProcPorts(text, protocol) {
  return String(text).split('\n').flatMap(line => {
    const fields = line.trim().split(/\s+/u)
    if (!/^\d+:$/u.test(fields[0]) || fields.length < 10) return []
    const local = procEndpoint(fields[1]), remote = procEndpoint(fields[2])
    if (!local || !remote || !/^\d+$/u.test(fields[9])) return []
    return [{ protocol, localAddress: local.address, localPort: local.port, remoteAddress: remote.address,
      remotePort: remote.port, state: protocol === 'UDP' ? 'BOUND' : TCP_STATES[fields[3].toUpperCase()] || fields[3], inode: fields[9] }]
  })
}
function lsofEndpoint(text) {
  const match = /^(.*):(\d+)$/u.exec(text)
  if (!match || Number(match[2]) > 65535) return null
  return { address: match[1].replace(/^\[|\]$/gu, ''), port: Number(match[2]) }
}
export function parseLsofPorts(text) {
  const output = []
  let pid = 0, entry = null
  const flush = () => {
    if (!entry || !['TCP', 'UDP'].includes(entry.protocol) || !entry.endpoint) return
    const [from, to] = entry.endpoint.split('->'), local = lsofEndpoint(from), remote = to ? lsofEndpoint(to) : null
    if (!local) return
    output.push({ pid, protocol: entry.protocol, localAddress: local.address, localPort: local.port,
      remoteAddress: remote?.address || '', remotePort: remote?.port || 0,
      state: entry.state || (entry.protocol === 'UDP' ? 'BOUND' : 'UNKNOWN') })
  }
  for (const line of String(text).split('\n')) {
    if (/^p\d+$/u.test(line)) { flush(); entry = null; pid = Number(line.slice(1)) }
    else if (line.startsWith('f')) { flush(); entry = {} }
    else if (entry && line.startsWith('P')) entry.protocol = line.slice(1)
    else if (entry && line.startsWith('n')) entry.endpoint = line.slice(1)
    else if (entry && line.startsWith('TST=')) entry.state = line.slice(4)
  }
  flush()
  return output
}
