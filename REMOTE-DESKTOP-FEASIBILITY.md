# world 内置「远程桌面」应用 · 可行性分析

> 范围：仅做可行性分析，**不写实现代码**。结论基于当前 `world` 插件（`@local/dsh-world` v0.2.28）的真实架构。
> **配套方案与体积预算见 [`REMOTE-DESKTOP-SCHEMES.md`](./REMOTE-DESKTOP-SCHEMES.md)**（按「world 插件不能变太大」约束收敛；核心发现：dsh 自带 LiveShare 子系统，dsh↔dsh 双向可近零插件成本复用）。
> 仓库里那个 `electron-srd-preview` 与远程桌面**无关**——它是 pypower 的 PBL 本地预览桌面壳（用 Windows 原生文件选择器打开本地库文件），不是屏幕共享原型，已排除。

---

## 1. 结论先行（TL;DR）

**可行，但分两档难度：**

- **应用壳接入：低风险、低成本。** world 已有成熟的「内置应用」模式（局域网聊天就是模板），远程桌面可以直接复用：一个 Host 侧服务 + 一个客户端窗口（iframe 指向本机服务）+ 端口 RPC。这部分没有新架构风险。
- **真正的难点不在这里，而在三件事：**
  1. **原生输入注入**（让别人的控制落到本机鼠标/键盘上）—— 这与 world「纯客户端插件、不碰系统窗口、没有原生 exe」的定位**正面冲突**。（**P0 实测后此点已大幅降级**：Host 子进程自带 koffi，可直接 FFI 调 user32 注入，见 1.5 节实测 2。）
  2. **跨网连通（WAN）**—— 若要做到「远程别的电脑（不在同一局域网）」，必须有 STUN/TURN 中继 + 公网信令/ rendezvous 服务，是一笔持续的基础设施投入。
  3. **安全模型**—— 远程控制 = 把本机控制权交给对端，必须做强鉴权、逐次授权、明显状态提示、随时断开。

**推荐分期：** 先用「局域网内、且仅控制 world 窗口」的最小 MVP 验证 WebRTC 管线（绕开原生注入），跑通后再上 OS 级截屏 + 原生输入注入，最后再考虑跨网。

---

## 1.5 P0 探针实测结果（已用 dsh 源码验证，非推测）

> 探针方式：只读 dsh 源码（`E:/deepseek-harness`）与已装运行时（`D:/.../DeepSeek Harness 0.2.1-rc.3/`），**未写任何实现代码**。下面每条都有文件:行号证据。

### 实测 1：world 的 Host 跑在「独立 Node-mode 子进程」，不是 Electron 主进程
- 证据：`apps/desktop/src/host-process.ts:157` 注释「One Web backend running under the Electron executable in **Node mode**」；`:212` 用 `spawn(this.node, [...,'dsh-desktop-host/lib/index.js',...])` 起子进程，`stdio:[...,'ipc']` 与主进程通信。
- `apps/desktop-host/src/index.ts` 就是这个子进程入口：`ctx.plugin(...)` 加载插件、`ctx.connection.browserPeer`、`ctx.webServer`——world 的 `index.js` 就跑在这里。
- **推论：** Host 子进程**没有** `desktopCapturer`（那是 Electron **主进程** API，子进程无 GUI/主进程上下文）。原分析「Host 是 Electron 主进程、可直接 desktopCapturer」的假设**不成立，需修正**。

### 实测 2：输入注入比预想容易得多 —— Host 子进程自带 koffi（FFI）
- 证据：`apps/desktop-host/package.json:14` 依赖 `"koffi": "3.1.1"`；`apps/desktop-host/src/windows-cli-signals.ts:11` 已经 `koffi.load('kernel32.dll')` 调 Windows API。
- **推论：** 在 world 的 Host 子进程里可直接 `koffi.load('user32.dll')` 调 `SendInput` / `SetCursorPos` / `keybd_event` 做 OS 级输入注入，**无需编译原生 addon、无需额外签名**（koffi 是随 dsh 分发的纯 JS+预编译 FFI）。
- **这把原分析的「坑 1（输入注入=最大风险）」降级为「较容易」**。（待验证：world 插件能否 resolve 到 koffi，或需自带一份 koffi 依赖。）

