# diteng agent

[项目官网](https://itjun.github.io/diteng-agent/) · [下载安装包](https://itjun.github.io/diteng-agent/#download)

帝擎 ERP 的 Electron 桌面壳客户端：账号密码登录（记住密码/自动登录双勾选，历史登录账号可下拉选择、逐条删除/清空）→ 内嵌 web ERP 多标签（采用 Dia 风格的标签侧栏 + 网页内容双栏布局，侧栏默认 224px，可拖宽、双击复位，收起时网页内容铺满窗口；工作区只承载 Web 页面，⌘/Ctrl+T 新建标签直接打开 ERP 首页，标签支持右键管理与同名序号；侧栏顶部横排「消息」「Chat」「信息」快捷入口，下方为标签列表；消息和 Chat 直接打开并复用当前账套的 Web 页面，信息展示本机硬件与网络；顶部工具栏提供复制链接、反馈和功能设置菜单，侧栏开关固定在右侧顶部通栏的最左端；在账号设置中打开网页版账套选择，切换成功后自动关闭其他标签；账号设置提供重新登录，确认后关闭业务标签回到登录页（离线也可本地退出）；连接设置只读展示服务器地址，服务器仅在构建时选择；用户与账套信息集中在账号设置中）→ MQTT 消息系统通知/置顶弹窗/托盘；一键反馈：顶部工具栏「反馈」截整窗画面（含当前页面）→ 壳内标注编辑器（箭头/矩形/椭圆/画笔/文字/矩形马赛克，撤销重做，Esc 取消、Enter 复制）→ 复制到系统剪贴板并一键打开微信/企业微信，粘贴发送给客服（不模拟按键、不自动发送）。快捷键：`⌘/Ctrl+B` 展开收起侧栏、`⌘/Ctrl+,` 进入设置页、`⌘/Ctrl+T` 新建标签、`⌘/Ctrl+W` 关闭当前标签、`Ctrl+Tab` / `Ctrl+Shift+Tab` 切换标签（webview 内焦点同样生效）。内容区是「地址栏 + 网页」同一张悬浮卡片（16px 圆角、四边 5px 外围色留白，上/下/右等宽），地址栏底色自动跟随网页内容取色（Dia 式），顶部展示页面名称与域名，复制页面链接会去掉会话参数并保留业务条件；收起侧栏后仍可从顶部功能菜单打开消息、AI 助手和本机信息，设置分类复用标签侧栏，退出设置恢复原来的标签栏收起状态。UI 采用 deepseek-harness 桌面版设计语言（`--dsw-*` 主题 token，macOS 侧栏 vibrancy 毛玻璃）。

## 技术栈

Electron 44 · TypeScript · React 18 · Vite（renderer）+ tsc（main/preload）· CSS Modules · mqtt.js · electron-builder

## 常用命令

```bash
./build.py          # macOS 打包 main 环境、安装到 /Applications 并启动
./build.py --env dev # macOS 打包开发环境、安装并启动
pnpm install        # 安装（electron 二进制失败时用 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）
pnpm dev            # 开发环境：rc.local.lan；vite(5173) + electron（改动 main/preload 需重启）
pnpm dev:main       # 开发流程连 main 环境（m.cdcp.site）：不在 192.168.0.x 内网时的开发入口
pnpm typecheck      # 四个 tsconfig 全量检查
node --test scripts/test-*.mjs  # 构建环境、账号隔离、展示、账套核验与通知队列回归
python3 scripts/test-macos-build.py # macOS 构建工具链预检回归
pnpm build          # main 环境构建到 dist/
pnpm build:dev      # 开发环境构建到 dist/
pnpm dist:mac       # main 环境 mac arm64 dmg；dist:win 为 Windows nsis
pnpm dist:mac:dev   # 开发环境 mac arm64 dmg；dist:win:dev 为 Windows nsis
```

`build.py` 需要 Python 3、Node.js、pnpm 和 Xcode 26+（原生分层图标通过 `actool` 编译），可从任意目录通过脚本路径运行（也可用 `python3 build.py`）。自动匹配本机 Apple Silicon / Intel 架构，本机打包默认跳过应用签名、公证和安装时的签名校验，保留用户配置；加 `--no-launch` 可在安装后跳过启动。`pnpm dist:mac` 和 `pnpm dist:mac:dev` 同样使用这套不签名配置。DMG 安装包保留在 `release/`，构建失败时不会替换已安装应用。

若系统当前选中 Command Line Tools，`build.py` 会自动从 `/Applications` 和 `~/Applications` 中寻找 `Xcode*.app`，仅通过本次构建的 `DEVELOPER_DIR` 使用完整 Xcode；自定义安装位置可显式设置该变量，不需要修改系统的 `xcode-select` 设置。

应用图标采用白底绿色品牌标志，源文件为 `build/appicon.icon/`：macOS 26+ 使用系统原生的浅色、深色、透明与染色外观，旧版 macOS 使用生成的 ICNS；Windows 使用 `build/icon.png`。菜单栏使用无底板的黑色透明模板图，并提供 Retina `@2x`，随系统菜单栏自动着色。在 macOS 上执行 `node scripts/make-icons.mjs` 可从源文件重建 ICNS、PNG 和托盘资源；Windows 构建直接使用已入库资源。

应用采用单实例运行：重复启动时新进程立即退出，并显示、还原和聚焦已有的登录窗或主窗；主窗隐藏到托盘后再次启动也会回到原窗口。

## 构建环境

| 环境 | 固定服务器地址 |
| --- | --- |
| main（默认） | `https://m.cdcp.site` |
| dev（开发） | `http://rc.local.lan` |

环境由构建命令显式选择，不随 Git 分支自动变化。构建结果写入 `dist/build-environment.json` 并随安装包分发；运行时环境变量、本地 `config.json`、登录请求与历史账号均不能切换服务器。登录页不提供地址输入，连接设置仅展示当前地址。

安装包切换环境时清除旧环境的自动登录凭据，保留设备标识与按原服务器归属的历史账号；同环境升级保留登录凭据。历史账号列表、密码回填、删除与清空仅作用于当前构建环境。

## e2e 真机验证（CDP 驱动真实应用）

当前构建环境验收使用 `e2e-build-environment.mjs`。下列其余历史脚本仍含可变服务器地址的旧假设，尚未适配，不作为本次验收入口；适配时须改用测试进程内的网络桩。

```bash
cp scripts/e2e-secrets.example.mjs scripts/e2e-secrets.mjs   # 填入测试账号（已 gitignore）
(pnpm exec vite &) && (pnpm exec electron . --remote-debugging-port=9223 &)
node scripts/e2e-layout.mjs        # Dia 双栏布局/拖宽/重启/主题/反馈；E2E_MOCK=1 自动启动隔离本地 mock
node scripts/e2e-build-environment.mjs # 当前构建的登录/短信地址锁定、设置只读与重新登录（全 mock；先 pnpm build 或 pnpm build:dev）
node scripts/e2e-single-instance.mjs # 重复启动退出、登录窗复用、并发登录防多窗、最小化/托盘恢复与退出后重启（临时 userData + 全 mock；先 pnpm build）
node scripts/e2e-shell-core.mjs    # 高频入口、硬件信息、公网 IP 失败恢复、消息状态、开关防重、离线重新登录（临时 userData + 本地 mock；先 pnpm build）
node scripts/e2e-desktop-coordination.mjs # 账套切换事务与跨账套紧急提醒（临时 userData + 私有 Vite + 本地 mock；先 pnpm build）
node scripts/e2e-autologin.mjs     # 记住密码/自动登录全链路（含杀进程重启）
node scripts/e2e-account-history.mjs  # 历史账号：迁移/选择回填/多服务器/删除/清空（临时 userData + 本地 mock + 独立 9224）
node scripts/e2e-nav-ai.mjs        # 同域链接补 sid + AI Web Chat 打开与复用
node scripts/e2e-web-logout.mjs    # 网页版退出入口 → 外壳退出回登录窗；E2E_MOCK=1 走本地 mock
node scripts/e2e-corp-sync-run.mjs # 网页版切账套 mock 编排（会话同步 + 关闭其他标签；自动备份/还原 config）
node scripts/e2e-feedback.mjs      # 一键反馈：截图 → 标注编辑器（绘制/撤销/马赛克）→ 复制到剪贴板 / 启动聊天应用桩（隔离 userData + 独立 9224）
node scripts/e2e-page-chrome.mjs   # 悬浮卡片几何（四边 5px/16px 圆角）+ 地址栏跟随网页底色（隔离 9228 + 全 mock）
node scripts/e2e-notify.mjs        # MQTT 通知 + 置顶弹窗
node scripts/verify-vibrancy.mjs   # 毛玻璃透光差分（黄/蓝背景板）
```

历史脚本原有运行方式（适配前勿直接执行）：脚本会接管运行中的应用环境（按需自动重启 vite/electron）。`e2e-account-history.mjs` 使用临时 userData 与独立 CDP 端口 9224，不会接管 9223 上的真实 dev 应用、也不改写真实 `config.json`。`e2e-corp-sync-run.mjs` 会临时改写真实 `config.json`（先备份到 /tmp，结束后原样还原并校验 sha256）并重启 9223 应用；期间所有登录/换票请求只发往本地 mock。`e2e-feedback.mjs` 同样用临时 userData + 9224 隔离实例，会临时占用系统剪贴板（结束后尽力还原），用主进程 inspector（9230）读回剪贴板图片做不透明度/像素与 webview 内容校验；「打开微信/企业微信」在主进程内用 `execFile`/`openExternal` 桩验证调用参数，不会真正拉起应用，真实粘贴发送留人工验证。`e2e-page-chrome.mjs` 用临时 userData + 独立 CDP 9228/主进程 inspector 9231，自起本地 mock 并自动 tsc/拉起 electron，不访问生产、不占用 9223。

## 版本与发布

设置 → 关于和托盘「检查更新」使用同一更新状态。默认启动时及每 6 小时检查 GitHub Releases，自动下载可关闭；下载后必须确认保存工作，再重启安装，不会在普通退出时静默安装。开发运行与 dev 环境安装包不接收正式更新。

`release-policy.json` 的 `minimumVersion` 是最低支持的**客户端版本**（不是操作系统版本），初始为 `0.2.4`。发布时会写入所有平台更新清单。低于该版本时登录、已有网页的业务请求和打开页面均被阻断，更新要求缓存在本机，断网重启仍有效。该限制不能替代服务端兼容性校验；首次离线且从未取得策略时允许继续使用。

```bash
pnpm test                          # 包含版本状态机与发布文件校验
pnpm build && node scripts/e2e-updates.mjs # 本地 HTTP + Electron 真实检查/下载/哈希校验；安装调用用桩隔离
pnpm dist:linux                    # Linux deb x64/arm64；dev 环境用 dist:linux:dev
pnpm release patch --dry-run       # 预演下一版本，不改文件、不推送
pnpm release patch                 # 检查 → 提升版本 → 原子提交与标签推送 → 三平台自动构建发布
pnpm release 0.3.0                 # 也可指定稳定版本
```

当前 macOS 安装包未使用 Apple 开发者证书签名，也未公证；首次打开可能受到 macOS 安全设置拦截。macOS 自动更新的安装步骤依赖系统签名校验，当前免签版本应下载 DMG 手动安装，不保证自动安装可用。Linux deb 安装更新可能请求系统管理员授权。

`.github/workflows/release.yml` 在 main/PR/手动运行时构建测试包，在 `v版本号` 标签时正式发布。macOS 生成 arm64/x64 DMG 与 ZIP，Windows 生成 x64 NSIS，Linux 生成 x64/arm64 deb。每个平台在原生 runner 上测试更新检查、下载和当前架构安装包启动，更新安装调用使用桩；Linux 还用 apt 安装 x64 deb。各平台更新清单、架构完整性与文件 SHA-512 全部校验成功后，才创建并公开完整 GitHub Release。测试运行不公开版本。若 CI 失败，修复后重跑失败任务；不要移动已公开的版本标签。跨架构包有构建和清单验证，实际升级替换仍需目标系统验收。

## 结构

- `src/main/` 主进程：窗口/标签 URL 策略/会话（safeStorage 存密文）/MQTT/托盘/打包配置/启动微信与企业微信
- `src/preload/` contextBridge 白名单 API（`window.diteng`）
- `src/renderer/` 登录页 + 主窗壳（rail 标签栏/用户卡片/设置页/通知弹窗/截图标注编辑器）
- `src/shared/` 三方契约类型

侧栏顶部「消息」打开 Web 消息页 `FrmMyMessage`，「Chat」打开现有 AI 助手的 `/{corpNo}/chat`，两者携带当前会话并优先复用已打开的标签，连续点击不重复创建页面。「信息」展示电脑名称、硬件 UUID、CLIENTID、系统、CPU、内存、磁盘、显示器、网络接口、MAC、DNS 和公网 IP，支持刷新、逐项复制和复制全部；返回浏览时保留原 Web 实例。

硬件 UUID 从操作系统读取，与首次启动生成并持久化的 CLIENTID 分开显示，不改变现有登录设备标识。公网 IP 按需通过 [ipify](https://www.ipify.org/) 查询当前网络出口，遵循客户端代理设置，不携带登录凭据或设备标识；5 秒超时或返回异常时显示失败，其他本机信息仍可查看。

通知设置统一展示实时接收状态、全账套未读总数、上次成功同步时间，并支持立即同步和本机测试通知。测试通知不会创建业务消息或改变未读数，系统权限与专注模式仍可能阻止显示。账套入口优先激活已有 Web 标签；设置中的消息入口同样打开并复用 Web 消息页。
