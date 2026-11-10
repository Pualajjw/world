/**
 * 把 app.html + app.css + app.js 合成一个自包含、双击即可查看的界面原型。
 * 界面只有一份源码：改样式/交互后重跑 `node build-prototype.mjs` 即可。
 */
import { readFile, writeFile } from 'node:fs/promises'

const root = new URL('.', import.meta.url)
const [html, css, js, markdown] = await Promise.all([
  readFile(new URL('app.html', root), 'utf8'),
  readFile(new URL('app.css', root), 'utf8'),
  readFile(new URL('app.js', root), 'utf8'),
  readFile(new URL('markdown.js', root), 'utf8'),
])

const styleTag = '<style>\n' + css + '\n</style>'
const scriptTag = '<script>\n' + markdown + '\nwindow.LAN_CHAT_DEMO = true;\n' + js + '\n</script>'
let output = html
  .replace('<title>局域网聊天 · LAN Chat</title>', '<title>局域网聊天 · 界面设计原型</title>')
  .replace('<link rel="stylesheet" href="./app.css" />', styleTag)
  .replace('<script src="./markdown.js"></script>', '')
  .replace('<script src="./app.js"></script>', scriptTag)

if (output.includes('./app.css') || output.includes('./app.js') || output.includes('./markdown.js')) {
  throw new Error('内联失败：app.html 里的资源引用形式变了，请同步修改 build-prototype.mjs')
}
await writeFile(new URL('prototype.html', root), output, 'utf8')
console.log(`prototype.html 已生成（${(Buffer.byteLength(output) / 1024).toFixed(1)} KB，完全自包含）`)