### 实测 3：dsh 在 Windows 上没有现成的「computer-use」截屏/控制实现
- 证据：`packages/computer-use/computer-use/src/index.ts` 只是个**命名 provider 注册表**（`ComputerUseRegistry`），不含任何截屏/键鼠实现；真正实现是 `experimental/cua-macos`（**macOS Swift**）或外部「Cua Driver」。
- `native/system/docs/support-matrix.md:14` 明确「**Windows has neither a Landlock launcher nor this POSIX addon**」，`native/system/packages/` 只有 `darwin-arm64/darwin-x64`。
- **推论：** Windows 上**不能复用** dsh 现有 computer-use 做远程桌面；截屏/输入得自己解决（输入注入见实测 2 已解决）。

### 实测 4：客户端 `getDisplayMedia` 截屏被 dsh 桌面**拒绝/未配置**（截屏反成瓶颈）
- 证据：`apps/desktop/src/browser-guests.ts:145` `browserSession.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })`——**回调空对象 = 拒绝屏幕捕获**；同函数 `:142-144` 还 `setPermissionCheckHandler(()=>false)`、`setDevicePermissionHandler(()=>false)` 全面收紧。全仓库**仅此一处** displayMedia handler，主窗口 session 未配置可用 handler。
- **推论：** world 客户端（无论主窗口 renderer 还是内置应用 iframe/webview）目前**无法直接用 `getDisplayMedia` 截屏**。要么改 dsh 主进程放行（**超出 world 插件能力，需 dsh 配合**），要么在 Host 子进程用 koffi 调 GDI(`BitBlt`)/DXGI 自截屏（自给自足但需自己做编码/推流）。

### 实测结论对原分析的影响（两处反转）
| 能力 | 原推测 | 实测后 |
| --- | --- | --- |
| 输入注入（OS 级） | ⚠️ 最大风险，需原生 addon+签名 | ✅ **较容易**：Host 子进程 koffi FFI 调 user32 |
| 屏幕捕获 | ✅ Electron desktopCapturer 可用 | ⚠️ **变难**：Host 非主进程用不了 desktopCapturer；客户端 getDisplayMedia 被 dsh 拒绝，需改 dsh 主进程或 Host 用 koffi 自截 |

**净结论不变（整体可行），但难点从「输入注入」转移到「屏幕捕获」；最省力的截屏路径需要 dsh 主进程配合放行 `getDisplayMedia`，否则走 Host 侧 koffi GDI/DXGI 自截屏。**

---

## 2. 需求理解（两种解读）

你说「world 中加一个内置应用，可以被远程桌面远程，也可以远程别的电脑」。我按最可能的理解展开，并在第 9 节给出更轻的替代方案。

| 方向 | 含义 | 谁在采集屏幕 | 谁在注入输入 |
| --- | --- | --- | --- |
| **A. 被远程（server）** | 别人连上本机，看到并控制本机画面 | 本机（desktopCapturer / getDisplayMedia） | 本机 Host 把对端指令注入 OS |
| **B. 远程别人（client）** | 本机连上别人，看到并控制对方画面 | 对端机器 | 对端 Host 注入其 OS；本机只发鼠标/键盘事件 |

「双向」= 同一个应用既能当 A 也能当 B，按会话角色切换。

---

## 3. world 现有架构与「内置应用」接入方式

从 `index.js` / `README.md` / `DESIGN.md` / `lan-chat-app.js` 确认：

- **world 是 dsh 的客户端插件**，桌面控件 portal 进宿主 `#root`，自身是 React 渲染（无原生窗口）。
- **但它有 Host 侧（Node/Electron 进程）**：`index.js` 用 `ctx.connection.fetch.register` 注册 HTTP 端点，跑文件读写、Git（经 `ctx.inject(['subprocess'])`）、以及**局域网聊天的 UDP 发现 + HTTP/SSE 服务**。
- **dsh 客户端跑在 Electron 里**（DESIGN.md 明确提到 Electron 原生拖动区、原生标题栏），所以 Host 侧具备完整 Node + Electron 原生能力——这是「能做到远程桌面」的前提。
- **内置应用的固定套路（以局域网聊天为例）：**
  - Host：`lan-chat/server.mjs`，UDP 广播发现 + HTTP 消息服务，并**直接 serve 一个网页**；
  - 客户端：`lan-chat-app.js` 是一个独立窗口，内容区是 `iframe` 指向本机服务（`http://127.0.0.1:<port>/`）；
  - 端口通过 `world-lan-chat/port` 这个 RPC 查询。

**结论：** 远程桌面应用 = 再写一套 `(remote-desktop)/server.mjs`（serve UI + WebRTC 信令 + 原生输入注入）+ 一个 `remote-desktop-app.js`（窗口 + iframe + 端口 RPC）。**接入形态零创新风险**，完全对齐既有模式。

