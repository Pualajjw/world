import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTerminalFixture } from './terminal-fixture.js'
import { checkWindowRestore } from './window-restore.mjs'

/** 真浏览器里敲命令：窗口、输入行、颜色、退出码、Ctrl+C、补全、清屏都要真的能用。 */
export async function checkTerminal(browser, bundleText) {
  const workspace = await mkdtemp(join(tmpdir(), 'world-term-ui-'))
  await mkdir(join(workspace, 'sub'))
  const alpha = join(workspace, 'alpha.txt')
  const beta = join(workspace, 'sub', 'beta.txt')
  await writeFile(alpha, 'alpha\n')
  await writeFile(beta, 'beta\n')
  const terminal = createTerminalFixture()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const screen = page.locator('[data-world-term-screen]')
  const input = page.locator('.world-term-input')
  const type = async (text, { enter = true } = {}) => {
    await input.fill(text)
    if (enter) await input.press('Enter')
  }
  const waitForText = (text, timeout = 20000) => page.waitForFunction(
    needle => (document.querySelector('[data-world-term-screen]')?.innerText || '').includes(needle),
    text, { timeout },
  )
  try {
    await page.exposeBinding('__worldTerminalCall', async (_source, operation, payload) => {
      try {
        // 假宿主里会话目录是 /workspace，换成本次测试真正的临时目录
        const cwd = !payload?.cwd || payload.cwd === '/workspace' ? workspace : payload.cwd
        return { ok: true, value: await terminal.call(operation, { ...payload, cwd }) }
      } catch (error) {
        return { ok: false, error: { code: error.code, message: error.message } }
      }
    })
    await page.route('http://127.0.0.1/world-terminal-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><style>body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
    await page.goto('http://127.0.0.1/world-terminal-fixture')
    const themeCss = await readFile(join(process.env.WORLD_DSH_SOURCE || 'E:/deepseek-harness',
      'packages/client/ui-theme/src/styles/design-platform.css'), 'utf8')
    await page.addStyleTag({ content: themeCss })
    await page.addScriptTag({ content: bundleText })
    // 终端是自带应用：新配置里桌面上就该有它的图标
    await page.locator('[data-world-icon-id="terminal"]').waitFor()
    await page.locator('.world-start-button').click()
    await page.locator('[data-world-app-card="terminal"] .world-app-open').click()
    await page.locator('.world-terminal-window').waitFor()
    await waitForText('world 终端')
    assert.equal(await page.locator('[data-world-taskbar="terminal"]').count(), 1)
    assert.equal(await page.locator('body').getAttribute('data-world-active-window'), 'terminal')

    // 窗口要在桌面范围之内，且不是一条缝
    const box = await page.locator('.world-terminal-window').boundingBox()
    assert.ok(box.height > 320 && box.width > 520, `terminal window too small: ${JSON.stringify(box)}`)
    assert.ok(box.y >= 0 && box.y + box.height <= 800 + 1, `terminal window leaves the viewport: ${JSON.stringify(box)}`)

    // 命令真的跑起来了
    await type('node -e "console.log(6 * 7)"')
    await waitForText('42')
    // 只有慢命令（>600ms）才回报用时：快命令后面挂个 12ms 只会显得吵
    await type('node -e "setTimeout(() => {}, 900)"')
    await waitForText('↳ 完成')

    // 输出里的 ANSI 颜色要落到具体的 CSS 颜色上，而不是被当普通字符打印出来
    await type('node -e "process.stdout.write(\'\\u001b[31mred\\u001b[0m\')"')
    // 回显的命令里也有 red，所以等的是「带颜色的那个 span」，不是文本出现
    await page.waitForFunction(() => [...document.querySelectorAll('[data-world-term-screen] span')]
      .some(span => span.textContent === 'red' && span.style.color), undefined, { timeout: 20000 })
    const ansi = await screen.evaluate(node => {
      const span = [...node.querySelectorAll('span')].find(item => item.textContent === 'red')
      const probe = document.createElement('span')
      probe.style.color = 'var(--world-term-ansi-1)'
      // 变量定义在终端窗口上，探针必须挂进同一个作用域才拿得到值
      document.querySelector('.world-terminal-window').append(probe)
      const expected = getComputedStyle(probe).color
      probe.remove()
      return { color: getComputedStyle(span).color, expected }
    })
    assert.equal(ansi.color, ansi.expected, `the red run must use the ansi-1 colour: ${JSON.stringify(ansi)}`)
    assert.equal(await screen.evaluate(node => node.innerText.includes('\u001b')), false, 'escape codes must not be printed raw')

    // 非零退出码要说明白，而不是静悄悄地停下
    await type('node -e "process.exit(4)"')
    await waitForText('退出码 4')

    // 宽字符按两列落格：`\x1b[5G` 停在第五列，此时「中文」刚好占满四列，X 应该紧跟其后
    await type('node -e "process.stdout.write(\'中文\\u001b[5GX\')"')
    await page.waitForFunction(() => [...document.querySelectorAll('.world-term-line')]
      .some(line => line.innerText === '中文X'), undefined, { timeout: 20000 })

    // Ctrl+R 反向搜索历史：输入行显示搜索词，命中的命令在状态栏，Enter 接受
    await input.press('Control+r')
    await input.type('6 * 7')
    await page.waitForFunction(() => document.querySelector('.world-term-input')?.value === '6 * 7')
    assert.match(await page.locator('.world-term-search').innerText(), /console\.log/u)
    assert.equal(await page.locator('[data-world-term-prompt]').getAttribute('data-world-term-prompt'), 'search')
    await input.press('Enter')
    await page.waitForFunction(() => (document.querySelector('.world-term-input')?.value || '').includes('console.log(6 * 7)'))
    assert.equal(await page.locator('.world-term-search').count(), 0)
    await input.fill('')

    // 唯一的目录候选顺手把斜杠补上
    await input.fill('cd su')
    await input.press('Tab')
    await page.waitForFunction(() => document.querySelector('.world-term-input')?.value === 'cd sub/')
    await input.fill('')

    // cd 由窗口自己记：提示行与 pwd 都跟着走
    await type('cd sub')
    await page.waitForFunction(() => document.querySelector('.world-term-prompt')?.textContent?.includes('sub'))
    await type('pwd')
    await waitForText(join(workspace, 'sub'))

    // Tab 补全：唯一的候选直接补进输入行
    await input.fill('be')
    await input.press('Tab')
    await page.waitForFunction(() => document.querySelector('.world-term-input')?.value === 'beta.txt')

    // `cd -` 回上一个目录：由窗口记着，不能当成一个叫「-」的文件夹
    await type('cd -')
    await page.waitForFunction(expected => document.querySelector('.world-term-status-path')?.title === expected, workspace)

    // 焦点不在输入行也能直接打字：点过状态栏之后 focus 会落到 body 上
    await page.locator('.world-term-status-path').click()
    await page.keyboard.type('echo typed-anywhere')
    await page.waitForFunction(() => document.querySelector('.world-term-input')?.value === 'echo typed-anywhere')
    await page.keyboard.press('Enter')
    await waitForText('typed-anywhere')

    // 字号：Ctrl+= 放大、Ctrl+0 复位，并且记住（下次开窗还是这个字号）
    const fontOf = () => screen.evaluate(node => getComputedStyle(node).fontSize)
    const baseFont = await fontOf()
    await page.keyboard.press('Control+Equal')
    assert.notEqual(await fontOf(), baseFont)
    assert.equal(await page.evaluate(() => localStorage.getItem('dsh.world.terminal.font')), '13')
    await page.keyboard.press('Control+0')
    assert.equal(await fontOf(), baseFont)

    // 命令还在跑时敲的下一行会排队：状态栏给出队列数，输出严格按顺序
    await type('node -e "setTimeout(() => {}, 1400)"')
    await page.locator('.world-term-running').waitFor()
    await type('node -e "console.log(\'queued-a\')"')
    await type('node -e "console.log(\'queued-b\')"')
    await page.waitForFunction(() => (document.querySelector('.world-term-queue')?.textContent || '').includes('2'))
    await waitForText('queued-b', 25000)
    const order = await screen.evaluate(node => {
      const all = node.innerText
      return [all.indexOf('queued-a'), all.indexOf('queued-b')]
    })
    assert.ok(order[0] >= 0 && order[1] > order[0], `queued output must keep its order: ${JSON.stringify(order)}`)

    // 换机器不是排队能等到的：忙的时候说清楚，并把命令留在输入行
    await type('node -e "setTimeout(() => {}, 1600)"')
    await page.locator('.world-term-running').waitFor()
    await input.fill('ssh web')
    await input.press('Enter')
    await waitForText('当前命令还在跑')
    assert.equal(await input.inputValue(), 'ssh web')

    // Ctrl+C 把排队的命令也一起丢掉，而不是留着在后台偷偷跑
    await input.fill('node -e "console.log(\'ghost-ran\')"')
    await input.press('Enter')
    await waitForText('已排队')
    await input.press('Control+c')
    await waitForText('一并丢掉了')
    await page.waitForFunction(() => !document.querySelector('.world-term-running'))
    assert.equal(await page.locator('.world-term-queue').count(), 0)
    await page.waitForTimeout(400)
    assert.equal(await screen.evaluate(node => node.innerText.split('\n').some(line => line.trim() === 'ghost-ran')), false)

    // Ctrl+C 中断长命令，输入行同时清空
    await type('node -e "setTimeout(() => {}, 20000)"')
    await page.locator('.world-term-running').waitFor()
    await input.fill('partial')
    await input.press('Control+c')
    await waitForText('已中断')
    assert.equal(await input.inputValue(), '')
    await page.waitForFunction(() => !document.querySelector('.world-term-running'))

    // 清屏：之前的输出一行都不该留下
    await type('cls')
    await page.waitForFunction(() => !(document.querySelector('[data-world-term-screen]')?.innerText || '').includes('退出码 4'))

    // 内置命令表
    await type('help')
    await waitForText('切换本机工作目录')

    // 长输出：往上看的时候不抢滚动，出现「跳到最新」；点了才回到尾巴
    await type('node -e "for (let i = 0; i < 200; i += 1) console.log(\'line \' + i)"')
    await waitForText('line 199')
    await page.locator('.world-term-scroll').evaluate(node => { node.scrollTop = 0 })
    const jump = page.locator('.world-term-jump')
    await jump.waitFor()
    await jump.click()
    await page.waitForFunction(() => !document.querySelector('.world-term-jump'))
    await page.waitForFunction(() => {
      const node = document.querySelector('.world-term-scroll')
      return node.scrollTop + node.clientHeight >= node.scrollHeight - 4
    })

    // 最小化 / 最大化 / 还原：任务栏与开始菜单都能把它叫回来，且不会开出第二个窗口
    await checkWindowRestore(page, page.locator('.world-terminal-window'), 'terminal', async () => {
      await page.locator('.world-start-button').click()
      await page.locator('[data-world-app-card="terminal"] .world-app-open').click()
    })

    // 桌面有真键盘：那排触控键不该出现在这里（它们会白占一行高度）
    assert.equal(await page.locator('.world-term-keys').count(), 0, '桌面不画触控快捷键条')

    assert.deepEqual(errors, [])
    console.log('Terminal passed: default install, command output, ANSI colour, exit code, cd/pwd, Tab completion, typing without focus, font size, queueing, Ctrl+C, cls, help, follow-up scrolling, window restore, desktop has no touch key row.')
    return page
  } finally {
    await terminal.dispose().catch(() => {})
    await page.close()
    await rm(workspace, { recursive: true, force: true })
  }
}

/**
 * 手机上的终端。软键盘上没有 Tab / Ctrl / 方向键，所以这些键必须有触控入口：
 * 一排按钮直接调用键盘那条路上的同一段逻辑，行为不能和桌面漂成两套。
 */
export async function checkPhoneTerminal(browser, bundleText) {
  const workspace = await mkdtemp(join(tmpdir(), 'world-term-phone-'))
  await writeFile(join(workspace, 'alpha.txt'), 'alpha\n')
  await mkdir(join(workspace, 'sub'))
  const terminal = createTerminalFixture()
  const page = await browser.newPage({ viewport: { width: 360, height: 640 }, hasTouch: true })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const input = page.locator('.world-term-input')
  const key = label => page.locator(`.world-term-key:text-is("${label}")`)
  const waitForText = (text, timeout = 20000) => page.waitForFunction(
    needle => (document.querySelector('[data-world-term-screen]')?.innerText || '').includes(needle),
    text, { timeout },
  )
  const value = () => input.inputValue()
  const focused = () => page.evaluate(() => document.activeElement?.className || '')
  try {
    await page.exposeBinding('__worldTerminalCall', async (_source, operation, payload) => {
      try {
        const cwd = !payload?.cwd || payload.cwd === '/workspace' ? workspace : payload.cwd
        return { ok: true, value: await terminal.call(operation, { ...payload, cwd }) }
      } catch (error) {
        return { ok: false, error: { code: error.code, message: error.message } }
      }
    })
    await page.route('http://127.0.0.1/world-terminal-phone', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}#root{height:100vh;width:100vw}.app-frame{position:relative;height:100%}#host-ui{position:absolute;inset:40px 0 0}</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>' }))
    await page.goto('http://127.0.0.1/world-terminal-phone')
    await page.addScriptTag({ content: bundleText })
    await page.locator('[data-world-icon-id="terminal"]').waitFor()
    await page.locator('[data-world-icon-id="terminal"]').tap()
    await page.locator('.world-terminal-window').waitFor()
    await waitForText('world 终端')
    // 手机版的启动提示不该再教人按 Tab / Ctrl：那几颗键软键盘上没有
    await waitForText('下方按键')
    assert.equal(await page.evaluate(() => (document.querySelector('[data-world-term-screen]')?.innerText || '').includes('Ctrl+R')), false,
      '手机启动提示不提物理键盘')

    // 六颗键：等宽等高，全在窗口里，且不压住状态栏
    const keys = await page.evaluate(() => [...document.querySelectorAll('.world-term-key')].map(node => {
      const rect = node.getBoundingClientRect()
      return { label: node.textContent, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
    }))
    assert.deepEqual(keys.map(item => item.label), ['Tab', '↑', '↓', '^C', '^L', '^R'])
    assert.equal(Math.min(...keys.map(item => item.h)), 40, '触控键 40px 高')
    assert.ok(Math.min(...keys.map(item => item.w)) >= 44, `每颗键至少 44px 宽：${JSON.stringify(keys.map(item => item.w))}`)
    assert.ok(Math.max(...keys.map(item => item.x + item.w)) <= 360, '按键条没有溢出屏幕')
    const row = await page.locator('.world-term-keys').boundingBox()
    const status = await page.locator('.world-term-status').boundingBox()
    const win = await page.locator('.world-terminal-window').boundingBox()
    assert.ok(row.y + row.height <= status.y + 1, '按键条在状态栏上面，不叠')
    assert.ok(row.y >= win.y && row.y + row.height <= win.y + win.height, '按键条在窗口里')
    // 输入行只有一行 18px 的字，手机上得给够可点的高度
    const inputRow = await page.locator('.world-term-input-row').boundingBox()
    assert.ok(inputRow.height >= 30, `输入行可点区 ${Math.round(inputRow.height)}px`)

    // Tab 补全：和键盘上按 Tab 走的是同一条路
    await input.fill('al')
    await key('Tab').tap()
    await page.waitForFunction(() => document.querySelector('.world-term-input')?.value === 'alpha.txt', undefined, { timeout: 10000 })

    // 点按钮不能把焦点从输入行抢走：软键盘一收，还得再点回来才能继续打
    await input.focus()
    await key('^L').tap()
    assert.equal(await focused(), 'world-term-input', '点快捷键后焦点仍在输入行')
    await page.waitForFunction(() => !(document.querySelector('[data-world-term-screen]')?.innerText || '').includes('下方按键'),
      undefined, { timeout: 10000 })

    // 历史：跑两条内置命令，再用 ↑ / ↓ 翻
    for (const line of ['help', 'pwd']) {
      await input.fill(line)
      await input.press('Enter')
      await page.waitForTimeout(400)
    }
    await key('↑').tap()
    assert.equal(await value(), 'pwd')
    await key('↑').tap()
    assert.equal(await value(), 'help')
    await key('↓').tap()
    assert.equal(await value(), 'pwd')
    await input.fill('')

    // ^R 进搜索：输入行换名字，接着就能用软键盘打关键字
    await key('^R').tap()
    assert.equal(await page.locator('.world-term-prompt[data-world-term-prompt="search"]').count(), 1, '^R 进反向搜索')
    await input.fill('p')
    assert.ok(await page.locator('.world-term-search').isVisible(), '搜索模式显示命中')
    await key('^C').tap()
    assert.equal(await page.locator('.world-term-prompt[data-world-term-prompt="search"]').count(), 0, '^C 退出搜索')

    // ^C 中断：命令真要停下来（夹具用 taskkill /T /F 杀整棵树，和宿主一致）
    await input.fill('node -e "setTimeout(() => {}, 20000)"')
    await input.press('Enter')
    await page.locator('.world-term-running').waitFor()
    await key('^C').tap()
    await waitForText('^C 已中断')
    assert.equal(await value(), '')
    await page.waitForFunction(() => !document.querySelector('.world-term-running'), undefined, { timeout: 15000 })

    // 浅色主题下终端那一行不能被当成表单框垫灰底（vscode 外壳的 input 样式会漏进来）
    const formField = await page.evaluate(() => {
      document.body.dataset.worldTheme = 'light'
      const host = document.querySelector('.world-vscode-window')
      const field = document.createElement('input')
      host.append(field)
      const painted = getComputedStyle(field).backgroundColor
      field.remove()
      return painted
    })
    assert.notEqual(formField, 'rgba(0, 0, 0, 0)', '浅色主题下 vscode 外壳里的表单框仍有底色（规则是活的）')
    assert.equal(await input.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)',
      '终端输入行是「终端里的一行」，不该垫表单底色')

    assert.deepEqual(errors, [])
    console.log('Phone terminal passed: touch key row (Tab / ↑ / ↓ / ^C / ^L / ^R), completion, history, reverse search, real interrupt, focus kept, no form backdrop.')
    return page
  } finally {
    await terminal.dispose().catch(() => {})
    await page.close()
    await rm(workspace, { recursive: true, force: true })
  }
}
