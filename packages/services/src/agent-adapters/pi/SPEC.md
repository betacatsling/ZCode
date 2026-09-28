# Pi 控制面与模型绑定桥

owner: `PiHarnessSession` 拥有单个 `hostSessionId` 的轮次、审批门、事件序号和展示历史。`PiAdapter` 只按 `hostSessionId` 建会话，不按 workspace + harness 做单例。`PiRpcSession` 把传输帧译成标准事件，不拥有第二份已接受命令队列。`PiTurnTransport` 是端口。模型目录和凭据仍由调用方持有；`recordPiModelRoute` 只调用注入的 `ModelBindingPlanner` 端口并记下返回的路由。

command path: `PiAdapter.open/dispatch` → `PiHarnessSession` → `recordPiModelRoute` → `PiRpcSession` → `PiTurnTransport`。

derived views: 历史是会话事件日志的只读副本。`message.finished.text` 是该条消息的快照，不是再追加一次的 delta。

ordering/idempotency: 同一会话、同一 `runtimeEpoch` 内 `sequence` 从 1 连续递增。`commandId` 重复不再执行。取消和审批必须带上原来的 `turnId` 与 `runtimeEpoch`，错代或错轮次不改变当前轮。`sourceEventId` 重复则丢弃。

delivery: 本模块不区分桌面连续流和手机重放。它只产出带序号的标准事件；订阅者 detach 不终止传输。

contracts/spec/tests: `@zcode/shared/agent-host` 的命令、事件、能力和 `BindingPlan` 路由字面量。测试在本目录，用假传输和假规划器。不读取 Pi 的 agent loop。

## 行为

Pi 的 agent loop、上下文和工具执行留在传输对面的 Pi 进程。这里不启动 Electron 主进程循环，也不调用 `@earendil-works/pi-coding-agent`。

第一轮支持：文本、`read` / `write` 文件工具、`exec`、取消当前轮、`viewHistory`、能挡住执行的审批。`resumeExecution`、图片、运行中切模型、未认证工具名返回 `unsupported` 或拒绝回执，不产生工具成功事件。

`write` 与 `exec`，以及需要审批的 `read`，在宿主发出 `approval.decision=allow` 之前，传输上不能出现放行帧。拒绝或取消不会发出 `tool.started`。

`detach` 只移除订阅。`terminateSession` 才关闭传输。`viewHistory` 不发送新的 prompt。

## 模型

每一轮调用规划器端口一次，冻结 route、请求模型、生效模型、分项能力、凭据引用和版本指纹。`host-managed` 要求规划器证明走现有模型运行时，且生效身份与请求一致。`harness-managed` 的 `unifiedModelRouting` 必须为 false。

传给传输的模型提示只有路由身份和不可逆的凭据引用。`startupOverrides`、Provider URL 和 Key 不进入提示。规划器若回显密钥，本桥拒绝该轮且不把密钥写进原因或提示。

本目录不实现第二套 `ModelBindingPlanner`。契约基线还没有 PR #3 的 `ModelBindingPlanner` 类时，测试注入同形端口。

## 迁移

现有 `PiHarnessAdapter` worker 仍由 `createPiHarness` 装配。本控制面是可替换的传输边界，这一轮不改 Host 注册。
