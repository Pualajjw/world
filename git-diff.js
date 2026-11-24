/** Parse a unified diff for display, retaining exact source lines for server-side hunk application. */
export function parseGitDiff(patch) {
  const lines = String(patch || '').split('\n'), rows = [], hunks = []
  let oldLine = 0, newLine = 0, hunk = -1, files = 0
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index].replace(/\r$/u, '')
    if (text.startsWith('diff --git ')) { files++; hunk = -1; continue }
    if (hunk < 0 && /^(index |--- |\+\+\+ )/u.test(text)) continue
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text)
    if (header) {
      if (hunks.length) hunks[hunks.length - 1].end = index
      hunk = hunks.length; oldLine = Number(header[1]); newLine = Number(header[2])
      hunks.push({ index: hunk, start: index, end: lines.length, old: oldLine, new: newLine })
      rows.push({ kind: 'hunk', text, hunk }); continue
    }
    if (hunk >= 0 && text.startsWith('+')) { rows.push({ kind: 'add', old: '', new: newLine++, text: text.slice(1), hunk }); continue }
    if (hunk >= 0 && text.startsWith('-')) { rows.push({ kind: 'del', old: oldLine++, new: '', text: text.slice(1), hunk }); continue }
    if (hunk >= 0 && text.startsWith(' ')) { rows.push({ kind: 'ctx', old: oldLine++, new: newLine++, text: text.slice(1), hunk }); continue }
    if (text) rows.push({ kind: 'meta', text, hunk })
  }
  const unsupported = /^(?:new file mode |deleted file mode |old mode |new mode |rename |copy |Binary files |GIT binary patch|diff --(?:cc|combined) |@@@|index .* (?:120000|160000)$)/mu.test(patch || '')
  const canApply = files === 1 && hunks.length > 0 && !unsupported && !String(patch).includes('\uFFFD')
  return { rows, hunks, canApply,
    hunkPatch(index, reverse = false) {
      if (!canApply || !Number.isInteger(index) || !hunks[index]) return null
      const selected = hunks[index]
      // Without earlier hunks both sides begin at the same offset in the index.
      // A zero-length range names the preceding line, unlike a nonempty range.
      const header = lines[selected.start].replace(/^@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@/u,
        (_, oldStart, oldCount = '', newStart, newCount = '') => {
          const oldHasLines = oldCount !== ',0' ? 1 : 0, newHasLines = newCount !== ',0' ? 1 : 0
          const offset = reverse ? Number(newStart) - newHasLines : Number(oldStart) - oldHasLines
          return `@@ -${offset + oldHasLines}${oldCount} +${offset + newHasLines}${newCount} @@`
        })
      const text = [...lines.slice(0, hunks[0].start), header, ...lines.slice(selected.start + 1, selected.end)].join('\n')
      return text.endsWith('\n') ? text : text + '\n'
    } }
}
