# 桌面协调、通知与独立验收记录

> 历史记录：2026-10-24 已按用户要求撤销桌面本地 AI，统一恢复 Web AI 入口。下文涉及本地 Agent、Key、草稿恢复和旧试点安装包的结果仅作历史证据，不代表当前代码；现行验收脚本已移除这些场景，保留账套切换与通知验证。

验证日期：2026-10-24。所有本地行为测试使用合成身份、临时目录和本机 HTTP 服务；没有读取真实密码/模型 Key，没有登录生产账号，没有接管已安装客户端。工作区的既有反馈编辑器改动保留，没有提交、推送或部署。

## 已实际验证

| 层次 | 命令 / 方法 | 结果与边界 |
|---|---|---|
| 类型检查 | `pnpm exec tsc --noEmit -p tsconfig.main.json` | 通过；只能说明类型一致，不能代替运行验收 |
| 协调与通知行为 | `node --test scripts/test-desktop-coordination.mjs` | 16 / 16 通过，直接转译当前源文件，Electron / MQTT 使用模拟对象 |
| macOS Electron 真实运行 | 先 `pnpm build`，再 `node scripts/e2e-desktop-coordination.mjs` | 8 组通过；使用实际 Electron、preload、React、webview、原生窗口、托盘生命周期，ERP/未读接口由 loopback HTTP 模拟 |
| macOS ARM64 最终包真实运行 | `DITENG_E2E_EXECUTABLE='release/0.3.0-beta.1/mac-arm64/diteng agent.app/Contents/MacOS/diteng agent' node scripts/e2e-desktop-coordination.mjs` | 同 8 组全部通过；删除开发入口环境变量并断言登录地址为 `file:`，覆盖实际包内 `#/main` 可信 IPC，未替换已安装应用 |
| Agent 独立源码复核 | `src/main/agent/service.ts`、`store.ts`、`gateway.ts`、`worker.mts` 及主进程 IPC | 检查身份维度、旧 generation、草稿确认、未知写入、回查互斥、Key 的传递与存储；发现问题已交由模块作者修复，并在稳定构建重跑集成 |

16 项行为测试覆盖：确认取消不放行；未决 AI 保存阻止；重复切换互斥；HTTP 失败但服务端身份已变；失败且未变化时保留页面并解锁；核验失败暂停及恢复；换票重验保留新 token；发起页关闭前后；退出后旧回复和确认超时；原换票请求/目标导航/绑定 header/旧 guest/OPTIONS；UID 跨重启账号隔离；写盘失败后同 UID 可重试；只有 Grave 进入队列且不覆盖；断线未读内容补回、历史普通通知静默和实时重放去重；准确本地文件入口的 hash 路由可信判断；恢复登录四维身份和默认 A 返回原 B。

8 组原生运行验证：

1. 取消原网页请求：服务端收到 0 次切换，页面及身份仍是 A。
2. A 打开两个 webview，由非当前活跃的源页面发起切 B：只保留发起 guest；原 HTTP 请求及原 fetch 回调各执行一次；旧网页广播不抢先关标签；请求 header 仍是发起时的 A。
3. 模拟 HTTP 500，但服务端 token 身份已经变为 A：权威核验后会话和实际页面均到 A。
4. 可信壳可调用 Agent snapshot；显式捕获当前 ERP 文本不包含隐藏 DOM 和输入值。
5. 聊天展开/收起及模型设置返回保留未发送输入；Key 输入采用 password 类型（本用例没有配置真实 Key）。
6. HTTP 补查真实创建紧急窗口：两条 Grave 排队、Logger 不置顶；窗口 alwaysOnTop 且创建时未获焦点；通知 popup 调用 Agent IPC 被拒绝；跨账套点击取消保留提醒，确认则切至 B 并以 UID 打开目标详情；关闭第二条不打开详情或调用已读接口。
7. 在 B 插入合成未知保存记录，回查返回 401；取消重新认证后记录及 requestId 保留；错误主账号被拒绝；同主账号正常登录默认落到 A，再经已授权账号列表换回原 B 并核验。原记录成功恢复，仅 GET 原 requestId，草稿 POST 为 0，核验前旧 guest 业务写为 0。
8. 关闭主窗后窗口隐藏、Electron 进程及托盘生命周期仍存活；测试结束再明确退出临时进程。

