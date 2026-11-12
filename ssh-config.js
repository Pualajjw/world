/**
 * 读 `~/.ssh/config`。
 *
 * 只做「窗口需要知道的那部分」：有哪些主机、连过去用什么用户名/端口/密钥。
 * 真正怎么连仍然交给 `ssh` 自己——它才是配置语义的权威（匹配顺序、`Match`、
 * 通配、命令行覆盖后排最后……），这里重写一遍只会慢慢和它长得不一样。
 * 所以这里的输出只用于：主机清单、提示行的 user@host、Tab 补全。
 *
 * 解析规则按 man ssh_config：
 *   · 只有以 `#` 开头的整行才是注释（值里的 `#` 是普通字符）
 *   · 关键字大小写不敏感；`Key value` 与 `Key=value` 都合法；值可以用引号包起来
 *   · 一个 Host 行可以列多个别名；同一别名出现多次时第一次生效
 *   · 通配（`*`/`?`）与否定（`!x`）的块是「默认值」，不当作可连接的主机列出来
 */
const MULTI_ALIAS_KEYS = new Set(['host', 'match'])

/** 把一行拆成词：支持双引号、单引号和 `=` 连接，`#` 起头的一段算注释。 */
export function tokenizeSshLine(line) {
  const tokens = []
  let current = ''
  let quote = ''
  let started = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote) {
      if (char === quote) { quote = ''; continue }
      current += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue }
    // `Key=value`：等号是分隔符，不是词的一部分
    if (char === '=') {
      if (started) { tokens.push(current); current = ''; started = false }
      continue
    }
    // 行尾注释：ssh 严格说只认整行注释，但半行注释太常见了，按人期望的样子处理
    if (char === '#' && !started) break
    if (/\s/u.test(char)) {
      if (started) { tokens.push(current); current = ''; started = false }
      continue
    }
    current += char
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/** 关键字 → 我们保留的字段名。其余关键字照旧忽略（ssh 自己会处理）。 */
const FIELDS = {
  hostname: 'hostName',
  user: 'user',
  port: 'port',
  identityfile: 'identityFile',
  proxyjump: 'proxyJump',
  proxycommand: 'proxyCommand',
  serveraliveinterval: 'serverAliveInterval',
}

const isPattern = value => /[*?]/u.test(value) || value.startsWith('!')

/**
 * @param {string} text - 配置文件内容
 * @returns {{ hosts: Array<object>, includes: string[], warnings: string[] }}
 */
export function parseSshConfig(text) {
  const lines = String(text ?? '').replace(/^\uFEFF/u, '').split(/\r?\n/u)
  const hosts = []
  const includes = []
  const warnings = []
  const seen = new Set()
  let block = null
  let inMatch = false

  const flush = () => {
    block = null
    inMatch = false
  }

  for (let number = 0; number < lines.length; number += 1) {
    const raw = lines[number]
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const tokens = tokenizeSshLine(trimmed)
    if (!tokens.length) continue
    const keyword = tokens[0].toLowerCase()
    const values = tokens.slice(1)

    if (keyword === 'host') {
      // 先把本块要填字段的条目建出来。同一个别名重复出现时第一次生效，
      // 后面那一块不能反过来改前一块的字段（ssh 里也是第一次匹配的块说了算）。
      const targets = []
      for (const pattern of values) {
        if (isPattern(pattern) || seen.has(pattern)) continue
        seen.add(pattern)
        const entry = {
          alias: pattern, hostName: '', user: '', port: '', identityFile: '',
          proxyJump: '', proxyCommand: '', serverAliveInterval: '', line: number + 1,
        }
        hosts.push(entry)
        targets.push(entry)
      }
      block = { patterns: values, fields: {}, targets }
      inMatch = false
      continue
    }

    if (keyword === 'match') {
      block = { patterns: [], fields: {}, targets: [] }
      inMatch = true
      continue
    }

    if (keyword === 'include') {
      for (const value of values) includes.push(value)
      continue
    }

    if (!block || inMatch) continue
    const field = FIELDS[keyword]
    if (!field) {
      if (!MULTI_ALIAS_KEYS.has(keyword) && !values.length) warnings.push(`第 ${number + 1} 行 ${tokens[0]} 没有值`)
      continue
    }
    if (!values.length) continue
    for (const entry of block.targets) {
      // 「先说到的赢」：同一块里重复写同一个键，ssh 取第一个
      if (entry[field]) continue
      entry[field] = values.join(' ')
    }
  }

  for (const entry of hosts) if (!entry.hostName) entry.hostName = entry.alias
  return { hosts, includes, warnings }
}

/** `~/.ssh/config` 里的相对 Include 以 `~/.ssh` 为基准；顺手把 `~` 展开掉。 */
export function expandTilde(path, home) {
  const value = String(path ?? '').trim()
  if (!value) return value
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return `${home}${value.slice(1)}`
  return value
}
