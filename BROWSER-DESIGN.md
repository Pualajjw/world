# world 内置浏览器 · 设计与实施记录

> **状态：P1 已实施（v0.2.38）；v0.2.42 已补真实 Electron 视口回归，完整宿主 P0 验收仍见 §16。**
> 首轮交付仅设计、不改代码；第二轮按 §15 全部推荐默认值 + §7 规格实现：`browser-frame.js` / `browser-app.js` / `styles.css` / `client-src.js` / `app-format.js` / `package.json` / 单测与 Playwright 自检。`index.js` / `cordis.patch.yml` / `build-client.mjs` / dsh 源码**仍未改动**。
> 依据：只读勘察 `world/`（v0.2.36）与 `E:/deepseek-harness`（`apps/desktop/src`、`packages/client/ui-sidebar-browser`）。下面每条关键判断都带文件:行号。
> 配套：现有设计见 [`DESIGN.md`](./DESIGN.md)，外部应用格式见 [`APP-FORMAT.md`](./APP-FORMAT.md)。

---

## 0. 结论先行

**推荐方案：复用 dsh 主进程已有的 `<webview>` guest 租约，在 world 桌面里做一个独立的「浏览器窗口」**，形态贴近 Edge：可拖动/缩放的窗口 + 标签栏 + 地址栏 + 网页内容区。

- 不改 dsh 源码、不加 Host RPC、不加依赖、不引入原生 exe：**world 只调用 preload 已暴露的 `globalThis.dshDesktop.browser`**（`preload-app.ts:24`、`preload-browser.ts:19-31`）。
- 之所以不用普通 iframe：绝大多数公网站点用 `X-Frame-Options` / CSP `frame-ancestors` 拒绝嵌入，而 `<webview>` 是独立顶层 guest，不受这两者限制。
- 代价是必须接受主进程既有的隔离策略（禁下载、禁权限、禁弹窗、禁访问宿主自身端口），这些是**产品限制，不是待修 bug**，见 §2、§14。
- 非 Electron 环境降级为 iframe 兼容模式，并在界面上明确说明「部分网站可能拒绝嵌入」。

新增产物：`browser-frame.js`（纯逻辑）+ `browser-app.js`（窗口组件）+ 一段 CSS + 接线点修改；`index.js` / `cordis.patch.yml` / `build-client.mjs` / dsh 源码**均不动**。差异与自检结果见 §17。

---

## 1. 现状与证据

| 事实 | 证据 |
| --- | --- |
| world 是纯客户端插件，所有内置应用复用 `.world-vscode-window` 窗口壳与 `--vscode-*` 几何变量 | `styles.css:281-310`、`lan-chat-app.js:69-74` |
| 内置应用注册表只有 `vscode` / `lanchat`，保留 id 是 `dsh/vscode/lanchat` | `client-src.js:28`、`app-format.js:8` |
| 桌面图标、开始菜单卡片、任务栏、右键菜单、层级、桌面状态、桌面命令都有固定接线点 | `client-src.js:1229-1245` / `:1269-1292` / `:1084-1112` / `:992-1000` / `:546-561` / `:1114-1135` / `:1146-1190` |
| 现有两个「网页类」应用都是 iframe | `external-apps.js:68`、`lan-chat-app.js:111` |
| 主窗口开启了 `webviewTag`（`primary`） | `main.ts:292` |
| 主进程有一套 guest 租约：按 workspace 分 partition、逐租赁审批 attach、导航白名单、popup/下载/权限全拦截 | `browser-guests.ts:16-170` |
| 租约通过 IPC 对**主窗口主框架**开放，没有限定「只有侧栏浏览器能用」 | `main.ts:828-835` + `assertProductSender` `main.ts:499-506` |
| preload 把 `acquire / release / onOpenRequested` 挂到 `globalThis.dshDesktop.browser`（`protocolVersion === 1`） | `preload-app.ts:18,24,128`、`ui-sidebar-browser/src/client/index.ts:69-72` |
| 侧栏浏览器就是这套契约的现成使用者，可参考其 guest 生命周期与事件 | `ElectronWebViewImpl.ts:144-188`、`ElectronWebviewPresentation.ts:52-61` |
| 主窗口 `window.open(http/https)` 会交给系统浏览器 | `main.ts:296-299` |
| 侧栏浏览器的官方限制清单（下载/权限/popup/Cookie 重启丢失等）同样适用于本方案 | `ui-sidebar-browser/README.zh.md:98-110` |

