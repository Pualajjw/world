/** Literal matching preserves source offsets and treats replacement text (including $&) literally. */
function pattern(query, matchCase) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), matchCase ? 'g' : 'gi')
}

/**
 * 单次查找最多收集这么多命中。
 * 一个 5 万行的文件里找 `e` 会有几万处命中，全收下来光分配就要几十毫秒，
 * 而且「第 1/48000 处」对人也没有意义 —— 到这里就够了，界面上显示成 `20000+`。
 */
export const MAX_TEXT_MATCHES = 20000

// The escaped literal (g/gi, no Unicode expansion) always spans query.length UTF-16 units.
// Keep just the sorted start offsets. test() advances lastIndex without exposing a match array.
export function findTextOffsets(source, query, matchCase = false, limit = MAX_TEXT_MATCHES) {
  const starts = []
  if (!query) return starts
  const matcher = pattern(query, matchCase)
  while (matcher.test(source)) {
    starts.push(matcher.lastIndex - query.length)
    if (starts.length >= limit) break
  }
  return starts
}

export function replaceAllText(source, query, replacement, matchCase = false) {
  let count = 0
  if (!query) return { source, count }
  const value = source.replace(pattern(query, matchCase), () => { count++; return replacement })
  return { source: value, count }
}
