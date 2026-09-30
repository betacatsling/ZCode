# ACP 版本与接入

稳定合同是 ACP protocol version 1。客户端在 `initialize` 里提供 version 2，若对方降回 1，按 v1 协商结果工作。

| 协商结果                                                         | 准入                     | resume                                     | viewHistory        |
| ---------------------------------------------------------------- | ------------------------ | ------------------------------------------ | ------------------ |
| version 1，且 `loadSession` 或 `sessionCapabilities.resume` 为真 | harness-managed          | 只调用被协商的方法                         | 读已发出的宿主事件 |
| version 1，两者都没有                                            | 可以新建会话             | unsupported，不发送 load/resume/new/prompt | 仍可查看           |
| version 2 或未知版本                                             | experimental，不创建会话 | 不调用 session 方法                        | 不依赖 Agent       |

认证方法只记录 `methodId`。本适配器不提交凭据，也不运行 `opencode auth login` / `goose acp` / `devin acp` / `devin auth login`。

## Devin

Devin CLI 的编辑器控制面是官方 `devin acp`（stdio JSON-RPC）。档案 id 为 `devin`，参数只有 `acp`。它和 OpenCode、Goose 共用 `acp-session-machine/1`。模型绑定只接受 `harness-managed`，不把 Devin 的账号模型送进 Gateway。`hostManagedSupport` 是 `unsupported`，不是已完成的 host-managed。协议版本、续跑和认证仍只看当次 `initialize`。

## OpenCode

档案 id `opencode`，可执行文件 `opencode`，参数 `["acp"]`。与 Goose、Devin 共用 `acp-session-machine/1`。续跑只看当次 `initialize` 的 `loadSession` / `resume`，档案不声明 session/load。`hostManagedSupport` / `hostManagedModel` 为 `unsupported`。安装探测（可执行文件是否存在）不得升级 text/tools/resume 等会话能力。

## Goose

档案 id `goose`，可执行文件 `goose`，参数 `["acp"]`。同上：共用会话状态机、harness-managed、不提交凭据、不在档案里写死续跑。第二同协议 Agent 只加档案，不改 `AcpSessionMachine`。

## 增加另一个 ACP Agent

1. 新增档案：`id`、`name`、`executableName`、`args`。
2. 用现有 `createAcpHarness` 和 `loadExplicitHarnessPlugins` 注册。
3. 不要改 `AcpSessionMachine`，不要在公共 UI 或会话宿主里加品牌分支。

协议版本若改变语义，连接回到 experimental。不要把旧 `backendSessionId` 静默迁到新版本。回滚时从注册表去掉该 harness id，历史仍按宿主日志读取。
