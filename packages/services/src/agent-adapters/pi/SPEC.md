# Pi 控制面与模型绑定桥

owner: `PiHarnessSession` 拥有单个 `hostSessionId` 的轮次、审批门、事件序号和展示历史。`PiAdapter` 只按 `hostSessionId` 建会话，不按 workspace + harness 做单例。`PiRpcSession` 把传输帧译成标准事件，不拥有第二份已接受命令队列。`PiTurnTransport` 是端口。模型目录和凭据仍由调用方持有；`recordPiModelRoute` 只调用注入的 `ModelBindingPlanner` 端口并记下返回的路由。

command path: `PiAdapter.open/dispatch` → `PiHarnessSession` → `recordPiModelRoute` → `PiRpcSession` → `PiTurnTransport`。

derived views: 历史是会话事件日志的只读副本。`message.finished.text` 是该条消息的快照，不是再追加一次的 delta。

ordering/idempotency: 同一会话、同一 `runtimeEpoch` 内 `sequence` 从 1 连续递增。`commandId` 重复不再执行。取消和审批必须带上原来的 `turnId` 与 `runtimeEpoch`，错代或错轮次不改变当前轮。`sourceEventId` 重复则丢弃。

delivery: 本模块不区分桌面连续流和手机重放。它只产出带序号的标准事件；订阅者 detach 不终止传输。

contracts/spec/tests: `@zcode/shared/agent-host` 的命令、事件、能力和 `BindingPlan` 路由字面量。测试在本目录和 `packages/services/test/piCapabilitiesHonesty.test.ts`，用假传输和假规划器。不读取 Pi 的 agent loop。

## 行为

Pi 的 agent loop、上下文和工具执行留在传输对面的 Pi 进程。这里不启动 Electron 主进程循环，也不调用 `@earendil-works/pi-coding-agent`。

第一轮控制面支持：文本、`read` / `write` / `exec`、取消当前轮、`viewHistory`、能挡住执行的审批。`PiHarnessAdapter` 的 worker 认证的是 Pi SDK 工具 `read` / `write` / `edit` / `bash`，不是控制面的 `exec`。两边的 `resumeExecution`、图片、运行中切模型都返回 `unsupported`。未认证工具名拒绝，不产生工具成功事件。能力字段以下面的诚实表为准，不能从 probe 或 `hostManagedSupport` 的 `supported` 反推。

`write` 与 `exec`，以及需要审批的 `read`，在宿主发出 `approval.decision=allow` 之前，传输上不能出现放行帧。拒绝或取消不会发出 `tool.started`。

`detach` 只移除订阅。`terminateSession` 才关闭传输。`viewHistory` 不发送新的 prompt。

## 能力（诚实）

两套适配器各自拥有一份能力对象。Host 可以拷贝字段，不能在 probe 或 `hostManagedSupport` 为 `supported` 时把 `unsupported` 升级。缺省的可选键不是 `supported`。

### `piHarnessCapabilities()`（`PiHarnessAdapter` 的唯一所有者）

`PiHarnessAdapter.capabilities()` 原样返回该对象。

| 字段              | `support`     | 原因必须点名                                              |
| ----------------- | ------------- | --------------------------------------------------------- |
| `text`            | `supported`   | 文本轮次；`images` 与 `modelSwitch` 仍是 `unsupported`    |
| `tools`           | `supported`   | `read`、`write`、`edit`、`bash`；未认证工具名在执行前拦住 |
| `approvals`       | `supported`   | `write`、`edit`、`bash` 要审批；`read` 可以不经决定       |
| `cancelTurn`      | `supported`   | 取消当前 Pi worker 轮次                                   |
| `history`         | `supported`   | 原生会话文件用于 attach；不是 `resumeExecution`           |
| `resumeExecution` | `unsupported` | 与 `images`、`modelSwitch` 同一句                         |
| `images`          | `unsupported` | 与 `resumeExecution`、`modelSwitch` 同一句                |
| `modelSwitch`     | `unsupported` | 与 `resumeExecution`、`images` 同一句                     |

三个 `unsupported` 字段共用一句，必须同时点名 `resumeExecution`、`images`、`modelSwitch`，并写明 probe 或 `hostManagedSupport` 的 `supported` 不升级这些字段。

可选键 `detach`、`terminateSession`、`viewHistory`、`hostManagedModel` **省略**。省略表示未广告。worker 适配器接口没有 `viewHistory`；订阅解除不等于终止 worker。

