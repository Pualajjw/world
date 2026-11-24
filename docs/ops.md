# 进程、存储与网络

[返回 README](../README.md) · [功能总览](../README.md#功能)

这些窗口看的是 DSH 自己这一摊：它起了哪些进程、占了哪些端口、哪些缓存可以清、EasyTier 通不通，以及 world 怎么升级。

## 进程管理器

从开始菜单打开「进程管理器」。进程范围固定为**当前 DSH 实例及其子进程**，按父子关系与创建时间识别，不会按可执行文件名字把其他 DSH 实例或其他软件混进来。桌面版以 Electron 主进程为根，命令行宿主以当前宿主进程为根。「进程」页只读；「存储与清理」页提供 DSH 专属目录统计及经确认的缓存、临时文件和旧日志清理，没有结束进程入口或 RPC。

- 表格显示名称、PID、CPU、工作集和专用内存；点击列标题排序，搜索支持名称、PID、角色。选中一行可查看父 PID、路径、线程和句柄数。
- CPU 使用两次采样的处理器时间差除以采样间隔和逻辑核心数，与整机 0–100% 的口径一致；首次采样显示「采样中」。同一 PID 创建时间改变后重新采样。工作集合计包含共享页，不能当作唯一物理内存占用。
- 自动刷新间隔 2 秒，慢请求不会重叠。支持暂停与手动刷新；最小化、页面隐藏、关闭时停止自动轮询。失败保留上次数据和更新时间，并提供刷新重试。
- 文件查询接收现有文件的完整路径：Windows 使用 [Restart Manager](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/nf-restartmanager-rmgetlist)，Linux 按 DSH 进程的 `/proc/<pid>/fd` 比较文件身份，macOS 使用 `lsof` 并复核进程身份。未查到 DSH 占用不代表其他程序未占用，文件夹暂不支持。
- Windows 使用 PowerShell；Linux 使用 `/proc` 和 `getconf CLK_TCK`；macOS 使用系统 `ps/lsof`。不自动提权，查询有超时；权限不足或工具缺失时明确报错。Linux 的内存补充列显示匿名驻留量（RssAnon），不混称 Windows 的专用内存；macOS 未提供的线程、句柄和专用内存显示「—」。
- 复用默认 80vw×80vh、最小 720×480px 的窗口；正文 13px，桌面行高/按钮 36px，手机 44px。存储页使用三张卡片及 240px 目录栏；窄屏单列滚动，底部保留清理操作。
- 存储只扫描服务端识别的 DSH 根目录：安装路径由当前可执行文件或 CLI 包确定，用户目录遵循 `DSH_HOME`、`APPDATA`、`XDG_CONFIG_HOME` 及 macOS Application Support。AppImage 按镜像文件统计，不计临时挂载副本；无法识别安装路径时提示未计入。目录不重叠计数、不跟随符号链接；硬链接按文件身份去重。统计是文件逻辑大小，可能与文件系统实际占用/释放量不同。单次最多 20 万条、120 秒，停止或读取失败时明确显示部分结果。
- 可清理类别限定为 `cache/attachments/request-images`、`attachments/v1/tmp`、DSH 与桌面 `logs` 中的旧日志。保留最近访问或修改在 7 天内的文件；不扫描整块磁盘或整个用户主目录，也不清理其他程序。选择类别 → 预览文件数和大小 → 确认 → 清理结果 → 自动重新统计。清理只逐文件 unlink，不递归删除目录；预览 5 分钟过期且不可重放，执行时复核根目录、路径、文件身份和时间。操作系统拒绝删除的文件会列出原因，取消时保留已完成结果。

验证：`node --test tests/process-manager.test.js tests/process-manager-unix.test.js tests/storage-manager.test.js`；`node tests/process-manager-browser.mjs`；`npm run test:storage`；`node tests/browser.mjs`。设置 `WORLD_PROCESS_SHOTS_DIR` 可输出浅色、深色和手机截图。清理测试仅操作隔离临时目录；本机真实数据验证只扫描、不删除。Linux/macOS 真机测试在对应平台运行时启用，Windows 上明确跳过。

## 端口占用与网络状态

EasyTier 已连接时，任务栏右侧显示网络图标，点击直接打开或还原「上网」配置窗口。图标复用现有 40×40px 任务栏按钮及 20px 网络图标；独立于配置窗口检测，支持打开桌面前已建立的连接，断开或查询失败后隐藏。连接依据为 EasyTier CLI 的已连接节点列表与系统网卡上分配的虚拟 IPv4，不把进程存在当作已连接；每次查询只读取 peer 列表，不读取含密钥的节点配置。进程管理器增加「端口占用」页，显示 DSH 进程及其子进程的 TCP/UDP、IPv4/IPv6、本地端口、远端端口、状态、进程名和 PID，支持筛选、手动/自动刷新及暂停，查询失败保留上次结果。Windows 使用系统 TCP/UDP 表，Linux 通过 procfs socket inode 关联进程，macOS 使用 lsof；均按进程树和创建时间过滤，查询只读。验证：`node --test tests/internet-connection.test.js tests/process-ports.test.js tests/process-manager.test.js tests/process-manager-unix.test.js`、`npm run test:internet`、`npm run test:ports`、`npm run test:internet:runtime`。Windows 验证真实 TCP/UDP 监听与 DSH 宿主端口，Linux/macOS 解析及归属有夹具测试，真机测试需在对应系统运行。

## 上网（EasyTier）

开始菜单增加「上网」：填写 EasyTier 程序目录、本机 IP、网络密钥和节点地址，保存配置或直接「启动上网」，可以停止连接、查看实时日志、暂停滚动和清空日志。程序目录默认 `D:\easytier-windows-x86_64`，IP 默认 `10.192.168.3`，节点默认 `udp://118.178.196.123:11010`；密钥由用户填写并保存在本机，不随插件分发。参数直接传给 `easytier-core.exe`，不经过 shell；兼容粘贴的 `udp\://`。关闭窗口保留连接，禁用插件时停止进程；窗口最小化或页面隐藏时暂停日志轮询。日志遮住密钥、保留最近 64K 字符，分别标出 stdout/stderr，并显示退出码。创建 Wintun 网卡需要管理员权限，权限不足时页面提示以管理员身份启动 DSH。沿用 world 窗口与资源管理器样式，桌面输入框 36px、手机 44px、间距 12px、内边距 16px。验证：`node --test tests/internet.test.js`、`npm run test:internet`、`npm run test:internet:runtime`（隔离的真实 DSH 宿主中验证入口、配置保存和错误显示）。

手机连接底部增加「复制地址」，复制与二维码相同的完整连接 URL。支持 Clipboard API 和局域网 HTTP 页面的兼容复制，显示复制中、已复制或失败提示；切换网卡后复制最新地址。网卡候选通过 Node 的跨平台 `networkInterfaces()` 获取，支持 Windows 网卡、macOS 的 en0/utun、Linux 的 enp*/wlan*/tun 等名称以及 IPv4 family 的字符串/数字形式；按地址元数据排除内部回环、链路本地、未指定和组播地址并去重，保留 EasyTier、Tailscale 等虚拟网卡供手动选择，不按名称过滤 VPN。EasyTier 上网支持 Windows/macOS/Linux：Windows 调用 `easytier-core.exe`，macOS/Linux 调用 `easytier-core`；填写当前系统的程序目录或留空从 DSH 的 PATH 查找，macOS/Linux 默认留空，文件执行权限及网络设备权限错误显示对应提示。需要安装与宿主系统/CPU 匹配的 EasyTier；上网进程在运行 DSH 的电脑上执行。验证：`node --test tests/internet.test.js tests/mobile-access.test.js`、`npm run test:mobile-connect`、`npm run test:internet`、`npm run test:mobile`；三平台的路径、程序名及网卡数据有契约测试，macOS/Linux 真机运行需在对应系统执行。

Windows 上「启动上网」先检测当前进程的实际管理员令牌；DSH 未提升权限时，点击启动会弹出 Windows UAC 授权，仅把 EasyTier 启动助手与 EasyTier 提升为管理员。界面等待授权，取消后可以重试；密钥与启动参数通过带随机凭据的本机命名管道传递，不写入提权命令行或临时脚本。提权后的 stdout/stderr 仍回到原窗口，停止按钮通过管道结束该实例；Windows Job Object 在宿主或助手异常结束时回收它管理的进程。已经以管理员启动的 DSH 直接运行。macOS 检查 root，Linux 检查 root 或当前进程有效的 CAP_NET_ADMIN；权限不足时在启动前提示处理。验证：`node --test tests/internet-privileges.test.js tests/internet-elevated.test.js tests/internet.test.js`、`npm run test:internet`、`npm run test:internet:runtime`。Windows 上用真实 PowerShell 助手验证日志、参数、停止和宿主异常退出回收，自动化测试不弹出 UAC；实际提权由用户点击并批准系统授权。

## 启动项

**进程管理器 → 启动项**：统一查看和管理「局域网聊天」「助手生活线」「手机连接」和「上网（EasyTier）」。前两项沿用默认开启，手机连接默认关闭，上网沿用原配置。关闭会保留条目；删除仅移出启动列表，应用、配对密钥和当前连接不变，可在「可添加的应用」中重新加入。以上操作只影响下次 World 后台启动，和浏览器恢复上次的桌面窗口无关。

## 上网自启动

**上网自启动**：在「上网」勾选「随 World 启动上网」并保存配置，下次 World 后台启动时会用这份配置连接一次。默认关闭，旧配置不会自动开启。Windows 仍可能提示管理员授权；失败不会循环重试，可在上网窗口查看原因并手动启动。运行中也可取消勾选并保存，不会断开当前连接。

## 调试日志

**开始 → 调试日志**：查看当前 World 桌面中内置应用的请求、应用间调用和 PB 运行/打包阶段。按应用、级别或关键词筛选；点「复制 #调用号」复制该次调用的所有尚保留步骤，不受筛选限制。仅记录状态、方法、耗时和退出码，不抓取请求正文、命令行或原始输出。每个桌面单独在内存中保留最近 1000 条，刷新页面即清空；成功的后台轮询只计数，失败不省略。窗口可见时最多每 300ms 刷新一批，每页最多渲染 50 行；暂停只冻结视图，不停止收集。回归及百万条压力测试：`npm run test:debug-log`。

## 检查更新与内置升级

任务栏左下显示 `world v… · DSH v… · 检查更新`。DSH 版本来自当前实例 `profileContext.installAnchor` 指向的应用清单，无法读取时显示「版本未知」，不会用 Node/Electron 版本代替。

- 点击「检查更新」显示当前版本、更新来源、源中版本和升级操作。弹层沿用设置样式：560px 宽、20px 内边距、8px 圆角；窄屏两侧留 12px。检查不会自动安装。
- 当前 profile 安装了 pbpkg 时使用它的当前源；pbpkg 禁用、接口不可用或源中没有 world 时提示处理原因，不切换到其他来源。读取并校验 TGZ 后复核包名为 `@local/dsh-world`、插件声明和版本。
- 未安装 pbpkg 时使用指定 GitHub 仓库的 HEAD。读取完整提交号，再读取该提交的 `package.json`；安装同一个提交，避免检查后分支前进导致安装内容变化。源中版本低于本地时只提示，不降级。
- 升级确认后使用当前 DSH 插件管理器，保留它的安装互斥、版本兼容性检查与构建脚本审批。前后端均防止重复提交，候选信息 10 分钟过期；成功后重启 DSH 激活新版本。升级过程中关闭弹层不重发安装，重开时查询原任务或已安装版本。
- 开发目录链接可查看版本和检查更新，但不直接自升级；先通过 TGZ 或 GitHub 安装后再使用升级按钮。宿主更新开发链接可能影响源码目录，因此服务端同时检查依赖规格和真实运行路径。