---

## 4. 两个方向各需要什么

### 方向 A：world 作为被控端（被远程桌面远程）
- **采集本机画面：** Electron 主进程 `desktopCapturer.getSources()` → 拿到桌面/窗口媒体流，经 WebRTC 发给对端；或在渲染进程用 `getDisplayMedia`（需授权）。能截到**整个 OS 桌面**，而不仅是 world 窗口。
- **把对端输入落到本机：** 必须**原生输入注入**（mouse/keyboard），只能由 Host（Electron 主进程）完成——例如打包一个原生 addon（`@jitsi/robotjs` / `iohook`，或 Windows `SendInput` 的轻量 helper）。**这是核心风险点，见第 5、6 节。**

### 方向 B：world 作为控制端（远程别的电脑）
- **显示对端画面：** 收到 WebRTC 媒体流，用 `<video>`/canvas 渲染。纯前端，可行。
- **发送本机输入：** 在 world 窗口内捕获鼠标/键盘事件并发给对端。纯前端，可行；**真正注入发生在对端 Host**。

> 双向的本质：两端都装这个应用；控制端的输入事件走网络到被控端的 Host，由被控端原生注入 OS。

---

## 5. 关键技术选型

| 能力 | 推荐方案 | 说明 |
| --- | --- | --- |
| 传输/编码 | **WebRTC**（`RTCPeerConnection` + H.264/H.265 硬件编码） | 屏幕共享的事实标准，DTLS 默认加密，延迟低。不要自研「HTTP + JPEG 差分」，会卡。 |
| 截屏 | ~~Electron `desktopCapturer`~~ → 实测不可用（Host 非主进程）。改走：① 改 dsh 主进程放行 `getDisplayMedia`；② Host 子进程 koffi 调 GDI/DXGI 自截 | **P0 实测**：截屏反成瓶颈，见 1.5 节实测 1/4 |
| 信令 | Host 侧 WebSocket / SSE 端点交换 SDP+ICE | 复用 world 既有 HTTP 服务即可，无需新基建（LAN 场景）。 |
| 发现 | 扩展局域网聊天的 UDP 广播，附带「远程桌面」服务宣告 | LAN 内零成本自动发现。 |
| 输入注入 | **koffi FFI 调 `user32.dll` 的 `SendInput`/`SetCursorPos`**（Host 子进程已带 koffi 3.1.1） | **P0 实测**：无需编译原生 addon，见 1.5 节实测 2 |

---

## 6. 最难的三个坑（可行性闸门）

### 坑 1：原生输入注入 —— 与 world 定位冲突（**P0 实测后已降级**）
- world 的设计原则是「**纯客户端插件、不碰系统窗口、没有原生 exe**」。要让别人控制你的机器，必须注入 OS 级鼠标/键盘。
- **实测缓解（1.5 节实测 2）：** Host 子进程自带 koffi 3.1.1，且已用 `koffi.load('kernel32.dll')`。可直接 `koffi.load('user32.dll')` 调 `SendInput`/`SetCursorPos`/`keybd_event`，**不需要编译原生 addon、不需要额外签名**——koffi 是随 dsh 分发的现成 FFI。
- **残留风险：** ① world 插件能否 resolve 到 koffi（或需自带一份依赖）待验证；② 「无原生 exe」原则仍被轻微触碰（虽无自研 exe，但行为上注入了 OS 输入），安全审计口径需确认。

### 坑 2：跨网连通（WAN）
- **局域网内：** WebRTC host-candidate P2P 直接通，沿用 UDP 发现，几乎零基础设施。
- **跨互联网（远程别的电脑，不同网络）：** 必须 STUN（免费，用于发现公网 IP/端口）+ **TURN 中继**（直连失败时兜底，需你自己运营或买商业中继）+ **公网可达的信令/rendezvous 服务**（让两端相遇）。这是持续成本与运维负担。
- **决策点：** 第一版只做 LAN，还是必须支持 WAN？WAN 会把工作量翻数倍并引入运维。

### 坑 3：安全模型（远程控制 = 把机器交给别人）
- 必须：会话级强鉴权（限时配对码 / 设备配对）、**逐次显式授权 + 明显的「正在被控制」指示**、随时一键断开、对端 allow-list、无持久后门、可审计。
- world 客户端是受信任的 dsh 上下文，开放监听服务会扩大攻击面——服务应绑 loopback + 中继，或对每次连接做强校验。
- WebRTC 自身 DTLS 加密可用，但**鉴权与授权逻辑得自己写扎实**。

