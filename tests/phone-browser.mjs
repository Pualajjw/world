import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installBrowserProbe } from './browser-frame.browser.mjs'

const HTML = '<!doctype html><html style="--dsh-windows-titlebar-height:40px"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>'
  + ':root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#f7f9fd;--dsw-alias-bg-layer-2:#f1f3f5;--dsw-alias-label-primary:#17233c;--dsw-alias-label-secondary:#646e82;--dsw-alias-border-l2:#e1e6ee}'
  + ':root[data-ds-dark-theme]{--dsw-alias-bg-base:#151517;--dsw-alias-bg-layer-1:#1e2024;--dsw-alias-bg-layer-2:#272a30;--dsw-alias-label-primary:#f9fafb;--dsw-alias-label-secondary:#bec4cd;--dsw-alias-border-l2:#414650}'
  + 'body{margin:0}#root{width:100vw;height:100vh}.app-frame{position:relative;height:100%;padding-top:40px;box-sizing:border-box}'
  + '#host-ui{position:absolute;inset:40px 0 0;background:#262626}[data-shell-overlay]{pointer-events:none}[data-shell-overlay]>*{pointer-events:auto}'
  + '</style></head><body><div id="root"><div class="app-frame"><main id="host-ui"><button id="phone-host-button">Host content</button></main><div id="overlay-root" data-shell-overlay></div></div></div></body></html>'

