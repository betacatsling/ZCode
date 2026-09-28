# Codex app-server adapter

计划来源：`ZCode_Multi_Harness_Refactor_Plan_v0.3_Orca_Hierarchy.md` 第 6 节 P5 与第 12 节。本目录只实现 Codex Harness adapter。不修改共享契约，不实现 Model Gateway。

## 行为

- 控制面只走官方 `codex app-server` JSON-RPC（`initialize` / `thread/start` / `thread/resume` / `turn/start` / `turn/interrupt` 与 item、approval、usage 通知）。不解析 TUI。
- 每个 `hostSessionId` 拥有独立 app-server 传输、隔离 profile 和 Gateway grant。同一 `workspaceIdentity` + harness 可以有多个 `hostSessionId`，缓存键是 `hostSessionId`。
- 模型侧用会话私有 `config.toml` 的 custom provider `zcode` 把 `wire_api = "responses"` 指到注入端口给出的 loopback Gateway URL。本 adapter 不监听 HTTP，也不调用模型执行器。
- 没有 Codex 凭据时，测试注入假 app-server 传输和假 Gateway 端口。不读取、不复制、不覆盖用户全局 `CODEX_HOME`、模型配置或登录配置。已有且缺少隔离标记的 `config.toml` 直接拒绝写入。

## 所有者

- 宿主会话、命令准入和事件日志不属于本 adapter。
- 本 adapter 拥有：该 `hostSessionId` 的传输、opaque `threadId`、当前 backend turn、待审批 JSON-RPC id、隔离 profile 路径。
- Gateway grant 的授权与模型执行属于注入的 `ModelGateway` 端口。另一路实现 `packages/services/src/model-gateway/**`。

## 两种验收

1. 控制/事件面：假传输可以完成文本、工具、usage 快照、审批、取消、迟到审批拒绝、同工作区多会话和未知请求的结构化失败。
2. `host-managed` 统一路由：控制面假传输不会调用 `Model.streamText`。`capabilities.hostManagedModel` 保持 `experimental`。`hostManagedSupport` 即使带有控制面 fixture 证据，约束里的 `unifiedModelRoute` 也是 `experimental`，不能把控制面本身当成模型执行层已接通。`harness-managed` 为 `unsupported`。
3. 模型栈验收另走现有执行层：`ModelBindingPlanner` 在假 CLI 版本探针和精确 fixture 证据下给出 `responses-gateway` 后，`prepareModel` 调用 `bindHostModel` 和 `AiSdkModelAdapter`，再由 Gateway `POST /v1/responses` 进入 `Model.streamText`。假响应只来自 `127.0.0.1`。这不读取真实 Provider，也不把 `capabilities.hostManagedModel` 改成 `supported`。

## 不支持

`images`、`modelSwitch`、`resumeExecution`、`viewHistory`、`detach` 以及未知 app-server request 返回带 `reason` 或 session error 的结构化 `unsupported`。不把这些能力伪装成已支持。

## 失败

- 传输在已接受的 turn 上断开：该 turn 记为 `unknown`，不重放输入。
- 迟到的审批或取消必须匹配原来的 epoch、Host turn 和 backend turn，否则拒绝。
- 关闭一个 `hostSessionId` 只停该传输并撤销该 grant，不停同一工作区的其他会话。