集成测试只复用已有 `dist` 或指定的包内程序，不会重写它；临时 Vite 使用独立随机端口（包内测试不使用它），userData 使用全新临时目录。测试清理会删除自身创建的临时目录。真实服务不得替换进脚本。

恢复用例首次运行因测试误把 webview 的 Page 当成登录窗而超时，现按原登录入口 URL 精确定位；未删减任何产品断言。失败清理对本测试创建的 Electron 进程设置 5 秒结束上限，避免未决写的正常退出阻止机制掩盖测试错误；该逻辑不进入产品。

## 未决写入的受控重新认证

入口只在 pending / unknown 原请求回查得到 401 后开放，锁定原服务器、主账号、账套与子账号。复用账号密码和新设备验证码登录；自动登录与历史账号自动切换禁用。登录过程中，旧 guest 的网络请求和页面捕获均暂停，取消或失败不会清库、换身份、关闭旧页或新建请求编号。

`src/main/reauthentication.ts` 先核验主账号，再在服务端返回的启用子账号列表中确认原账套；正常登录默认落到别的账套时换票返回原账套，重新核验全部身份维度后才更换凭据。`src/main/index.ts` 的完成路径调用 `credentialsRenewed()` 回查原请求，保留同一 SQLite 记录和 requestId。结果仍未知时继续阻止切换与退出；再次 401 可以重新认证。`not-found` 的显式原编号重试由 Agent 模块管理，不是重新认证自动发起的操作。

## 后端独立源码复核

范围仅覆盖本次桌面相关改动：Ravenclaw 的 `site/diteng/im/desktop/*`、`AiSessionAuthenticationFilter`、`FrmMyMessage.desktopNotification`；ERP 的 `com/mimrc/desktop/*`、税额共享函数及订单 append 调用；Summer 的 `ExpectedCorpGuard` 和表单/服务入口。另沿调用链核对现有身份解析、客户/商品数据范围、价格权限、订单查询和 MySQL 事务实现，未修改这些后端文件。

- 身份和租户：IM 要求 sid、设备号、expected-corp，认证后比较；转发 ERP 再认证并比较 expectedCorpNo，Summer 对携带预期账套头的可信网页请求也在业务调用前比较。身份和授权范围不采信模型参数。操作记录及确认摘要增加认证主账号绑定，防止子账号重新归属后读取旧主账号结果；同账套、同子账号的新 sid 可回查原请求。
- 业务权限和金额：固定四个只读工具及唯一草稿提交入口，复用销售订单执行/新增权限、客户/对象范围和现有订单查询；价格隐藏权限不返回订单金额，也不允许确认含价提案。预览和提交重新计算服务器数据并比对摘要，最终检查为未审核 OD，未开放审核或任意服务执行。
- 原子性和防重：操作记录、OD 及成功结果共用业务连接和外层事务，主键约束串行化相同请求，内层 append 不独立提交外层事务。业务异常回滚至保存点并记录失败；提交后丢响应可查询原结果。写前检查订单相关表为 InnoDB，缺少事务条件拒绝写入。认证主账号不匹配时不得读取同子账号旧请求结果。
- 通知：列表和详情按认证主账号连接启用子账号，最终 SQL 同时约束 `owner.id_` 为认证 USER_ID；列表只查 `final_=0`，使用有上限的分页，详情纯读且 HTML 按文本转义；没有把客户端关闭提醒当成业务已读。

独立审核发现两行金额各 0.04、税率 13% 时，原预览各行税额均舍入为 0，整单税为 0.01，却未选中补差行，可能与 append 保存结果不同。作者修为预览与 append 共用 `CalTaxDiscrepancyUtils.getTaxAdjustmentIndex`，全零税回首行；已复核共享调用。外币价格原先可能回落母币历史/基价，现 `DesktopPricePolicy` 外币及报价管控只取对应币别报价/公共报价，受报价管控缺报价拒绝。

