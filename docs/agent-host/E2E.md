# 多 Harness 浏览器 E2E 接缝（foundation）

## 边界与所有者

此阶段只有浏览器基础设施，不是 §13 ProjectSidebar/facade 产品验收。`packages/ui/e2e` 的 fixture 是浏览器测试入口，不复制 Project/Workspace/Session 领域状态，不声称 native Host/SSH/审批已运行。当前 smoke 只挂载 `@zcode/ui` 公开入口的真实 `Button`；输入框与计数是 fixture 操作台，不是产品 composer。状态仅归 fixture React 本地 state，刷新即丢弃。后续产品接入须改为挂载实际导出的 ProjectSidebar 与 app navigation，不得把 fixture 的列表或按钮当作侧栏实现。

服务注入约定：受测组件的 service 需求走现有 `@zcode/ui` 公开 `ServiceProvider` / `PlatformProvider`（以及既有 workspace provider），在 fixture root 传入按 `IServiceAccessor` / `IPlatformService` 类型构造的 **逐测试隔离** fixture；不修改 `window.zcode`、全局生产服务或个人账号。Host/facade 有独立测试接口后才能用对应公开入口替换数据源；浏览器断言必须同时检查 UI 与其 owner 的事实，不拿 React 本地 state 充当 Host 真相。此 smoke 无需 service，因此不造空代理。事件顺序：浏览器输入 → React fixture state → DOM；未来 Host 场景：浏览器命令 → facade/Host owner → 已确认事件 → UI 摘要，重连仅恢复 owner 状态。异步恢复不得覆盖用户更新的 selection/draft。

## 可执行入口和隔离

从仓库根目录运行 `mise exec -- node scripts/mise-run.mjs pnpm e2e:ui`。Playwright 启动本地仅 loopback 的 Vite fixture，不启动 `dev:desktop:test`、日常桌面实例、模型或 SSH；每个 Playwright context 隔离 cookie/localStorage，runner 的 trace、截图、报告在系统临时目录的唯一 run 目录。可用 `ZCODE_E2E_ARTIFACT_DIR` 指定**全新或现存的专用**目录；runner 会在其下创建唯一 run 目录，不删除其他数据。默认 Playwright 自带 Chromium；仅在显式设置 `ZCODE_E2E_CHROMIUM_PATH` 时使用该浏览器可执行文件。缺少默认浏览器时先运行 `mise exec -- node scripts/mise-run.mjs pnpm exec playwright install chromium`。错误测试保留 trace 和截图，成功 smoke 也留 desktop/mobile 截图；报告中标明具体路径。测试数据仅用固定匿名文本，无账号/凭据。

## 当前 smoke 验收

Desktop 1280×800 与 mobile 390×844 各自挂载真实 UI Button；键盘 Tab 可聚焦并用 Enter 激活按钮，输入草稿在按钮重渲染后保持，操作不抢走正在编辑的 textarea 焦点；显式捕获截图。测试失败自动保存 Playwright trace 和截图。此项不能证明 app navigation、ProjectSidebar、Host/facade 状态或移动远控可用。

## §13 后续验收清单（尚无可执行测试，不计通过）

1. 用真实 ProjectSidebar/facade + 两项目/每项目至少两个 worktree/同一 workspace 三个会话（两个 Pi）的隔离 fixture 测树与身份；新会话不增加 worktree；Pi 改模型不改 Harness 图标。
2. 在真实 composer 输入草稿并聚焦，分别注入后台 Agent 进度、发现 worktree、SSH 重连与异步恢复；断言 DOM focus、草稿和已选 sessionId 不变；只显式点击 session 行才切换。
3. 折叠/隐藏 workspace 后通过 Host 触发真实待审批，项目汇总仍显示可点击 attention；点击进入审批；离线不显示成功。
4. SSH 扫描失败和恢复：树及持久 catalog 不删、freshness 标 stale，重连先校验 target/generation；同路径不同主机不串会话。
5. 同 workspace 两个 Pi + 一个 ZCode 分别发送/取消，核对 owner 独立 identity、模型/审批与 Git worktree 数，关闭视图不终止会话；本机与手机 viewport 均测可访问动作。
6. linked worktree 删除与新建会话并发、旧路径重建及非 Git 兼容状态：严格按 §13 所有者/准入和安全提示验证；无后端可用之前不加 skip 测试也不报已覆盖。

## 验证等级

组件 fixture smoke ≠ 产品集成 E2E ≠ 原生 CLI/SSH/付费模型真机验证。新增场景只有绑定真实 UI 与 owner，并执行后才可升级验收等级。此基础设施不触及用户数据目录。