> 也就是说：**dsh 已经把「在应用内安全浏览任意 http/https 网页」这条最难的链路做完了**，world 缺少的只是一个「像窗口一样的外壳」。

---

## 2. 主进程硬约束（设计必须服从，逐条核对）

| # | 约束 | 出处 | 对设计的影响 |
| --- | --- | --- | --- |
| C1 | 每个 guest 必须先 `acquire(workspace)` 拿 `{lease, partition}`；一个 lease 只能 attach 一次 | `browser-guests.ts:29-42,72-80` | 一个标签 = 一个 lease；**切标签不能销毁再建 DOM** |
| C2 | webview 必须 `src="about:blank#<lease>"`、`partition=<partition>`、`name=<lease>` | `ElectronWebviewPresentation.ts:52-61`、`browser-guests.ts:73-79` | 元素由 JS 创建，React 不负责其 props |
| C3 | 主框架导航只允许 `http:` / `https:`，拒绝内嵌凭据、拒绝「宿主 host 同端口 + localhost/127.0.0.1/[::1]」 | `browser-guests.ts:156-169` | `file:`/`javascript:`/`data:` 全部拒绝；world 自带服务只要**端口不同**仍可打开 |
| C4 | 主框架 `will-frame-navigate` / `will-redirect` 同样过滤；guest 内禁止再嵌 webview | `browser-guests.ts:120-126` | 地址栏与页面内跳转都要走白名单，不能只校验输入 |
| C5 | `target=_blank` 一律 deny，但合法 URL 会通过 `browserOpenRequested` 回传（**带 postBody 的弹窗丢弃**） | `browser-guests.ts:111-119` | 用 `onOpenRequested(lease, cb)` 把弹窗转成「本窗口新标签」 |
| C6 | `will-download` 被 `preventDefault`；权限/设备/屏幕捕获全 false；`disableDialogs: true`；Basic Auth 被拒 | `browser-guests.ts:89,127,141-146` | **不提供下载、摄像头/麦克风/定位、alert/confirm、HTTP Basic 登录** |
| C7 | partition 按 workspace 字符串映射，进程级生命周期，**重启 dsh 后 Cookie/Web storage 清空** | `browser-guests.ts:33-38`、`README.zh.md:110` | 登录态不持久，要在界面里说明 |
| C8 | 主窗口主框架发生导航时 `releaseAll()` 销毁所有 guest | `browser-guests.ts:134-138` | dsh 重载后浏览器窗口要重建 guest，不能假设 lease 还有效 |
| C9 | 获焦 `webview[data-sidebar-browser-frame]` 的输入会转发给 dsh 快捷键系统 | `preload-app.ts:47-51`、`ui-dockkit/TabLayout.tsx:67` | `Ctrl+T` / `Ctrl+L` / `Ctrl+W` 可能被宿主截走，见 §12 探针 |
| C10 | guest 是原生子视图，与 DOM 的 `z-index` / `overflow` / 圆角 / 拖动跟随关系需实测 | `ui-sidebar-right/tests/seat.client.spec.tsx:219`（保活 DOM 的先例） | **P0 探针必须先做**，见 §12 |

---

## 3. 方案对比

| 方案 | 能打开什么 | 改动量 | 代价 / 风险 | 判定 |
| --- | --- | --- | --- | --- |
| **A. 复用主进程 webview 租约** | 绝大多数公网站点（不受 XFO/CSP 约束）+ 非宿主端口的内网页面 | 2 个新模块 + 1 段 CSS + 接线点 | 受 §2 全部约束；只在 Electron 桌面端完整可用；P0 需验证原生视图与 DOM 层级 | ✅ **推荐** |
| B. 普通 iframe（`.worldapp` 同款） | 只有允许嵌入的页面（本机服务、部分文档站） | 最小（约 1 个窗口组件） | 百度/Google/GitHub 等主流站直接白屏，且失败原因浏览器不告知 | ⚠️ 仅作降级 |
| C. Host 侧反向代理剥 `X-Frame-Options` / 重写 CSP | 理论上更多 | 大（HTTP 服务 + HTML/URL 重写 + Cookie/WS/证书） | HTTPS 证书与登录态极难正确；把全部浏览流量经本机 Host 转发，安全与维护成本高 | ❌ 不做 |
| D. 只加一个「打开侧栏浏览器」入口 / 预置 `.worldapp` | 侧栏 tab | 几行 | 不是「world 桌面里的浏览器窗口」，且 iframe 方案仍受 XFO 限制 | ❌ 不满足需求 |

