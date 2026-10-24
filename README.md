# diteng agent

帝擎 ERP 的 Electron 桌面壳客户端：账号密码登录（记住密码/自动登录双勾选，历史登录账号可下拉选择、逐条删除/清空）→ 内嵌 web ERP 多标签（左侧竖向标签栏默认 224px，可拖宽、双击复位，收起后保留 76px 窄栏；新建标签进入本地起始页，标签支持右键管理与同名序号；侧栏常驻消息中心、未读数、当前账套和登录身份；点击当前账套打开网页版账套选择，切换成功后自动关闭其他标签；账号设置提供重新登录，连接设置提供更换服务器入口，确认后关闭业务标签回到登录页（离线也可本地退出）；用户身份与设置齿轮独立操作）→ MQTT 消息系统通知/置顶弹窗/托盘；一键反馈：工具栏「反馈」把整窗画面（含当前页面）截图到系统剪贴板，直接粘贴给客服。快捷键：`⌘/Ctrl+B` 展开收起侧栏、`⌘/Ctrl+,` 进入设置页、`⌘/Ctrl+T` 新建标签、`⌘/Ctrl+W` 关闭当前标签、`Ctrl+Tab` / `Ctrl+Shift+Tab` 切换标签（webview 内焦点同样生效）。内容区是「地址栏 + 网页」同一张悬浮卡片（16px 圆角、四边 5px 外围色留白，上/下/右等宽），地址栏底色自动跟随网页内容取色（Dia 式），顶部展示页面名称与域名，复制页面链接会去掉会话参数并保留业务条件；工具栏 AI 助手图标按外围颜色着色。UI 采用 deepseek-harness 桌面版设计语言（`--dsw-*` 主题 token，macOS 侧栏 vibrancy 毛玻璃）。

## 技术栈

Electron 44 · TypeScript · React 18 · Vite（renderer）+ tsc（main/preload）· CSS Modules · mqtt.js · electron-builder

## 常用命令

```bash
pnpm install        # 安装（electron 二进制失败时用 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）
pnpm dev            # 开发：vite(5173) + electron（改动 main/preload 需重启）
pnpm typecheck      # 四个 tsconfig 全量检查
node --test scripts/test-shell-presentation.mjs scripts/test-desktop-coordination.mjs  # 展示、账套核验与通知队列回归
pnpm build          # 构建 main/preload/renderer 到 dist/
pnpm dist:mac       # 打 mac arm64 dmg（release/）；dist:win 为 Windows nsis 配置
```

## e2e 真机验证（CDP 驱动真实应用）

```bash
cp scripts/e2e-secrets.example.mjs scripts/e2e-secrets.mjs   # 填入测试账号（已 gitignore）
(pnpm exec vite &) && (pnpm exec electron . --remote-debugging-port=9223 &)
node scripts/e2e-layout.mjs        # rail 标签栏/拖宽/标签/设置页；E2E_MOCK=1 走本地 mock
node scripts/e2e-shell-core.mjs    # 身份/账套入口、消息状态、开关防重、离线重新登录（临时 userData + 本地 mock；先 pnpm build）
node scripts/e2e-desktop-coordination.mjs # 账套切换事务与跨账套紧急提醒（临时 userData + 私有 Vite + 本地 mock；先 pnpm build）
node scripts/e2e-autologin.mjs     # 记住密码/自动登录全链路（含杀进程重启）
node scripts/e2e-account-history.mjs  # 历史账号：迁移/选择回填/多服务器/删除/清空（临时 userData + 本地 mock + 独立 9224）
node scripts/e2e-nav-ai.mjs        # 同域链接补 sid + AI 对话跳转
node scripts/e2e-web-logout.mjs    # 网页版退出入口 → 外壳退出回登录窗；E2E_MOCK=1 走本地 mock
node scripts/e2e-corp-sync-run.mjs # 网页版切账套 mock 编排（会话同步 + 关闭其他标签；自动备份/还原 config）
node scripts/e2e-feedback.mjs      # 一键反馈：整窗截图 → 剪贴板 image/png（隔离 userData + 独立 9224，校验含 webview 且不透明）
node scripts/e2e-page-chrome.mjs   # 悬浮卡片几何（四边 5px/16px 圆角）+ 地址栏跟随网页底色（隔离 9228 + 全 mock）
node scripts/e2e-notify.mjs        # MQTT 通知 + 置顶弹窗
node scripts/verify-vibrancy.mjs   # 毛玻璃透光差分（黄/蓝背景板）
```

注意：脚本会接管运行中的应用环境（按需自动重启 vite/electron）。`e2e-account-history.mjs` 使用临时 userData 与独立 CDP 端口 9224，不会接管 9223 上的真实 dev 应用、也不改写真实 `config.json`。`e2e-corp-sync-run.mjs` 会临时改写真实 `config.json`（先备份到 /tmp，结束后原样还原并校验 sha256）并重启 9223 应用；期间所有登录/换票请求只发往本地 mock。`e2e-feedback.mjs` 同样用临时 userData + 9224 隔离实例，会临时占用系统剪贴板（结束后尽力还原），并用主进程 inspector（9230）读回剪贴板图片做不透明度与 webview 内容校验。`e2e-page-chrome.mjs` 用临时 userData + 独立 CDP 9228/主进程 inspector 9231，自起本地 mock 并自动 tsc/拉起 electron，不访问生产、不占用 9223。

## 结构

- `src/main/` 主进程：窗口/标签 URL 策略/会话（safeStorage 存密文）/MQTT/托盘/打包配置
- `src/preload/` contextBridge 白名单 API（`window.diteng`）
- `src/renderer/` 登录页 + 主窗壳（rail 标签栏/用户卡片/设置页/通知弹窗）
- `src/shared/` 三方契约类型

通知设置统一展示实时接收状态、全账套未读总数、上次成功同步时间，并支持立即同步和本机测试通知。测试通知不会创建业务消息或改变未读数，系统权限与专注模式仍可能阻止显示。固定的账套、消息和 AI 入口优先激活已有标签。