---

## 7. 可行性判定

| 维度 | 判定 | 依据 |
| --- | --- | --- |
| 应用壳接入（窗口/iframe/端口 RPC） | ✅ 低风险 | 局域网聊天已验证的同款模式 |
| 屏幕采集（OS 级） | ⚠️ 需绕行 | **P0 实测**：Host 非主进程用不了 desktopCapturer；客户端 getDisplayMedia 被 dsh 拒绝，需改 dsh 主进程或 Host 用 koffi GDI/DXGI 自截 |
| 控制端发输入 / 显示对端 | ✅ 可行 | 纯前端 WebRTC |
| 被控端输入注入（OS 级） | ✅ 较容易 | **P0 实测**：Host 子进程 koffi FFI 调 user32，无需编译原生 addon |
| 局域网内互通 | ✅ 可行 | UDP 发现 + WebRTC P2P |
| 跨互联网互通 | ⚠️ 可行但需基建 | STUN/TURN + 公网信令 |
| 安全合规 | ⚠️ 需重点设计 | 控制权移交，必须强授权 |

**总体：技术上完全可行；商业/工程上真正的成本在「原生输入注入 + 跨网基建 + 安全设计」这三块，而不是应用壳。**

---

## 8. 推荐分期路线

- **Phase 0 · 技术探针**
  - [x] **源码层探针已完成（见 1.5 节）**：Host 是独立 Node-mode 子进程（非主进程）、子进程自带 koffi 可 FFI 注入、Windows 无现成 computer-use、客户端 getDisplayMedia 被 dsh 拒绝。
  - [ ] **运行时验证（需跑 dsh，仍可不写业务代码）**：① world 插件能否 `import 'koffi'`（不能则自带依赖）；② 实测 world 窗口里 `getDisplayMedia` 的真实报错（确认被拒）；③ 用最小 WebRTC 样例在两个本机窗口间传一路视频，验证管线。
  - [ ] **决策**：截屏走「改 dsh 主进程放行 getDisplayMedia」（需 dsh 配合）还是「Host 子进程 koffi GDI/DXGI 自截」（自给自足但需自做编码）。
- **Phase 1 · LAN-only MVP（控制 world 窗口，不注入 OS）**
  - 复用局域网聊天发现模型，新增 RD 服务宣告；
  - 双向 WebRTC：一端采集 world 窗口、另一端渲染，控制端输入先只作用于 world 窗口 DOM；
  - **目的：零原生代码跑通整条 WebRTC + 信令 + 发现链路**，把最大不确定性先消掉。
- **Phase 2 · OS 级远程桌面（真·双向）**
  - 截屏按 Phase 0 决策落地：要么 dsh 主进程放行 `getDisplayMedia`，要么 Host 子进程 koffi 调 GDI/DXGI 自截整个桌面；
  - 输入注入用 **koffi FFI 调 user32**（实测可行），被控端把对端指令注入 OS；
  - 补齐安全模型（配对码、授权提示、断开）。
- **Phase 3 · 跨网（可选）**
  - 加 STUN/TURN + 公网 rendezvous；或改为「经中转服务器中继」的简化架构。

---

## 9. 更轻的替代方案（若目标只是「能连上已知机器」）

如果你的真实意图是「在 world 里点一下就能 RDP/VNC 到某台已知机器」，**不必自研**：
- 直接做一个**内置应用指向现有 Web RDP/VNC 客户端**（如 noVNC / Apache Guacamole 网关）的 URL，沿用 `.worldapp` 或内置应用窗口即可；
- 优点：零原生代码、零信令自研、工时极小；
- 缺点：只能是**控制端**（你远程别人），且依赖对端已有 RDP/VNC 服务 + 一个网关；做不到「被别人远程」和「P2P 直连」。

---

## 10. 需要你拍板的决策点

1. **范围**：先 LAN-only，还是要一上来支持跨互联网？
2. **控制粒度**：第一版只控制 world 窗口，还是要 OS 级桌面（决定何时引入原生输入注入）？
3. **是否接受 world 引入原生输入注入组件**（打破「无原生 exe」原则，涉及签名/杀软）？
4. **安全基线**：配对码 / 设备配对 / 企业账号体系，哪一层起步？
5. **形态**：做成真正的双向 P2P 应用，还是只是个「启动 Web RDP 客户端」的轻量内置应用（第 9 节）？

把这 5 点定了，就能把 Phase 0 探针和 Phase 1 范围精确化。