> 与 dsh 自带**侧栏浏览器**的关系：能力同源、形态互补。侧栏是「贴着某个会话的 tab」，world 的是「桌面上可多开、可拖动的窗口」。首版不 import 侧栏浏览器包（避免把它的 React/store/slot 依赖打进 world，撑大 tgz），只复用主进程的**租约契约**。

---

## 4. 架构与数据流

```
world 桌面（shell.overlay，同一棵 React 树）
└─ BrowserWindow  key='browser:win1'   ← 复用 .world-vscode-window 外壳
   ├─ 标题栏 32px     拖 / 双击最大化 / — □ ×        （现有窗口键）
   ├─ 标签栏 36px     tab1 tab2 …  +                  （自绘）
   ├─ 地址栏 40px     ← → ⟳ ⌂  [ https://… ]  ↗      （自绘）
   └─ 内容区          每个 tab 常驻一个 <webview>       （只切 visibility）
                       │
        ┌──────────────┴───────────────┐
        │ globalThis.dshDesktop.browser │   preload（无 Host RPC、无插件 IPC）
        │  acquire(workspace)           │──→ 主进程 DesktopBrowserGuests
        │  release(lease)               │      · 按 workspace 建 partition
        │  onOpenRequested(lease, cb)   │      · 审批 attach / 导航白名单
        └──────────────┬───────────────┘      · 拦 popup / 下载 / 权限
                       │ lease + partition
                       ▼
        <webview src="about:blank#lease" partition=… name=lease
                 data-sidebar-browser-frame="webview" allowpopups>
                 → dom-ready → clearHistory() → loadURL(target)
```

**三档渲染后端**（`browser-frame.js` 用同一个 `BrowserFrame` 接口屏蔽差异）：

| 环境 | 后端 | 说明 |
| --- | --- | --- |
| Electron 桌面 + `dshDesktop?.protocolVersion === 1` + `browser` 可用 | `webview` | 完整能力，§2 约束生效 |
| Web profile / 桥缺失 / `acquire` 抛错 | `iframe` | sandbox 与侧栏浏览器 Web 版一致；地址栏进入「未知 URL」态后禁用前进后退 |
| 用户显式禁用 / 环境不支持网页嵌入 | 空态卡片 | 明确说明原因与「在系统浏览器打开」入口 |

`workspace` 默认取固定字符串 `world:desktop-browser`（独立 partition，不与侧栏浏览器的 `cwd:<path>` 分组共享登录态；见 §15 待拍板 3）。

---

## 5. 组件与接线点（已实施，清单保留作索引）

### 新增文件

| 文件 | 职责 | 依赖 |
| --- | --- | --- |
| `browser-frame.js` | 地址解析（对齐 `ui-sidebar-browser/src/client/browser/url.ts:25-45`）、tab 状态机、lease 池与释放、webview/iframe 事件归一、上限与错误码 | 零 React、零宿主 import，可单独 `node --test` |
| `browser-app.js` | `BrowserGlyph` + `BrowserWindow`（标题栏/标签栏/地址栏/内容区/错误页），props 对齐现有 `LanChatWindow` | React |
| `tests/browser-frame.test.js` | URL 白名单、lease 释放、tab 上限、状态迁移、降级 | node:test |
| `tests/browser-frame.browser.mjs` | 挂到 `tests/browser.mjs` 的自检（桩 `globalThis.dshDesktop.browser`） | Playwright |

### 现有文件接线点

| 位置 | 改动 |
| --- | --- |
| `app-format.js:8` | `RESERVED_IDS` 增加 `browser`，防止 `.worldapp` 覆盖内置应用 |
| `client-src.js:28` | `KNOWN_APPS` 增加 `browser`；`readInstalledApps` 决定默认安装策略（§15-4） |
| `client-src.js:266-314` / `:700-900` | 新增 `browserWindows` 数组与 `openBrowser / closeBrowser / minimizeBrowser / toggleMaximizeBrowser` 及拖动/缩放（`clampVscodeRect` 可直接复用） |
| `client-src.js:546-561` | `data-world-active-kind` 增加 `browser` 分支 |
| `client-src.js:647-661` / `:992-1000` | `restoreWindow`、右键菜单分发增加 `browser` |
| `client-src.js:1084-1135` | `taskbarWindows` 每个窗口一格（标签取当前 tab 标题）；`desktopState.apps` 增加 `{id:'browser',…}`，`windows[].state` 增加 browser 分支；**URL / 页面标题不进 desktopState** |
| `client-src.js:1146-1190` | `open_app` 支持 `appId:'browser'`（只打开/置顶，不接受模型传 URL）；`focus/minimize/maximize/restore_window` 走同一套 windowId |
| `client-src.js:1229-1245` / `:1269-1292` / `:1361-1390` | 桌面图标、开始菜单「应用」分组卡片、窗口渲染各加一项 |
| `client-src.js:323-336` | `observeDesktopInput` 之外，webview 元素上单独监听焦点以触发 `control.takeOver()`（§12 探针） |
| `styles.css` | 新增 `.world-browser-*` 段（窗口壳复用 `.world-vscode-window`），并补 `body[data-world-active-kind="browser"]` 的 z-index 规则，照抄 `styles.css:883-887` 的三行模式 |
| `package.json` | `files` 增加两个新模块与本文档；版本号 `0.2.36 → 0.2.37`（按仓库发布链） |
| `README.md` / `DESIGN.md` | 增补功能说明与分期状态 |
| **不动** | `index.js`（无需 Host RPC）、`cordis.patch.yml`、`build-client.mjs`（esbuild 会自动内联新 import）、dsh 源码、`lan-chat/`、`.worldapp` 格式 |

