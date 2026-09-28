# Agent host shared contract

来源：`ZCode_Multi_Harness_Refactor_Plan_v0.3_Orca_Hierarchy.md` 第 4 节与第 13.2 节。这里只冻结序列化契约、归属校验和受信插件描述。不启动 Harness，不实现侧栏或 worktree 服务。

## 身份

- 宿主会话身份只有 `hostSessionId`。它不要求等于任何 Agent 的 native session id。
- `AgentSession.id` 与 `SessionSpecV2.hostSessionId` 是同一宿主身份，不另设 `SessionId`。
- 同一 `workspaceId` + `harness.id` 可以对应多个 `hostSessionId`。缓存键必须是 `hostSessionId`。
- 已发布的 `SessionSpec` schemaVersion 1 继续按原字段解析，不在读路径上补造 `projectId`。

## SessionSpec schemaVersion 2

字段与计划一致：`projectId`、`workspaceId`、`execution.targetId`、`execution.workspaceIdentity`、`execution.worktreePath`、`execution.worktreeGeneration`、`execution.cwdRelativeToWorktree`、`harness.id`、`harness.adapterVersion`、`modelBinding`。`cwdRelativeToWorktree` 缺省为 `"."`，且必须是 worktree 内的安全相对路径。

执行位置只从已校验的 Workspace / RepositoryBinding 派生。调用方不能把另一台机器的 target 写进这份快照。

## 能力

`CapabilityReport` 只用 `support`、`reason`、`constraints`。`support` 为 `unsupported`、`experimental` 或 `unknown` 时必须有 `reason`。既有能力键保留；计划中的 `detach`、`terminateSession`、`viewHistory`、`hostManagedModel` 是附加可选报告，不替换旧键。

## 插件

Manifest 只描述 `id`、`name`、`adapterVersion` 和可选图标资源。`trusted` 与启用名单由调用方显式给出，不能从 manifest 自声明。未受信或未启用的工厂不得被调用。
