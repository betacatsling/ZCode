# ACP 版本与接入

稳定合同是 ACP protocol version 1。客户端在 `initialize` 里提供 version 2，若对方降回 1，按 v1 协商结果工作。

| 协商结果 | 准入 | resume | viewHistory |
| --- | --- | --- | --- |
| version 1，且 `loadSession` 或 `sessionCapabilities.resume` 为真 | harness-managed | 只调用被协商的方法 | 读已发出的宿主事件 |
| version 1，两者都没有 | 可以新建会话 | unsupported，不发送 load/resume/new/prompt | 仍可查看 |
| version 2 或未知版本 | experimental，不创建会话 | 不调用 session 方法 | 不依赖 Agent |

认证方法只记录 `methodId`。本适配器不提交凭据，也不运行 `opencode auth login` / `goose acp`。

## 增加另一个 ACP Agent

1. 新增档案：`id`、`name`、`executableName`、`args`。
2. 用现有 `createAcpHarness` 和 `loadExplicitHarnessPlugins` 注册。
3. 不要改 `AcpSessionMachine`，不要在公共 UI 或会话宿主里加品牌分支。

协议版本若改变语义，连接回到 experimental。不要把旧 `backendSessionId` 静默迁到新版本。回滚时从注册表去掉该 harness id，历史仍按宿主日志读取。