体积估算：新增源码约 8–12 KB，`client.js`（minify 后）增量约 4–6 KB；无二进制、无第三方依赖。

---

## 6. 状态与生命周期

```
应用：installedApps.has('browser')
窗口：browserWindows = [{ key, rect, state: normal/max/min, lastOpen,
                         tabs: [tabId], activeTabId }]
标签：tabs[tabId] = { id, target:{url,title}, address:'requested'|'observed'|'unknown',
                      loading, error, canGoBack, canGoForward,
                      mode:'webview'|'iframe', lease, element }
```

| 事件 | 行为 |
| --- | --- |
| 打开窗口 / 新标签 | 新建 tab → `acquire('world:desktop-browser')` → 创建 webview 元素 → 等 `dom-ready` → `clearHistory()` → `loadURL(target)`；首文档是租约引导页，不算历史 |
| 切换标签 | **不销毁 DOM**，只切容器 `visibility`（对齐 dsh 侧栏浏览器 `keepMounted` 做法），保留页面状态与 Chromium 历史栈 |
| 关闭标签 / 窗口 / 卸载 | 先移除元素，再 `release(lease)`；`release` 失败要记录但不阻塞 UI |
| 最小化 | 整窗用 `visibility: hidden`（`styles.css:293` 同款），**不用 `display:none`**，避免 guest 视口被量成 0 |
| 最大化 | 只改 CSS 变量，不动 rect；撤掉 8 个缩放手柄（与 `ExternalAppWindow` 一致） |
| 主窗口导航 / dsh 重载 | C8 会销毁所有 guest：窗口保留，tab 回到 `requested` 态并重新 acquire；不假装还能续上 |
| 插件热重载 / 桌面层卸载 | 遍历 tabs 逐个 `release`，`finally` 里保证不泄漏 |

**上限（建议值，待确认）**：单窗口 **8** 个标签、最多 **3** 个浏览器窗口（合计 ≤ 24 个 guest）。理由是每个 guest 是独立渲染进程；触顶时提示「请先关闭一个标签」，不静默丢页。标签位置/窗口几何写 `localStorage['dsh.world.browser.window']`，与现有 `dsh.world.vscode.window` / `dsh.world.lanchat.window` 命名一致。

---

## 7. 界面规格（具体数值，已按建议默认值实施）

沿用现有深色窗口 token，避免另起一套视觉语言（`DESIGN.md:264-279`、`styles.css:281-310`）。

| 部位 | 规格 |
| --- | --- |
| 窗口 | 默认 `80vw × 80vh`，最小 `720 × 480`，圆角 `8`（最大化 0），`1px #383838` 边，阴影 `0 26px 66px rgba(0,0,0,.65)` |
| 标题栏 | 高 `32`，底 `#252526`，字 `12px`；右侧 `40×32` 三键，只有关闭 hover `#c42b1c` |
| 标签栏 | 高 `36`，底 `#252526`；标签 `min 160 / max 220`、圆角 `6 6 0 0`，活动标签底 `#1e1e1e` + 顶部 `2px #4CC2FF`；`+` 键 `28×28`；关闭键 hover 才出现 |
| 地址栏 | 高 `40`，底 `#1e1e1e`，下边 `1px #333`；`28×28` 图标键 5 枚（后退/前进/刷新/主页/在系统浏览器打开）、间距 `4px`；输入框高 `26`、圆角 `13`、底 `#2b2b2b`、聚焦 `1px #4CC2FF`、字 `12px` |
| 加载条 | 地址栏下沿 `2px`，accent 色，`did-start-loading` → `did-stop-loading` |
| 内容区 | 铺满剩余高度，底色 `#fff`（页面自身底色优先）；webview/iframe `width/height:100%`、`border:0` |
| 状态/错误 | 失败页居中卡片：`ERR_*` 原话 + 原因（DNS/TLS/被策略拒绝）+「重试」「在系统浏览器打开」两键；不显示假进度 |
| 提示条 | 兼容模式 / 不支持下载 / Cookie 不持久，各一条 `28px` 高琥珀底单行提示，可关闭，同一时刻只显示一条 |

