import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTerminalFixture } from './terminal-fixture.js'
import { createSshFixture } from './ssh-fixture.js'

/**
 * 终端里的 SSH：全流程都在真浏览器里走一遍。
 * 连接、远端提示行、远端执行、远程 cd、Tab 补全、logout、两类典型失败（认证 / 主机密钥）
 * 以及 trust 写 known_hosts —— 这些是「命令行连服务器」最容易被写错的几处。
 */
export async function checkTerminalSsh(browser, bundleText) {
  const workspace = await mkdtemp(join(tmpdir(), 'world-ssh-term-'))
  await mkdir(join(workspace, 'sub'))
  const terminal = createTerminalFixture()
  const ssh = await createSshFixture()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const screen = page.locator('[data-world-term-screen]')
  const input = page.locator('.world-term-input')
  const type = async text => {
    await input.fill(text)
    await input.press('Enter')
  }
  const text = () => screen.evaluate(node => node.innerText)
  const waitForText = (needle, timeout = 20000) => page.waitForFunction(
    value => (document.querySelector('[data-world-term-screen]')?.innerText || '').includes(value),
    needle, { timeout },
  )
  try {
    await page.exposeBinding('__worldTerminalCall', async (_source, operation, payload) => {
      try {
        const cwd = !payload?.cwd || payload.cwd === '/workspace' ? workspace : payload.cwd
        return { ok: true, value: await terminal.call(operation, { ...payload, cwd }) }
      } catch (error) {
        return { ok: false, error: { code: error.code, message: error.message } }
      }
    })
    await page.exposeBinding('__worldSshCall', async (_source, operation, payload) => {
      try { return { ok: true, value: await ssh.call(operation, payload) } }
      catch (error) { return { ok: false, error: { code: error.code, message: error.message } } }
    })
    await page.route('http://127.0.0.1/world-ssh-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
    await page.goto('http://127.0.0.1/world-ssh-fixture')
    const themeCss = await readFile(join(process.env.WORLD_DSH_SOURCE || 'E:/deepseek-harness',
      'packages/client/ui-theme/src/styles/design-platform.css'), 'utf8')
    await page.addStyleTag({ content: themeCss })
    await page.addScriptTag({ content: bundleText })
    await page.locator('[data-world-icon-id="terminal"]').waitFor()
    await page.locator('.world-start-button').click()
    await page.locator('[data-world-app-card="terminal"] .world-app-open').click()
    await page.locator('.world-terminal-window').waitFor()
    await waitForText('world 终端')
    assert.equal(await page.locator('.world-terminal-window').getAttribute('data-world-term-mode'), 'local')

    // `ssh` 空参：把 ~/.ssh/config 里的主机列出来
    await type('ssh')
    await waitForText('10.0.0.5')
    const listed = await text()
    for (const alias of ['web', 'authfail', 'newkey']) assert.match(listed, new RegExp(alias, 'u'), listed)

    // Tab 补全：主机别名，不是本机文件名
    await input.fill('ssh w')
    await input.press('Tab')
    await page.waitForFunction(() => document.querySelector('.world-term-input')?.value === 'ssh web ')
    await input.fill('')

    // 连接成功：提示行变成 用户@主机:路径，标题上出现远程徽章，状态栏显示探测延迟
    await type('ssh web')
    await waitForText('已连接 deploy@10.0.0.5:22')
    await page.waitForFunction(() => document.querySelector('.world-terminal-window')?.dataset.worldTermMode === 'ssh')
    await page.waitForFunction(() => document.querySelector('.world-term-prompt')?.textContent?.includes('deploy@web:'))
    assert.equal(await page.locator('.world-term-badge.is-ssh').innerText(), 'deploy@web')
    assert.equal(await page.locator('[data-world-term-prompt]').getAttribute('data-world-term-prompt'), 'ssh')
    assert.match(await page.locator('.world-term-latency').innerText(), /⇅/u)

    // 远端命令：真的用 `cd <目录> && <命令>` 包了一层再发出去
    await type('ls -la')
    await waitForText("remote: cd '/home/deploy' && ls -la")

    // `!命令` 在远程会话里跑本机命令：输出单独一行，模式仍然是 ssh
    await type('!node -e "console.log(\'local-only\')"')
    await page.waitForFunction(() => [...document.querySelectorAll('.world-term-line')]
      .some(line => line.innerText.trim() === 'local-only'), undefined, { timeout: 20000 })
    assert.equal(await page.locator('.world-terminal-window').getAttribute('data-world-term-mode'), 'ssh')

    // 远程 cd：目录记在窗口里，pwd 读的是远端目录
    await type('cd srv')
    await page.waitForFunction(() => document.querySelector('.world-term-prompt')?.textContent?.includes('/srv'))
    await type('pwd')
    await page.waitForFunction(() => (document.querySelector('[data-world-term-screen]')?.innerText || '').includes('/srv'))

    // 远端没有常驻 shell，`cd -` 只能由窗口记着上一个目录
    await type('cd -')
    await page.waitForFunction(() => (document.querySelector('.world-term-status-path')?.title || '').endsWith('/home/deploy'))

    // 远程路径补全
    await input.fill('app.j')
    await input.press('Tab')
    await page.waitForFunction(() => document.querySelector('.world-term-input')?.value === 'app.js')

    // logout 回到本机
    await type('logout')
    await waitForText('已断开 deploy@web')
    await page.waitForFunction(() => document.querySelector('.world-terminal-window')?.dataset.worldTermMode === 'local')
    await page.waitForFunction(() => document.querySelector('[data-world-term-prompt]')?.dataset.worldTermPrompt === 'local')

    // 连接挂住时 Esc 能取消：说「已取消」，而不是一句莫名其妙的网络错误
    await type('ssh slow')
    await page.locator('.world-term-busy').waitFor()
    await input.press('Escape')
    await waitForText('已取消连接 slow')
    await page.waitForFunction(() => !document.querySelector('.world-term-busy'))
    assert.equal(await page.locator('.world-terminal-window').getAttribute('data-world-term-mode'), 'local')

    // 远端命令还在跑时 logout：一起收掉，而且不该伪装成一次 Ctrl+C
    await type('ssh web')
    await waitForText('已连接 deploy@10.0.0.5:22')
    await type('sleep 30')
    await page.locator('.world-term-running').waitFor()
    await type('logout')
    await waitForText('已断开：正在跑的命令一起停了。')
    assert.equal((await text()).includes('^C 已中断'), false)

    // 认证失败：说清楚「没有 PTY，只走密钥」，并给出下一步
    await type('ssh authfail')
    await waitForText('认证失败')
    await waitForText('ssh-keygen')
    assert.equal(await page.locator('.world-terminal-window').getAttribute('data-world-term-mode'), 'local')

    // 主机密钥没见过：提示 trust；trust 打印指纹并写 known_hosts
    await type('ssh newkey')
    await waitForText('主机密钥没有记录')
    await waitForText('trust')
    // 待确认的主机密钥要一直挂在状态栏上，而不是只在输出里说一次
    assert.match(await page.locator('.world-term-trust').innerText(), /输入 trust/u)
    await type('trust')
    await waitForText('SHA256:')
    await waitForText('已写入 1 条主机密钥')
    const known = await readFile(join(ssh.home, '.ssh', 'known_hosts'), 'utf8')
    assert.match(known, /10\.0\.0\.7 ssh-ed25519/u)

    // 帮助里要能看到 ssh 相关的几条
    await type('help')
    await waitForText('ssh <主机>')
    await waitForText('trust')

    assert.deepEqual(errors, [])
    console.log('Terminal SSH passed: host list, alias completion, connect, remote prompt, wrapped command, remote cd, remote completion, logout, cancelled connect, logout while busy, auth failure, host key + trust.')
    return page
  } finally {
    await ssh.dispose().catch(() => {})
    await terminal.dispose().catch(() => {})
    await page.close()
    await rm(workspace, { recursive: true, force: true })
  }
}
