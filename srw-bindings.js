import { PB_CONTROL, PB_KEYWORD } from './highlight.js'

const word = '[\\p{L}_$][\\p{L}\\p{N}_$#-]*'
const decl = new RegExp(`^\\s*(?:(?:ref|readonly|constant|global|local|shared|public|protected|private)\\s+)*(${word})(?:\\s*\\{\\d+\\})?\\s+(.+)$`, 'iu')
const binding = new RegExp(`^\\s*(${word})((?:\\s*\\[[^\\]]*\\])*)\\s*(?:=.*)?$`, 'u')
// Split declarators, not initializers/array dimensions containing commas. String
// contents have already been masked, so a quoted comma cannot invent a variable.
export function splitList(code) {
  let depth = 0, start = 0, result = []
  for (let i = 0; i < code.length; i++) {
    const c = code[i]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === ',' && !depth) { result.push(code.slice(start,i)); start = i+1 }
  }
  result.push(code.slice(start)); return result
}
// Visit scalar and array declarators without keeping source or initializer strings.
export function eachBinding(code, visit) {
  const match = decl.exec(code)
  if (!match) return
  const type = match[1].toLowerCase()
  if (PB_CONTROL.has(type) || PB_KEYWORD.has(type)) return
  for (const part of splitList(match[2])) {
    const bound = binding.exec(part)
    if (bound) visit(bound[1], match[1], type, Boolean(bound[2]))
  }
}

// Mode crosses physical newlines, except for //. Only mask comments/strings, never
// tokenize or copy the full CodeMirror document. An unfinished literal also vetoes UI.
export function bindingCode(text, lex) {
  if (!lex.mode && !/[/'"]/.test(text)) return text
  let code = '', start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i+1]
    if (lex.mode === '/*') {
      if (c === '*' && next === '/') { lex.mode = ''; start = ++i + 1 }
    } else if (lex.mode) {
      if (c === '~') i++
      else if (c === lex.mode) { lex.mode = ''; start = i+1 }
    } else if (c === '/' && next === '/') { lex.comment = true; return code + text.slice(start,i) }
    else if ((c === '/' && next === '*') || c === '"' || c === "'") {
      code += text.slice(start,i) + ' '; lex.mode = c === '/' ? '/*' : c
      if (c === '/') i++
    }
  }
  return code + (lex.mode ? '' : text.slice(start))
}