> 以上数值已全部实现，并在 `tests/browser-frame.browser.mjs` 里逐项做像素断言（实测：窗口 `1024×640 @128,76`、标题栏 `32`、标签栏 `36`、地址栏 `40`、输入框 `26`/圆角 `13`/底 `rgb(43,43,43)`、活动标签顶边 `2px rgb(76,194,255)`、窗口圆角 `8px`/边 `rgb(56,56,56)`）。自检 PNG：`prototype/shots/browser-home.png`、`browser-page.png`、`browser-tabs.png`。
> 实施补充：浏览器窗口是 portal 直属节点，不在 `.world-window-frame *` 的 `box-sizing` 覆盖内，因此加了 `.world-browser-window * { box-sizing: border-box }`，否则 1px 边框会把 36/40/26 量成 37/41/28。

---

## 8. 交互矩阵

| 操作 | 行为 |
| --- | --- |
| 地址栏输入 `example.com` | 补 `https://`；`http/https` 之外、内嵌 `user:pass@`、> 16384 字符、宿主自身 origin → 拒绝并在输入框下给一句中文原因（规则对齐 `url.ts:25-45`） |
| `Enter` / `Esc` | 导航 / 还原为当前已观测 URL 并失焦 |
| 后退 / 前进 / 刷新 / 主页 | `goBack` / `goForward` / `reload` / 回到内建起始页（`about:blank` 引导页不算历史）；按钮按 `canGoBack/canGoForward` 置灰 |
| 页面内点链接 | 同标签导航；`did-navigate` / `did-navigate-in-page` 同步地址栏与标题 |
| `target=_blank` | 主进程 deny 原生窗口并回传 URL → `onOpenRequested` → **在本窗口开新标签**；带 postBody 的弹窗被丢弃（C5），给一次轻提示 |
| 标签关闭 / 中键 | 关标签并释放 lease；关最后一个标签时保留一个空白新标签页（不自动关窗） |
| 「在系统浏览器打开」 | `window.open(currentUrl, '_blank')` → 主窗口 `setWindowOpenHandler` 交给 `shell.openExternal`（`main.ts:296`）；这是下载、登录、权限受限时的统一逃生口 |
| 下载链接 | **不支持**：拦截提示条「内置浏览器不支持下载，请在系统浏览器中打开」，不写盘、不代理 |
| `alert/confirm` / 权限 / Basic Auth | 主进程静默拒绝，提示条说明「页面请求的能力被桌面安全策略禁用」 |
| 点网页内容 | 触发 `control.takeOver()` 交还桌面控制权（webview 的 pointerdown 不冒泡到 document，需单独挂监听） |
| 快捷键 | P1 不注册全局快捷键，全部靠工具栏；`Ctrl+L/T/W` 归属由 P0 探针实测（C9） |

---

## 9. 安全与隐私边界

1. **不读页面正文、不注入脚本、不代理流量**：world 只拿 URL、标题、加载状态、导航事件；页面内容与 Cookie 留在 guest 自己的 partition。
2. **不引入写盘能力**：下载由主进程禁止，world 也不实现「另存为」，因此不需要 sandbox policy 写权限。
3. **不给模型浏览能力**：`desktopState` 不上报标签 URL/标题（避免把用户浏览内容带进模型上下文）；`world_desktop_action` P1 只支持 `open_app('browser')` 与窗口类操作，**不新增 `navigate` / `open_url`**（与 `ui-sidebar-browser/README.zh.md:89-96` 的「无模型体验」一致）。若要开放，见 §15-5。
4. **登录态隔离且短命**：独立 `workspace` key；Cookie 与 Web storage 只在 dsh 进程生命周期内有效，重启清空，界面上明说。
5. **降级 iframe 的 sandbox**：`allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox`（与侧栏浏览器 Web 版一致），且不读取跨域 iframe 的新 URL。
6. **不碰 `.worldapp` 的安全模型**：新增保留 id `browser`，外部包无法覆盖；地址栏白名单与 C3/C4 双层校验，不依赖用户输入做过滤。

