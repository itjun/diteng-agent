# diteng agent

帝擎 ERP 的 Electron 桌面壳客户端：账号密码登录（记住密码/自动登录双勾选，历史登录账号可下拉选择、逐条删除/清空）→ 内嵌 web ERP 多标签（左侧竖向标签栏，可拖宽、双击复位，切账套自动关闭旧账套标签）→ MQTT 消息系统通知/置顶弹窗/托盘。UI 采用 deepseek-harness 桌面版设计语言（`--dsw-*` 主题 token，macOS 侧栏 vibrancy 毛玻璃）。

## 技术栈

Electron 44 · TypeScript · React 18 · Vite（renderer）+ tsc（main/preload）· CSS Modules · mqtt.js · electron-builder

## 常用命令

```bash
pnpm install        # 安装（electron 二进制失败时用 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）
pnpm dev            # 开发：vite(5173) + electron（改动 main/preload 需重启）
pnpm typecheck      # 四个 tsconfig 全量检查
pnpm build          # 构建 main/preload/renderer 到 dist/
pnpm dist:mac       # 打 mac arm64 dmg（release/）；dist:win 为 Windows nsis 配置
```

## e2e 真机验证（CDP 驱动真实应用）

```bash
cp scripts/e2e-secrets.example.mjs scripts/e2e-secrets.mjs   # 填入测试账号（已 gitignore）
(pnpm exec vite &) && (pnpm exec electron . --remote-debugging-port=9223 &)
node scripts/e2e-layout.mjs        # rail 标签栏/拖宽/标签/设置页；E2E_MOCK=1 走本地 mock
node scripts/e2e-autologin.mjs     # 记住密码/自动登录全链路（含杀进程重启）
node scripts/e2e-account-history.mjs  # 历史账号：迁移/选择回填/多服务器/删除/清空（临时 userData + 本地 mock + 独立 9224）
node scripts/e2e-switch.mjs        # 账套切换（关旧账套标签）+ AI 跳转
node scripts/e2e-notify.mjs        # MQTT 通知 + 置顶弹窗
node scripts/verify-vibrancy.mjs   # 毛玻璃透光差分（黄/蓝背景板）
```

注意：脚本会接管运行中的应用环境（按需自动重启 vite/electron）。`e2e-account-history.mjs` 使用临时 userData 与独立 CDP 端口 9224，不会接管 9223 上的真实 dev 应用、也不改写真实 `config.json`。

## 结构

- `src/main/` 主进程：窗口/标签 URL 策略/会话（safeStorage 存密文）/MQTT/托盘/打包配置
- `src/preload/` contextBridge 白名单 API（`window.diteng`）
- `src/renderer/` 登录页 + 主窗壳（rail 标签栏/用户卡片/设置页/通知弹窗）
- `src/shared/` 三方契约类型