`probe` 的 `supported` 只表示目标可用、平台是 macOS 或 Linux、且与当前进程平台一致。它不认证 `resumeExecution`、`images`、`modelSwitch`。平台与进程不一致时，原因仍是 worker 不能跨 SSH stdio 跑到另一平台。平台不在 macOS/Linux，或目标不可用时，仍是 `unsupported`，原因保持现有字面量。本切片不新增 SSH 拒绝，也不扩大平台矩阵。

`hostManagedSupport` 的 `supported` 只表示 host-managed `pi-sdk` 路由的推理级别是 `off` 或 `low`。原因必须点名 `reasoningLevel` 以及 `resumeExecution`、`images`、`modelSwitch` 不会因此变成 `supported`。其他推理级别是 `unsupported`，原因点名 `reasoningLevel=off or low`。

### `piControlPlaneCapabilities()`（`PiAdapter`）

`PiAdapter.capabilities()` 原样返回该对象。工具集是 `read` / `write` / `exec`，不要读成 worker 的 `edit` / `bash`。

| 字段               | `support`      | 原因必须点名                                                        |
| ------------------ | -------------- | ------------------------------------------------------------------- |
| `text`             | `supported`    | 文本轮次                                                            |
| `tools`            | `supported`    | `read`、`write`、`exec`；约束里这三项为 true                        |
| `approvals`        | `supported`    | 能挡住执行的审批                                                    |
| `cancelTurn`       | `supported`    | 取消当前轮                                                          |
| `history`          | `supported`    | 已记录的宿主日志                                                    |
| `resumeExecution`  | `unsupported`  | 与 `images`、`modelSwitch` 同一句；`viewHistory` 只读宿主日志       |
| `images`           | `unsupported`  | 与 `resumeExecution`、`modelSwitch` 同一句                          |
| `modelSwitch`      | `unsupported`  | 与 `resumeExecution`、`images` 同一句；切模型只在后续轮，不在当前轮 |
| `detach`           | `supported`    | 只移除订阅，不关闭传输                                              |
| `terminateSession` | `supported`    | 关闭传输；`detach` 不做这件事                                       |
| `viewHistory`      | `supported`    | 读取已记录日志，不发送新的 prompt                                   |
| `hostManagedModel` | `experimental` | 只记录路由，不调用 `Model.streamText`；worker 才调用                |

三个 `unsupported` 字段共用一句，必须点名 `resumeExecution`、`images`、`modelSwitch`，并写明成功的 probe 不升级它们。`hostManagedModel` 保持 `experimental`。

控制面 `probe` 的 `supported` 只表示本地且非 Windows。它不认证 `resumeExecution`、`images`、`modelSwitch`。SSH 与 Windows 仍是 `unsupported`。

控制面 `hostManagedSupport` 在 probe 成功后仍是 `experimental`：这里没有 model factory，执行留在 `PiHarnessAdapter.prepareModel` 和 `Model.streamText`。`experimental` 不把 `resumeExecution`、`images`、`modelSwitch` 标成 `supported`。

## 模型

每一轮调用规划器端口一次，冻结 route、请求模型、生效模型、分项能力、凭据引用和版本指纹。`host-managed` 要求规划器证明走现有模型运行时，且生效身份与请求一致。`harness-managed` 的 `unifiedModelRouting` 必须为 false。

传给传输的模型提示只有路由身份和不可逆的凭据引用。`startupOverrides`、Provider URL 和 Key 不进入提示。规划器若回显密钥，本桥拒绝该轮且不把密钥写进原因或提示。

本目录不实现第二套 `ModelBindingPlanner`。契约基线还没有 PR #3 的 `ModelBindingPlanner` 类时，测试注入同形端口。

生产 `hostManagedRoute` 仍是 `pi-sdk`。`PiHarnessAdapter.hostManagedSupport` 为 `supported` 且推理级别被 Responses 接受时，Gateway `openai-responses` 准入这条路由：`prepareModel` 调用注入的现有 Model runtime，再由 `POST /v1/responses` 进入 `Model.streamText`。假响应只来自 loopback。控制面 `PiAdapter` 的 `hostManagedModel` 和 `hostManagedSupport` 保持 `experimental`，因为它不调用 `Model.streamText`。测试不会用跳过执行层的假 Model 把 worker 标成已完成。

平台验收只写 macOS 本地。执行层测试不增加 Linux SSH 或 Windows 矩阵。真实 SSH 和关掉整个 Electron 不在本切片里跑。

## 迁移

现有 `PiHarnessAdapter` worker 仍由 `createPiHarness` 装配。本控制面是可替换的传输边界，这一轮不改 Host 注册。