---

## 10. 接入桌面子系统清单

| 子系统 | 接入方式 |
| --- | --- |
| 应用目录 | `id='browser'`，与 VSCode / 局域网聊天并列；默认安装、可卸载（待拍板 4） |
| 桌面图标 | 双击打开；右键「打开 / 卸载」（主应用 `dsh` 仍只显示「打开」） |
| 开始菜单 | 「应用」分组第三张卡片，安装态显示「打开 / 卸载」 |
| 任务栏 | 每个浏览器窗口一格，标签取当前 tab 标题（截断），最小化态 62% 透明 + 8px 灰线 |
| 层级 | `data-world-active-kind="browser"`，复制 `styles.css:883-887` 的规则：其它窗口降 `z-index:3`、`#root` 降 `2`、DSH 窗口框 `3`；任务栏 `100` / 开始菜单 `101` 保持最上 |
| 弹窗归属 | 浏览器窗口自绘的菜单/提示都在窗口内 `absolute`，不走宿主 body portal，因此不需要 `data-world-dialog` 规则 |
| 桌面状态 | `apps[].installed`、`windows[].state` 上报；不含 URL/标题/正文 |
| 桌面命令 | `open_app` 支持 browser；窗口类动作复用现有 `windowId` 流程 |

---

## 11. 降级路径

| 检测 | 结果 |
| --- | --- |
| `globalThis.dshDesktop?.protocolVersion === 1 && typeof dshDesktop.browser?.acquire === 'function'` | 完整 webview 模式 |
| `acquire()` 抛错 / 返回结构不合法 | 该 tab 降级为 iframe，窗口顶部常驻兼容模式提示条，可一键重试 |
| 无 `dshDesktop`（Web profile、`tests/browser-entry.js` 的 Playwright 环境） | 全部 iframe 模式；单测与浏览器自检走这条路径 |
| 用户所在环境连 iframe 都受限 | 空态卡片 +「在系统浏览器打开」，不显示白屏 |

---

## 12. 测试与验收

### P0 技术探针（**原计划先于实现；实际因本机无可运行的 dsh Electron 而顺延，必须在装机后补跑**）

> 状态说明：P1 代码已写完，但 §16 的真机探针仍**未执行**，所以 C10（原生视图与 DOM 关系）仍是未验证的架构风险。下面的清单与判定标准不变，只是验收时点后移。

在真机 Electron 里用一个最小页面/最小窗口验证 6 件事，每项留下结论再动手：

1. `acquire('world:desktop-browser')` 能否成功；`webview` 能否 `did-attach-webview` 并 `dom-ready`。
2. 打开一个明确拒绝 iframe 的站点（如 `https://example.com` 与一个带 `X-Frame-Options` 的站），确认 guest 正常渲染。
3. **原生视图与 DOM 层级**：webview 是否被窗口 `overflow:hidden` + `border-radius:8px` 正确裁切；是否盖住 `z-index:100` 的任务栏 / `101` 的开始菜单；拖窗、8 边缩放时是否跟随。
4. 最小化用 `visibility:hidden` 是否真的隐藏 guest；`display:none` 是否会导致尺寸塌成 0。
5. 焦点与快捷键：点 webview 时 `document` 是否收到事件；`Ctrl+L` / `Ctrl+T` / `Ctrl+W` 落到 guest 还是被 dsh 快捷键系统接走；`control.takeOver()` 用哪种事件最可靠。
6. `window.open(url,'_blank')` 是否确实交给系统浏览器；主窗口重载后 lease 是否如 C8 失效、`onOpenRequested` 是否把 `_blank` 正确回传。

> 第 3、5 项若不达标，方案 A 需要调整（例如给窗口内容区加交互遮罩 / 调整 dataset 标记 / 缩小窗口壳），**这是本设计唯一的架构级不确定点**。

### 单元与自检

- `node --test tests/browser-frame.test.js`：地址白名单（协议、凭据、长度、宿主 origin）、tab 状态迁移、上限 8/3、lease 释放次数为 1 且不重复、`acquire` 失败的降级。
- Playwright（`tests/browser.mjs` + `tests/browser-entry.js` 桩 `dshDesktop.browser`）：窗口几何、标签切换不重建元素、卸载释放 lease、最小化不销毁、任务栏/开始菜单/层级、地址栏像素与颜色断言；按项目习惯附**自检 PNG + 实测像素值**。
- 打包：按仓库既有链 `buildall.bat` → tgz → 重建 `index.json` → tgz 安装实测（装机需重启 dsh）。