export async function checkPhoneDesktop(browser, bundleText, shotsDirectory) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const measurements = []
  const shot = async name => {
    if (!shotsDirectory) return
    await mkdir(shotsDirectory, { recursive: true })
    await page.screenshot({ path: join(shotsDirectory, `${name}.png`) })
  }
  const home = () => page.getByRole('button', { name: '返回桌面', exact: true }).tap()
  const switchTo = async id => {
    await page.getByRole('button', { name: '切换应用', exact: true }).tap()
    await page.locator(`[data-world-phone-window="${id}"]`).tap()
  }
  const fullApp = async selector => {
    const box = await page.locator(selector).boundingBox()
    assert.ok(box, `${selector} must be visible`)
    assert.equal(Math.round(box.x), 0)
    assert.equal(Math.round(box.y), 72)
    assert.equal(Math.round(box.width), 360)
    assert.equal(Math.round(box.height), 520)
    return box
  }
  try {
    await page.route('http://127.0.0.1/world-phone-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML }))
    await page.exposeBinding('__worldDesktopCall', () => ({ ok: true }))
    await page.exposeBinding('__worldBrainCall', () => ({ sessionId: 'session-1', setupRequired: false }))
    await page.goto('http://127.0.0.1/world-phone-fixture')
    await page.evaluate(() => {
      localStorage.setItem('dsh.world.apps', JSON.stringify(['vscode', 'browser', 'terminal', 'lanchat']))
      localStorage.setItem('dsh.world.external-apps', JSON.stringify([{ format: 'dsh-world-app/1', id: 'phone-test', name: '测试应用', url: 'http://127.0.0.1/world-phone-app' }]))
      localStorage.setItem('dsh.world.window.position', JSON.stringify({ x: 10, y: 12, w: 70, h: 65 }))
      localStorage.setItem('dsh.world.browser.window', JSON.stringify({ x: 8, y: 10, w: 80, h: 70 }))
      localStorage.setItem('dsh.world.plugin.workflow-studio', JSON.stringify({ x: 6, y: 11, w: 78, h: 72 }))
    })
    await page.route('http://127.0.0.1/world-phone-app', route => route.fulfill({ contentType: 'text/html', body: '<button>External phone app</button>' }))
    await page.evaluate(installBrowserProbe)
    await page.addScriptTag({ content: bundleText })
    await page.waitForFunction(() => document.body.dataset.worldLayout === 'desktop')
    await page.locator('[data-world-icon-id="dsh"]').dblclick()
    await page.waitForTimeout(200)
    const original = await page.locator('.world-window-frame').boundingBox()
    await page.locator('[data-world-browser-icon]').dblclick()
    await page.waitForTimeout(200)
    const originalBrowser = await page.locator('.world-browser-window').boundingBox()
    const stored = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.endsWith('.window') || key.endsWith('.position'))))

    for (const width of [1100, 740, 601, 360]) await page.setViewportSize({ width, height: 640 })
    await page.waitForFunction(() => document.body.dataset.worldLayout === 'phone')
    assert.equal(await page.locator('.world-desktop-titlebar').evaluate(node => getComputedStyle(node).webkitAppRegion), 'drag')
    assert.equal(await page.locator('.world-desktop-titlebar').evaluate(node => node.getBoundingClientRect().height), 40)
    measurements.push({ app: 'browser', ...await fullApp('.world-browser-window') })
    assert.equal(await page.locator('.world-window-frame').isVisible(), false)
    assert.equal(await page.locator('#host-ui').evaluate(node => node.inert), true)
    await home()
    assert.equal(await page.locator('.world-browser-window').isVisible(), false)
    assert.equal(await page.locator('.world-browser-window').evaluate(node => node.inert), true)
    assert.equal(await page.locator('[data-world-icon-id="dsh"]').isVisible(), true)
    assert.match(await page.locator('.world-phone-status [data-world-time]').textContent(), /^\d{2}:\d{2}$/u)
    const icons = await page.locator('.world-desktop-icon').evaluateAll(nodes => nodes.map(node => {
      const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }
    }))
    assert.equal(icons[0].y, icons[3].y, 'four icons share the first row')
    assert.ok(icons[4].y > icons[0].y + 90, 'the fifth icon starts the second row')
    assert.deepEqual(icons.slice(0, 4).map(item => Math.round(item.width)), [78, 78, 78, 78])
    measurements.push({ icons: icons.slice(0, 5) })
    await shot('phone-360-home')
    await page.evaluate(() => document.documentElement.setAttribute('data-ds-dark-theme', ''))
    await page.waitForFunction(() => document.body.dataset.worldTheme === 'dark')
    await shot('phone-360-home-dark')
    await page.evaluate(() => document.documentElement.removeAttribute('data-ds-dark-theme'))
    await page.waitForFunction(() => document.body.dataset.worldTheme === 'light')
    await page.locator('[data-world-icon-id="dsh"]').tap()
    measurements.push({ app: 'dsh', ...await fullApp('.world-window-frame') })
    await fullApp('#root')
    assert.equal(await page.locator('#host-ui').evaluate(node => node.inert), false)
    await page.locator('#phone-host-button').tap()
    await home()
    await switchTo('dsh')
    await fullApp('#root')
    await shot('phone-360-dsh')

    await home()
    await page.locator('[data-world-icon-id="vscode"]').tap()
    await fullApp('[data-world-vscode-key]')
    // 只认 vscode 应用自己的窗口：浏览器窗口复用了同一套 .world-vscode-* 外观，
    // 不限定作用域会把它的按钮和侧栏一起数进来。
    const editor = page.locator('[data-world-vscode-key]')
    // 手机上的侧栏是抽屉：默认收起，正文直接铺满。桌面默认展开的偏好不能跟过来——
    // 否则一进编辑器就是被文件树盖住的半屏，什么也看不见。
    assert.equal(await editor.locator('.world-vscode-sidebar').count(), 0, 'drawer starts closed on the phone')
    // 窗口本来就满屏：最小化 / 最大化没有落点，只白占标题栏
    assert.equal(await editor.locator('.world-vscode-titlebar button[aria-label^="最小化"]').count(), 0)
    assert.equal(await editor.locator('.world-vscode-titlebar button[aria-label^="最大化"]').count(), 0)
    assert.equal(await editor.locator('.world-vscode-titlebar button[aria-label="关闭 Visual Studio Code"]').count(), 1)
    // 手机上没有 Ctrl / Shift / Tab：键盘快捷键提示既按不出来，三项一起还会被状态栏裁掉
    assert.equal(await editor.locator('.world-vscode-welcome-keys').count(), 0, '手机上不摆键盘快捷键')
    await shot('phone-360-vscode-editor')

    // 手机不挂活动栏：那一列图标全收进状态栏左端的「视图」按钮，点开从底部弹菜单
    assert.equal(await editor.locator('.world-vscode-activity').count(), 0, '手机上不挂活动栏')
    const viewMenu = editor.getByRole('button', { name: '视图菜单', exact: true })
    assert.equal(await viewMenu.isVisible(), true, '视图入口在状态栏里')
    await viewMenu.tap()
    await editor.locator('.world-vscode-phone-menu').waitFor()
    const menuBox = await editor.locator('.world-vscode-phone-menu').boundingBox()
    assert.ok(menuBox.y + menuBox.height <= 592, '菜单贴着状态栏上沿，留在窗口里')
    assert.deepEqual(
      await editor.locator('.world-vscode-phone-row').evaluateAll(nodes => [...new Set(nodes.map(node => Math.round(node.getBoundingClientRect().height)))]),
      [44], '菜单行 44px')
    // 菜单自带一层透明遮罩：点正文任意处先关菜单，不会顺手把光标插到别处
    assert.equal(await editor.locator('.world-vscode-phone-scrim').count(), 1, '菜单有自己的一层遮罩')
    assert.equal(await editor.locator('.world-vscode-phone-menu').evaluate(node => {
      const rect = node.getBoundingClientRect()
      return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + 12))
    }), true, '菜单压在遮罩上面')
    await shot('phone-360-vscode-menu')

    await editor.locator('.world-vscode-phone-row').filter({ hasText: '资源管理器' }).tap()
    await editor.locator('.world-vscode-sidebar').waitFor()
    assert.equal(await editor.locator('.world-vscode-phone-menu').count(), 0, '选完视图菜单自己收起')
    const sidebar = await editor.locator('.world-vscode-sidebar').boundingBox()
    assert.ok(Math.abs(sidebar.x) <= 1, '抽屉从窗口最左边开始：不再给活动栏让位')
    assert.ok(sidebar.x + sidebar.width <= 360, 'editor sidebar stays inside the phone')
    assert.ok(360 - (sidebar.x + sidebar.width) >= 32, '抽屉右边要留一条看得见、点得到的正文')
    // 遮罩盖满正文：开关挪到状态栏里了，左边不再有要保护的活动栏
    const scrim = await editor.locator('.world-vscode-scrim').boundingBox()
    assert.ok(scrim.x <= 1, '遮罩从窗口左边起')
    assert.equal(await viewMenu.isVisible(), true, '抽屉开着时状态栏的视图按钮仍可点')

    // 抽屉开着再开菜单：当前视图打勾，再点它＝收起（和桌面上点活动栏同一个心智模型）
    await viewMenu.tap()
    await editor.locator('.world-vscode-phone-menu').waitFor()
    const activeRow = editor.locator('.world-vscode-phone-row.is-active')
    assert.equal(await activeRow.count(), 1, '当前视图在菜单里被标出来')
    assert.equal(await activeRow.getAttribute('aria-checked'), 'true')
    await activeRow.tap()
    await page.waitForFunction(() => document.querySelector('[data-world-vscode-key] .world-vscode-sidebar') === null)
    // 再点开一次，继续后面的文件树测试
    await viewMenu.tap()
    await editor.locator('.world-vscode-phone-row').filter({ hasText: '资源管理器' }).tap()
    await editor.locator('.world-vscode-sidebar').waitFor()
    // 24px 的行在手指上会点串行，抬到 40
    const fileRows = await editor.locator('.world-vscode-file').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height)))
    assert.deepEqual([...new Set(fileRows)], [40], '文件树行抬到 40px')
    await shot('phone-360-vscode-drawer')

    // 选中文件后抽屉自己让开，不用再手动收一次
    await editor.locator('.world-vscode-file').filter({ hasText: 'src' }).tap()
    await editor.getByRole('button', { name: 'main.js', exact: true }).tap()
    await editor.locator('.world-vscode-textarea').waitFor()
    await page.waitForFunction(() => document.querySelector('[data-world-vscode-key] .world-vscode-sidebar') === null)
    assert.deepEqual(await editor.locator('.world-vscode-textarea').evaluate(node => {
      const style = getComputedStyle(node)
      return { fontSize: style.fontSize, lineHeight: style.lineHeight, whiteSpace: style.whiteSpace, overflowX: style.overflowX }
    }), { fontSize: '14px', lineHeight: '22px', whiteSpace: 'pre-wrap', overflowX: 'hidden' }, '手机正文放大一号并自动换行')

    // 折行时行号照样在：每逻辑行按「量出来的顶边」各自绝对定位。
    // 先灌一段带长行的文本，把「一行折成几行」真的造出来，再逐个核对行号的位置与高度。
    const long = `const long = '${'折行以后每一行的顶边都不一样，'.repeat(5)}'`
    await editor.locator('.world-vscode-textarea').fill([
      'const value = 1', long, '',
      ...Array.from({ length: 22 }, (_, index) => `const n${index} = ${index}`),
      'const tail = 3',
    ].join('\n'))
    await page.waitForTimeout(300)
    /** 测量层逐行高度、由它推出的行号顶边、以及真正渲染出来的行号，一次取回。 */
    const gutterState = () => editor.evaluate(node => {
      const textarea = node.querySelector('.world-vscode-textarea')
      const heights = [...node.querySelectorAll('.world-vscode-measure > div')].map(cell => Math.round(cell.offsetHeight))
      const tops = []
      let sum = 0
      for (const height of heights) { tops.push(sum); sum += height }
      const rows = [...node.querySelectorAll('.world-vscode-gutter-row')].map(row => ({
        n: Number(row.textContent),
        top: Math.round(parseFloat(row.style.top || '0')),
        height: Math.round(row.getBoundingClientRect().height),
      }))
      const style = getComputedStyle(textarea)
      // 高亮层在折行时接管排版：每行绝对定位，行内 token 自己折行
      const hl = [...node.querySelectorAll('.world-vscode-hl-line')].map(row => ({
        top: Math.round(parseFloat(row.style.top || '0')),
        height: Math.round(row.getBoundingClientRect().height),
        text: row.textContent,
      }))
      return {
        rows, tops, heights, hl, scrollTop: Math.round(textarea.scrollTop), total: sum,
        content: textarea.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
        color: style.color,
      }
    })
    /** 行号、当前行、高亮层三者是否都贴着同一份测量前缀和——滚动到哪儿都得成立。 */
    const assertAligned = (state, label) => {
      assert.equal(state.total, state.content, `${label}：量出来的总高 = textarea 的滚动高度`)
      assert.ok(state.rows.length > 0, `${label}：折行时行号照样在`)
      for (const row of state.rows) {
        assert.ok(Math.abs(row.top - (state.tops[row.n - 1] - state.scrollTop)) <= 1, `${label}：第 ${row.n} 号行号贴着自己第一行`)
        assert.equal(row.height, state.heights[row.n - 1], `${label}：第 ${row.n} 号的高度 = 该逻辑行的视觉高度`)
      }
      // 折行也要有语法高亮：正文交给高亮层（textarea 的字透明），
      // 每个高亮行的顶边与行号一致、高度与镜像层量出的一致——token 折行与纯文本折行必须同点。
      const heightByTop = new Map(state.rows.map(row => [row.top, row.height]))
      for (const row of state.hl) {
        // 空行也要占一行高（镜像层与高亮层都得塞零宽字符，否则从这里开始差一行）
        assert.ok(row.height >= 22, `${label}：高亮行（top ${row.top}）至少一行高`)
        assert.equal(heightByTop.get(row.top), row.height, `${label}：高亮行（top ${row.top}）与同一逻辑行同高`)
      }
    }
    const wrapped = await gutterState()
    assert.ok(wrapped.heights.some(height => height > 44), '测试文本确实折了行')
    assertAligned(wrapped, '滚到底')
    assert.equal(wrapped.color, 'rgba(0, 0, 0, 0)', '折行时正文交给高亮层')
    assert.ok(wrapped.hl.length > 0, '折行时高亮层在')
    assert.ok(await editor.locator('.world-vscode-tok-kw').count() > 0, '折行时关键字仍有颜色')
    // 回到顶部再核一次：长行在那里，折出来的第二行得有颜色、行号只看得到一次
    await editor.locator('.world-vscode-textarea').evaluate(node => { node.scrollTop = 0 })
    await page.waitForTimeout(250)
    assertAligned(await gutterState(), '回到顶部')
    await shot('phone-360-vscode-wrap-top')
    // 手机上的左边：活动栏整个收走（0px），只剩 26px 的窄行号槽，正文从窗口最左边开始
    assert.deepEqual(await editor.locator('.world-vscode-gutter').evaluate(node => ({
      width: Math.round(node.getBoundingClientRect().width), font: getComputedStyle(node).fontSize,
    })), { width: 26, font: '11px' }, '手机的紧凑行号槽')
    assert.equal(await editor.locator('.world-vscode-activity').count(), 0, '左边没有活动栏')
    const windowBox = await editor.boundingBox()
    const editorBox = await editor.locator('.world-vscode-editor').boundingBox()
    assert.ok(Math.abs(editorBox.x - windowBox.x) <= 1, '正文顶着窗口左边')
    assert.equal(await editor.locator('.world-vscode-statusbar .world-vscode-status-wrap').textContent(), '换行 开')
    // 手机上「未保存」只占一个符号：整段文字会被挤成「未..」，而 tab 上本来就有圆点
    assert.equal(await editor.locator('.world-vscode-status-msg').textContent(), '●', '未保存用符号')
    assert.equal(await editor.locator('.world-vscode-status-msg').getAttribute('title'), '未保存')
    // 状态栏多了一个「视图」入口，其余几段不能被它挤出去：保存键的右边缘必须还在屏幕里
    const saveBox = await editor.locator('.world-vscode-statusbar button').last().boundingBox()
    assert.ok(saveBox.x + saveBox.width <= 360, '保存键没被挤出状态栏')
    assert.equal(await editor.locator('.world-vscode-statusbar').evaluate(node => node.scrollWidth <= node.clientWidth), true, '状态栏没有横向溢出')
    // 「视图」是手机上打开侧栏的唯一入口：放宽到 36 宽、28 高（拇指够得着）
    const viewKeyBox = await editor.locator('.world-vscode-status-menu').boundingBox()
    assert.ok(viewKeyBox.width >= 34 && viewKeyBox.height >= 26, `视图入口 ${viewKeyBox.width}×${viewKeyBox.height}`)
    // 软键盘收起时窗口必须是整屏的：--world-keyboard 只允许是空的或 0px（完整流程在后面单独测）
    assert.ok(!/^[1-9]/u.test(await page.evaluate(() => document.documentElement.style.getPropertyValue('--world-keyboard'))), '软键盘收起时窗口不缩')
    assert.equal(Math.round((await editor.boundingBox()).height), 520, '收起键盘时编辑器占满可用高度')
    await shot('phone-360-vscode-wrap')

    // 滚到底再核一次：行号跟着走，不是只在顶部对
    await editor.locator('.world-vscode-textarea').evaluate(node => { node.scrollTop = node.scrollHeight })
    await page.waitForTimeout(250)
    const scrolled = await gutterState()
    assert.ok(scrolled.scrollTop > 0, '内容确实滚动了')
    assert.equal(scrolled.rows.at(-1).n, scrolled.heights.length, '最后一行一定在视野里')
    assertAligned(scrolled, '滚到底后')
    await shot('phone-360-vscode-wrap-bottom')

    // 关掉换行：行号回到等距，正文重新横向滚动
    await editor.locator('.world-vscode-statusbar .world-vscode-status-wrap').tap()
    await page.waitForTimeout(250)
    assert.equal(await editor.locator('.world-vscode-textarea').evaluate(node => getComputedStyle(node).whiteSpace), 'pre')
    const nowrapRows = await editor.locator('.world-vscode-gutter-row').evaluateAll(nodes => nodes.map(node => ({
      top: node.style.top, height: Math.round(node.getBoundingClientRect().height),
    })))
    assert.deepEqual([...new Set(nowrapRows.map(row => row.height))], [22], '关掉换行后行号恢复等距')
    assert.deepEqual([...new Set(nowrapRows.map(row => row.top))], [''], '关掉换行走容器整体位移，不再逐条定位')
    assert.equal(await editor.locator('.world-vscode-measure').count(), 0, '关掉换行就不留测量层')
    await shot('phone-360-vscode-nowrap')
    await home()
    await switchTo('browser')
    await page.locator('[data-world-browser-address]').fill('https://example.com')
    await page.locator('[data-world-browser-address]').press('Enter')
    const guest = page.locator('[data-world-fake-webview]')
    await guest.waitFor()
    await home()
    assert.equal(await guest.evaluate(node => getComputedStyle(node.parentElement).visibility), 'hidden', 'native guest must suspend on home')
    await switchTo('browser')
    assert.equal(await guest.count(), 1, 'switching apps preserves the browser guest')
    assert.equal(await page.locator('[data-world-browser-address]').inputValue(), 'https://example.com/')
    await shot('phone-360-browser')
    // 手机上拇指要够得着：工具栏图标键 36×36（桌面是 28），地址栏让出这点宽度。
    const caps = await page.locator('.world-browser-toolbar .world-browser-cap').evaluateAll(nodes => nodes.map(node => {
      const rect = node.getBoundingClientRect()
      return `${Math.round(rect.width)}x${Math.round(rect.height)}`
    }))
    assert.deepEqual([...new Set(caps)], ['36x36'], '手机工具栏图标键放大到 36px')
    assert.ok((await page.locator('[data-world-browser-address]').boundingBox()).width >= 150, '地址栏不被挤没')
    // 标签栏的关闭 / 新建键与地址栏高度：桌面是 hover 才露面的 18px，拇指按不出来
    const tabBox = await page.locator('.world-browser-tab.on .world-browser-tab-close').boundingBox()
    assert.ok(tabBox.width >= 24 && tabBox.height >= 24, `标签关闭键 ${tabBox.width}×${tabBox.height}`)
    assert.ok((await page.locator('.world-browser-tab-add').boundingBox()).height >= 32, '新建标签键 32px')
    assert.ok((await page.locator('[data-world-browser-address]').boundingBox()).height >= 32, '地址栏 32px 往上');

    await home()
    await page.getByRole('button', { name: '全部应用', exact: true }).tap()
    // 手机没有 hover：行尾的「打开 / 卸载」过去是 opacity:0 却照样占位可点，等于盲点删除。
    const rowActions = await page.locator('.world-app-card .world-app-open, .world-app-card .world-app-uninstall')
      .evaluateAll(nodes => nodes.map(node => {
        const style = getComputedStyle(node)
        return { opacity: style.opacity, height: Math.round(node.getBoundingClientRect().height) }
      }))
    assert.ok(rowActions.length > 0, '列表里确实有行内按钮')
    assert.ok(rowActions.every(item => item.opacity === '1'), '手机上常显，不靠 hover')
    assert.ok(rowActions.every(item => item.height === 32), '行内按钮 32px 好点')
    await page.locator('.world-plugin-card[data-world-plugin-card="workflow-studio"]').tap()
    await fullApp('[data-world-plugin="workflow-studio"]')
    await page.evaluate(() => {
      const portal = document.createElement('div')
      portal.id = 'phone-plugin-modal'
      portal.innerHTML = '<div role="dialog" style="width:800px;height:700px">Phone plugin dialog</div>'
      document.body.append(portal)
    })
    await page.waitForFunction(() => document.getElementById('phone-plugin-modal')?.dataset.worldDialog === 'workflow-studio')
    const modal = await page.locator('#phone-plugin-modal [role="dialog"]').boundingBox()
    assert.ok(modal.width <= 312 && modal.height <= 472, 'plugin dialogs fit inside the phone app')
    await home()
    assert.equal(await page.locator('#phone-plugin-modal').isVisible(), false)
    await page.evaluate(() => document.getElementById('phone-plugin-modal').remove())
    await page.locator('[data-world-icon-id="terminal"]').tap()
    await fullApp('.world-terminal-window')
    await home()
    await page.locator('[data-world-icon-id="phone-test"]').tap()
    await fullApp('[data-world-app-id="phone-test"]')
    await page.frameLocator('[data-world-app-id="phone-test"] iframe').getByRole('button', { name: 'External phone app' }).tap()
    await home()
    await page.getByRole('button', { name: '切换应用', exact: true }).tap()
    assert.ok(await page.locator('[data-world-phone-window]').count() >= 5)
    await shot('phone-360-apps')
    await page.keyboard.press('Escape')
    await page.locator('.world-phone-switcher').waitFor({ state: 'detached' })
    assert.deepEqual(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.endsWith('.window') || key.endsWith('.position')))), stored)

    for (const width of [390, 520, 600]) {
      await page.setViewportSize({ width, height: 640 })
      const nav = await page.locator('.world-phone-nav').boundingBox()
      assert.ok(nav.x >= 0 && nav.x + nav.width <= width)
      assert.equal(await page.locator('.world-icons').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length), 4)
    }
    // Dragging the outer window passes through small desktop widths before reaching its original size.
    for (const width of [601, 740, 1024]) {
      await page.setViewportSize({ width, height: 640 })
      await page.waitForFunction(() => document.body.dataset.worldLayout === 'desktop')
    }
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.waitForFunction(() => document.body.dataset.worldLayout === 'desktop')
    await page.locator('[data-world-taskbar="dsh"]').click()
    await page.waitForTimeout(200)
    assert.deepEqual(await page.locator('.world-window-frame').boundingBox(), original, 'desktop DSH geometry is restored')
    assert.deepEqual(await page.locator('.world-browser-window').boundingBox(), originalBrowser, 'desktop browser geometry is restored')
    assert.equal(await page.locator('.world-browser-window').evaluate(node => node.inert), false)

    // Boot narrow with desktop rectangles already saved; no phone rectangle is written back.
    await page.setViewportSize({ width: 360, height: 640 })
    await page.reload()
    await page.evaluate(installBrowserProbe)
    await page.addScriptTag({ content: bundleText })
    await page.waitForFunction(() => document.body.dataset.worldLayout === 'phone')
    await page.locator('[data-world-icon-id="dsh"]').tap()
    await fullApp('#root')
    await page.setViewportSize({ width: 601, height: 640 })
    await page.waitForFunction(() => document.body.dataset.worldLayout === 'desktop')
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.waitForFunction(() => document.body.dataset.worldLayout === 'desktop')
    await page.waitForTimeout(200)
    assert.deepEqual(await page.locator('.world-window-frame').boundingBox(), original, 'narrow boot preserves saved desktop geometry')
    await page.evaluate(() => window.__worldTesting.dispose())
    assert.equal(await page.locator('[data-world-phone-hidden]').count(), 0)
    assert.equal(await page.locator('#host-ui').evaluate(node => node.inert), false)

    await page.setViewportSize({ width: 360, height: 640 })
    await page.reload()
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '0px')
      localStorage.setItem('dsh.world.fileLinks', JSON.stringify(Array.from({ length: 40 }, (_, index) => ({
        id: `file:phone-${index}`, name: `文件 ${index}`, path: `/workspace/file-${index}.txt`, type: 'file',
      }))))
    })
    await page.addScriptTag({ content: bundleText })
    await page.waitForFunction(() => document.body.dataset.worldLayout === 'phone')
    const scroll = await page.locator('.world-icons').evaluate(node => {
      node.scrollTop = node.scrollHeight
      return { top: node.scrollTop, height: node.clientHeight, content: node.scrollHeight, width: node.clientWidth, scrollWidth: node.scrollWidth }
    })
    assert.ok(scroll.top > 0 && scroll.content > scroll.height, 'long icon grids scroll vertically')
    assert.equal(scroll.width, scroll.scrollWidth, 'the phone desktop never scrolls sideways')
    await page.locator('.world-icons').evaluate(node => { node.scrollTop = 0 })
    await page.locator('[data-world-icon-id="dsh"]').tap()
    const webApp = await page.locator('#root').boundingBox()
    assert.equal(await page.locator('.world-desktop-titlebar').evaluate(node => node.getBoundingClientRect().height), 0)
    assert.deepEqual(webApp, { x: 0, y: 32, width: 360, height: 560 }, 'web host needs no native caption space')

    // ---- 软键盘 ----
    // 键盘弹起是 200~350ms 的动画，visualViewport 每帧 resize 一次。过去的做法是来一帧改一次
    // 窗口高度：整个界面跟着抖十几下，浏览器还会为了露光标把页面滚一点，两边互相追。
    // 现在只在动画停稳之后落一次高度；这里用假的高度源把整整一段动画重放一遍。
    await page.evaluate(() => {
      const viewport = window.visualViewport
      const state = { height: window.innerHeight, offsetTop: 0, log: [] }
      window.__keyboard = state
      Object.defineProperty(viewport, 'height', { configurable: true, get: () => state.height })
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, get: () => state.offsetTop })
      new MutationObserver(() => {
        const value = document.documentElement.style.getPropertyValue('--world-keyboard')
        if (value && state.log.at(-1) !== value) state.log.push(value)
      }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
      window.__typeKeyboard = (height, offsetTop = 0) => {
        state.height = height
        state.offsetTop = offsetTop
        viewport.dispatchEvent(new Event('resize'))
      }
    })
    const keyboard = async height => {
      await page.evaluate(value => window.__typeKeyboard(value), height)
      await page.waitForTimeout(24)
    }
    const kbLog = () => page.evaluate(() => window.__keyboard.log.slice())
    const rootHeight = async () => Math.round((await page.locator('#root').boundingBox()).height)
    assert.equal(await rootHeight(), 560, '键盘没弹时窗口是整屏的')
    // 地址栏收起那种 ~50px 的位移不是键盘：什么都不该发生
    await keyboard(590)
    await page.waitForTimeout(300)
    assert.deepEqual(await kbLog(), [], '50px 的位移不认成键盘')
    assert.equal(await rootHeight(), 560)
    // 360 屏上一部手机键盘约 280px，一帧一帧长起来
    for (const height of [560, 500, 450, 410, 380, 360]) await keyboard(height)
    assert.deepEqual(await kbLog(), [], '键盘动画期间一个高度都不写：界面不许跟着抖')
    await page.waitForTimeout(420)
    assert.deepEqual(await kbLog(), ['280px'], '键盘停稳后只落一次，落的是最终高度')
    assert.equal(await rootHeight(), 328, '窗口收在键盘上沿（键盘盖住的任务栏那 48px 还给正文）')
    // 键盘弹起时浏览器会把页面往上顶一点（offsetTop）：窗口底边要跟着等于可见区底边，
    // 而且同样只落一次，不能和页面滚动互相追
    await page.evaluate(() => window.__typeKeyboard(360, 40))
    await page.waitForTimeout(420)
    assert.deepEqual(await kbLog(), ['280px', '240px'], '页面被顶起来时重算一次，不来回抖')
    const panned = await page.locator('#root').boundingBox()
    assert.equal(Math.round(panned.y + panned.height), 400, '窗口底边仍然贴着可见区底边')
    await page.evaluate(() => window.__typeKeyboard(360, 0))
    await page.waitForTimeout(420)
    // 收起键盘：动画中间同样不动，最后落一个 0
    for (const height of [420, 500, 580, 640]) await keyboard(height)
    await page.waitForTimeout(420)
    assert.equal((await kbLog()).at(-1), '0px', '收起键盘落 0px')
    assert.equal(await rootHeight(), 560, '键盘收起后回到整屏')
    assert.equal(await page.evaluate(() => document.body.classList.contains('is-keyboard-motion')), false, '键盘收完之后不再给高度加过渡')
    await shot('phone-360-keyboard')
    await page.evaluate(() => window.__worldTesting.dispose())
    assert.deepEqual(errors, [])
    console.log(`Phone desktop passed: ${JSON.stringify(measurements)}; touch launch, home, switching, background inert, guest suspension, saved geometry and cleanup.`)
  } finally { await page.close() }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/phone-browser.mjs')) {
  const { createRequire } = await import('node:module')
  const { build } = await import('../../pbpkg/node_modules/esbuild/lib/main.js')
  const { chromium } = createRequire(new URL('../../workflow-studio/package.json', import.meta.url))('playwright-core')
  const root = new URL('../', import.meta.url)
  const bundle = await build({ absWorkingDir: fileURLToPath(root), entryPoints: ['tests/browser-entry.js'],
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false,
    nodePaths: [fileURLToPath(new URL('../../workflow-studio/node_modules', import.meta.url))], loader: { '.css': 'text' } })
  const browser = await chromium.launch({ executablePath: process.env.WORLD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  try { await checkPhoneDesktop(browser, bundle.outputFiles[0].text, fileURLToPath(new URL('../tmp/phone-shots', import.meta.url))) }
  finally { await browser.close() }
}
