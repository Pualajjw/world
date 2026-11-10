/** Isolated native test shell: real Electron guests and the Host's existing guest policy. */
const { app, BrowserWindow, ipcMain } = require('electron')
const { createServer } = require('node:http')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const directory = process.argv.at(-1)
const { DesktopBrowserGuests } = require(join(directory, 'guests.cjs'))
app.setPath('userData', join(directory, 'profile'))

app.whenReady().then(async () => {
  const fixture = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/page' }); response.end(); return
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    // Real webviews can display sites that prohibit iframe embedding.
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
    response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Native viewport test</title><style>body{margin:0;font:16px sans-serif;background:#eef6ff}header{padding:20px;background:#1464b4;color:white}.wide{width:1500px;height:80px;background:linear-gradient(90deg,#b8e5ff,#2248a0);color:white}.right{float:right}.tall{height:2200px}footer{padding:20px;background:#157e55;color:white}</style></head><body><header>Native webpage viewport test</header><div class="wide">Wide content<span class="right" id="right">RIGHT EDGE</span></div><div class="tall">Scroll to the footer.</div><footer id="bottom">END OF PAGE</footer></body></html>')
  })
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
  const host = createServer((request, response) => {
    if (request.url === '/bundle.js') {
      response.setHeader('Content-Type', 'text/javascript')
      response.end(readFileSync(join(directory, 'bundle.js')))
      return
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><html data-windows-titlebar style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{position:relative;width:100vw;height:100vh}.app-frame{position:relative;width:100%;height:100%;padding-top:40px;box-sizing:border-box}#host-ui{position:absolute;inset:40px 0 0;background:#262626}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div><script src="/bundle.js"></script></body></html>')
  })
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve))
  const hostUrl = `http://127.0.0.1:${host.address().port}`
  const window = new BrowserWindow({ width: 1280, height: 800, useContentSize: true, show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true, preload: join(directory, 'preload.cjs') } })
  const guests = new DesktopBrowserGuests(() => hostUrl)
  guests.bind(window, () => () => {})
  let acquired = 0, released = 0
  ipcMain.handle('world-test-acquire', (event, workspace) => { acquired++; return guests.acquire(event.sender, workspace) })
  ipcMain.handle('world-test-release', (event, lease) => { released++; return guests.release(event.sender, lease) })
  global.worldNativeProbe = { fixtureUrl: `http://127.0.0.1:${fixture.address().port}`,
    counts: () => ({ acquired, released }) }
  await window.loadURL(hostUrl)
})
app.on('window-all-closed', () => app.quit())