---

## 13. 分期

| 阶段 | 范围 |
| --- | --- |
| **P0** | 设计定稿 ✅；§12 的 6 项真机探针 ⏳ 待装机补跑（见 §16） |
| **P1（首版）** | 单窗口、多标签（上限 8）、webview/iframe 双后端、地址栏与导航五键、新标签/关闭、任务栏/图标/开始菜单/右键/层级、desktopState 与 `open_app`、单测 + 自检 |
| **P2** | 多窗口（上限 3）、书签与最近访问（localStorage）、`page-favicon-updated` 图标、加载进度条、快捷键归属优化、错误页文案细化 |
| **P3（可选）** | 与侧栏浏览器共享登录态（改用 `cwd:<path>` key）、模型可控的受限导航动作（域名白名单 + controlId）、下载逃生口增强 |

---

## 14. 已知限制（必须写进 README，不藏着）

- 不支持下载、文件上传后的下载回执、摄像头/麦克风/定位/通知/剪贴板授权、`alert/confirm/prompt`、HTTP Basic 登录、原生新窗口（C5/C6）。
- Cookie / Web storage 不跨 dsh 重启；默认不与侧栏浏览器共享登录态（C7）。
- 打不开 dsh 自身服务端口（C3 的 `isApplicationHost`）；`file:` / `javascript:` / 本地文件一律拒绝。
- 公网页面在 guest 里是**独立进程**，内存随标签数增长；超过 8/3 上限会提示先关标签。
- 原生视图与 DOM 的裁切/层级/焦点归属、宿主快捷键抢占，以 P0 探针结论为准。
- iframe 兼容模式下，多数站点仍会因 `X-Frame-Options` 白屏；跨域导航后地址栏进入「未知」态，前进后退不可用。
- 主窗口重载会销毁 guest，页面内的表单内容、未提交输入不会恢复。
- 不提供无痕/多账户、扩展、开发者工具、打印、PDF 预览。

---

## 15. 决策（已按推荐默认值全部拍板）

| # | 决策 | 已定（= 原推荐） | 影响 |
| --- | --- | --- | --- |
| 1 | 渲染后端 | **A：复用主进程 webview 租约**；iframe 仅作降级 | 决定整套架构；选 B 则大量公网站点不可用 |
| 2 | 首版范围 | **单窗口 + 多标签（上限 8）**，多窗口放 P2 | 决定 `browserWindows` 是单对象还是数组、任务栏编号逻辑 |
| 3 | 登录态 | **独立 partition `world:desktop-browser`**（重启清空，不共享侧栏浏览器） | 选共享则需按会话 CWD 取 key，跨会话行为难解释 |
| 4 | 安装形态 | **默认已安装、允许卸载**（像 Win11 自带 Edge）；老配置自动补 `browser` | 影响 `readInstalledApps` 的迁移逻辑 |
| 5 | 模型可操作性 | **P1 只可打开/切换窗口，不可导航、不读 URL/标题** | 若要求模型能打开指定网址，需要新增动作 + 域名白名单 + 审计，属另一档安全设计 |

另：§7 默认尺寸与配色全部采纳。实现时按接线点分批落地，最后统一出自检 PNG 与实测像素（见 §7 补充）。

---

## 16. P0 真机探针（**尚未执行，装机后必须补跑**）

最初的 Playwright 自检使用模拟 guest，无法证明真实 Electron 的渲染结果。v0.2.42 补充 `npm run test:native`，在独立 Electron 44.7.0 进程中复用 `browser-guests.ts` 原生租约策略，验证内容视口、宽/长页滚动、最大化还原、标签保活、重定向和禁止 iframe 嵌入的页面。发现并修复 `display:block` 使内部 iframe 保持默认 150px 高的问题：同一外框 1022×530px 下，改为 `display:flex` 后实际网页视口为 1022×530px。

§12 的完整宿主探针属于**架构级验收**，不能靠模拟 guest 代替。装机重启 dsh 后，在主窗口 DevTools Console 逐段粘贴（这些片段只创建临时 DOM，不改插件代码；跑完刷新页面即可清掉）：