同时复核作者修正：预览期间的账期检查改为 `AccInitYearMonth` 与 `Aclockedset` 纯读取，移除可能创建缺省账期的调用；`TOriAmount_` 为母币金额、`Amount_` 为原币金额，母币金额按原币乘汇率计算，与 append 相同；订单查询使用原币 `Amount_` 配合单据币种；摘要含税总额用单据币种，税额/未税金额显式标记母币并给出提示。此次最终源码复核未留下已确认且未修复的问题。

这是独立静态复核及桌面 mock 集成证据，不能证明真实 ERP 客制插件、税制、币别、数据库配置下的 OD 保存已通过。后端作者的隔离 MySQL / PostgreSQL 测试另见其交付记录；真实订单由用户在测试账套验收，不用源码推理替代。

## 已修复的交叉审核问题

- Agent 身份未补齐时不能因 scope 校验阻止正常退出；此状态从未允许助手写入。模块作者增加相关行为测试。
- 草稿先持久化 requestId 再同步占位，落盘失败不会留下未发送的内存提交锁；提交和回查互斥，已成功/失败的终态不被慢回复回退。
- 换票后的身份核验暂时失败，重试继续使用那张新票；不会误回到旧票。
- 通知持久化采用先写临时文件、原子改名、再提交内存状态；失败不占用去重标记。关闭提醒落盘失败会保留队列。
- HTTP 未读内容补查独立于 MQTT 配置/连接成功，断网恢复仍可继续尝试。
- `message_temp` UID 与旧 IM `msgId` 不同。通知点击使用 `FrmMyMessage.desktopNotification?uid=...`，由新增服务端入口再次验证账号及子账号归属并只读展示。普通托盘入口仍使用消息中心。

## 服务端契约与部署前提

`GET /public/desktop-agent/notifications?cursor=<uid>&limit=100` 返回 `items` 与 `nextCursor`。身份只来自三个头：`X-Diteng-Sid`、`X-Diteng-Client-Id`、`X-Diteng-Expected-Corp-No`。服务端查询启用的关联子账号范围，桌面不上传自称的授权账套列表。详情入口 `FrmMyMessage.desktopNotification?uid=...` 沿用会话参数，服务端仍须验证消息归属。

可信 ERP guest 的业务请求使用同一个 expected-corp header，值取 guest 绑定身份。主进程切换闸门与服务端认证后的账套比较是两个独立边界；网页 `sendAccountChannel` 补丁仅用于兼容旧广播行为。

这些新增服务端接口没有在本轮部署到生产。以上 Electron 测试未证明实际 ERP、真实 MQTT broker 或真实网络环境已支持它们。发布前需先部署并验证对应 Ravenclaw / Summer 服务端改动，按服务端交付说明应用索引和确认接口。

## 尚未证明的行为

- Windows 实机尚未运行。仓库未发现可用 Windows CI 配置，本机未找到 `prlctl`、`VBoxManage`、`virsh`、`vmrun` 命令；没有启动虚拟机。安装包构建与 Windows 真机运行应分别记录。用户验收见 [windows-pilot-acceptance.md](windows-pilot-acceptance.md)。
- 未在真实 macOS / Windows 系统通知授权、专注模式条件下证明通知已显示。`Notification.isSupported()` 或 `show()` 被调用只表示 API 可调用，不代表用户看到了通知。
- 未连接旧终端及真实打印机、扫码枪、串口称重设备；新客户端没有修改旧终端协议/配置，兼容行为仍需硬件实测。
- 未用真实模型 Key、生产数据验证模型联网回答或保存 ERP 单据。Agent 模块另有离线工具循环和 utilityProcess 验证，不能代替业务试用。
- 目前 ERP 没有统一 dirty 协议，切换提示要求用户先自行保存；“继续切换”明确放弃旧标签未保存内容，客户端不宣称自动保存网页表单。
- 本地通知关闭只移除该客户端待提醒队列；不会伪造服务端业务已读。账号/服务器隔离和重启去重通过本地行为测试，真实 broker 断线、真实授权变更与 Windows 通知权限仍须试用验收。