```js
// ① 租约与 attach：应打印 {lease, partition} 且 webview 触发 dom-ready
const bridge = globalThis.dshDesktop?.browser
const reservation = await bridge.acquire('world:desktop-browser')
const probe = document.createElement('webview')
probe.setAttribute('src', 'about:blank#' + reservation.lease)
probe.setAttribute('partition', reservation.partition)
probe.setAttribute('name', reservation.lease)
probe.setAttribute('allowpopups', '')
probe.dataset.sidebarBrowserFrame = 'webview'
probe.style.cssText = 'position:fixed;left:200px;top:160px;width:640px;height:400px;z-index:9999'
probe.addEventListener('dom-ready', () => { console.log('dom-ready OK', probe.getURL()); probe.loadURL('https://example.com/') })
probe.addEventListener('did-fail-load', e => console.warn('fail-load', e.errorCode, e.errorDescription))
document.body.append(probe)
```

```js
// ② XFO 站点：确认不是白屏（example.com 会返回 X-Frame-Options 的对照站点）
probe.loadURL('https://github.com/')   // 观察渲染；iframe 方案在这里必白屏

// ③ 裁切 / 层级 / 拖窗：把窗口壳改成圆角容器，看四角是否被裁；
//    再打开开始菜单（z-index 101）和任务栏（100），看 webview 是否盖住它们。
probe.style.borderRadius = '8px'
probe.style.overflow = 'hidden'
// 手动拖动 / 缩放 world 浏览器窗口，看原生视图是否跟着走（不跟随就是 C10 不达标）

// ④ 最小化：比较 visibility:hidden 与 display:none 下 probe.getBoundingClientRect().width
probe.style.visibility = 'hidden'
probe.getBoundingClientRect().width        // 应仍为 640
probe.style.visibility = ''
probe.style.display = 'none'
probe.getBoundingClientRect().width        // 会变成 0 → 所以实现里禁用 display:none
probe.style.display = ''

// ⑤ 焦点与快捷键：点 webview 后看 document 是否收到 pointerdown；
//    依次按 Ctrl+L / Ctrl+T / Ctrl+W，记录是 guest 响应还是被 dsh 快捷键系统接走。
document.addEventListener('pointerdown', e => console.log('document pointerdown', e.target.tagName), { once: true })

// ⑥ 逃生口与 lease 失效：window.open 应交给系统浏览器；主窗口重载后
//    旧 lease 必须失效（C8），页面内表单内容不恢复属于预期。
window.open('https://example.com/', '_blank')
await bridge.release(reservation.lease)   // 收尾：别忘了归还探针租约
probe.remove()
```

**判定**：③（裁切 / 层级 / 拖窗跟随）与 ⑤（快捷键归属）若不过，方案 A 需要调整（内容区加交互遮罩、缩小窗口壳、或调整 `data-sidebar-browser-frame` 标记）。首版已做防御：开始菜单打开或其它应用窗口在前台时把整组 viewport 设为 `visibility:hidden`，并在 guest 上挂 `pointerdown`/`focus` 调 `control.takeOver()`；这不等于探针通过。

---

## 17. 实施差异与验收

| 项 | 结果 |
| --- | --- |
| 新增文件 | `browser-frame.js`、`browser-app.js`、`tests/browser-frame.test.js`、`tests/browser-frame.browser.mjs`、`prototype/shots/browser-*.png` |
| 修改文件 | `client-src.js`、`styles.css`、`app-format.js`、`package.json`、`tests/browser.mjs`、`README.md`、`DESIGN.md`、本文档 |
| 未改 | `index.js`、`cordis.patch.yml`、`build-client.mjs`、`lan-chat/`、`.worldapp` 格式、dsh 源码 |
| 单测 | `node --test tests/*.test.js` → **77/77 通过**（其中浏览器新增 12 项） |
| 浏览器自检 | `node tests/browser.mjs` → 全部通过；新增 `checkBrowserWindow`：租约 3 个全部恰好归还、切标签不重建 DOM、8 标签上限、最小化 `visibility:hidden` 且视口不塌成 0、`window.open` 逃逸口 |
| 构建 | `node build-client.mjs` → `client.js` 243 KB（无新依赖、无二进制） |

**有意偏差（比原设计更保守）**：§10 原计划任务栏标签取当前 tab 标题，但 `desktopState.windows[].name` 直接来自任务栏 label，会把用户浏览内容带进模型上下文，与 §9-3 冲突。实现改为**任务栏固定显示「浏览器」**，隐私优先；窗口内部标签栏仍显示页面标题。

**未做（明确留给后续）**：P2 多窗口（上限 3）、书签/最近访问、favicon、加载进度条（首版只有 2px 循环条）、真机 P0 探针、快捷键归属优化、模型可控导航。
