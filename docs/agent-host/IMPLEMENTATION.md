# ZCode 多 Harness v0.3 实施台账

更新时间：2026-09-27

本台账以仓库当前源码、`package.json`、测试文件和
`ZCode_Multi_Harness_Refactor_Plan_v0.3_Orca_Hierarchy.md` 为准。它记录“代码存在、确定性测试通过、真实环境认证通过”三种不同证据，不把契约、Mock、构建产物或协议探针当作产品完成。计划规定 P4 完成后才称为首个可用版本。

## 当前证据和环境

- 计划固定的源码基线是 `328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f`；当前 checkout 是 `438c25720b7c922b7902b4c5de182b5804720bb8`，工作区还有大量本地改动。两者不能混称为同一基线，也不能清理与本任务无关的改动。
- `mise.toml` 要求 Node 24.14.0、pnpm 10.33.2。当前 shell 实测 Node 24.18.1、pnpm 10.33.2，`mise` 不在 PATH；后续认证必须使用固定工具链并在记录中注明实际版本。
- 当前主开发 shell 是 Ubuntu 20.04.6、Linux 5.15、x86_64；本机未运行 macOS GUI。远端 Mac 已完成只读 capability probe，但源码构建、local worker 和桌面退出恢复仍未认证。
- 本地 CLI 版本实测为 Pi 0.86.1、Claude Code 2.1.263、Codex CLI 0.154.0。仓库 Pi 依赖固定为 0.87.1，Codex 计划/探针要求 0.156.1；本地 CLI 版本差异不能算兼容认证。
- 本机 OpenSSH 8.2p1；按用户授权对 SSH 配置中的两个非通配目标做了只读探测，两个目标均可连接并报告 macOS 27.0、arm64、Git 2.50.1。远端默认 PATH 没有 Node/pnpm，但常见安装位置可见 Node 26.8.1 和 mise 2026.9.12，pnpm 和 Homebrew 未发现；默认 cwd 不是 Git 仓库，home 下最多五层可见 22 个 Git 目录但没有名为 ZCode 的仓库。未输出 alias、地址、用户名、路径或 key，也没有上传、写文件或运行模型。两个条目可能指向同一台机器，不能据数量推断有两台独立 target。
- 早期 hierarchy 验证日志 `/tmp/zcode-hierarchy-validation-20260927/` 记录 agent-host/UI 33/33（hierarchy 6/6）、root typecheck 通过、lint 0 errors/70 warnings、architecture 0 violations；随后当前 focused 记录为 agent-host 39 + Catalog 4 = 43 个测试通过。本轮 directory/sidebar/ConversationTransport focused suites 已通过；ProjectSidebar directory/summary/projector fixtures 当前 7/7，最终分包与门禁日志保存在 `/tmp/zcode-conversation-transport-validation-20260927/final/`。Worktree/AgentHost 相关当前实测为 64/69（另有并行 Worktree contract/migration 测试收口中）。在用户授权的隔离环境中已发生 92 次 live Pi/Provider 尝试：StepFun Linux/Mac 新版路径通过，AxonHub Linux 新版通过，AxonHub Mac 路径按拒绝结果收尾；这些结果仍需按完整 acceptance matrix 汇总，不能把尝试次数当 P3/P4 全部完成。
- 当前已有构建产物：`packages/desktop/out/host/piWorker.js`、`packages/zcode-server-cli/dist/piWorker.js`、`packages/zcode-server-cli/dist-release/zcode-server-linux-x64/runtime/piWorker.js`、server-core/server-cli 和 bundled Node。它们的时间戳在 2026-09-24，早于本轮层级契约变更；只能证明文件曾构建，不能证明是当前 checkout 的最终包，也不能证明运行时依赖完整。
- 没有读取或记录 Provider key、refresh token、SSH alias、真实账户数据或用户会话。当前本地标准 personal config `~/.zcode/v2/provider_config.json` 不存在；两个远端 Mac 的标准 personal config、`ZCODE_DATA_BASE_DIR` 和 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 也未发现。仓库内置 `deepseek` 规则静态列出 `deepseek-v4-pro`、`deepseek-v4-flash`、`deepseek-v4.1-flash`、`deepseek-flash` 及若干带 `deepseek/` 前缀的变体；这些不是 personal provider。live 联调按用户“少用”约束控制，由主代理统一记录 provider/model 与用量，不在本台账写凭据或账户值。

当前目标链路和所有者如下：

```text
Project Catalog（未来：项目元数据、默认工作区、排序）
        ↓ 引用
Target Runtime Host（未来：RepositoryBinding、WorktreeWorkspace、准入）
        ↓ 继承
Agent Host Session（已有外部 Host 的命令/事件/journal 所有者）
        ↓
Harness Adapter（Pi 已有；Codex/Claude FakeModel experimental；Devin print-mode + 可选 ACP profile；通用长尾 ACP 未完成）
        ↓
现有 Provider Registry + Model executor（Pi bridge 已有代码路径，真实路由未认证）
        ↓
V4 Projector / UI facade（投影和 facade 已有，产品 UI 尚未挂载）
```

## P0：基线、工具链和当前行为

状态：**部分完成，真实基线仍未闭环**。

已有证据：

- [BASELINE.md](./BASELINE.md)、[CONTRACT.md](./CONTRACT.md)、[ACCEPTANCE.md](./ACCEPTANCE.md) 已记录原生链路、Host 所有者、模型层边界、隔离数据目录和失败分类。
- [CODEX-HOST-REFERENCE.md](./CODEX-HOST-REFERENCE.md) 已记录 CodexHost 固定 commit、LGPL-3.0-only 许可和“参考设计而非复制依赖”的边界。
- 已执行过 architecture、typecheck、lint、worker bundle 和若干确定性测试；当前完整 native GUI 生命周期、真实 SSH ZCode 执行和最终安装包仍没有证据。
- 原生 UI→V4→CLI/runtime→Provider Registry→AiSdkModelAdapter 的现有链路仍是权威路径。新 Host 没有接管 native session、native projection 或 native command inbox。

仍需交付：

- 在固定 Node/pnpm 和独立数据目录下重做可复现的原生 create/send/tool/stop/approval/resume trace，记录实际版本和失败原因。
- 验证至少一次真实 SSH ZCode 执行，区分 SSH 登录成功、远端命令成功和任务在 GUI/SSH 断开后继续三种证据。
- 补齐 v0.3 的 tab→workspace→session→cwd 归属样本：主检出、linked worktree、非 Git 目录、离线 SSH、同路径不同 target。
- 固定 Git 版本和机器可解析的 `worktree list --porcelain -z` 行为；当前 WorktreeService、持久目录和 RPC 端口已有代码与确定性测试，发现/显式接管仍需完整 UI、迁移和远端 acceptance。
- 完成脱敏 trace fixture、来源/许可清单和基线失败清单；不要把外部协议探针或构建通过写成 live Harness 通过。

P0 验收仍缺 native GUI 回归、SSH 实际任务、安装包和脱敏 trace。下一批工作应先保持这份基线可重放，不移动目录、不迁移旧会话、不接入真实第三方 Harness。

## P1：共享契约、目录、Mock 和层级基础

状态：**基础契约和确定性 Host 已有；P1 仍未完成**。

### 已实现并有测试的部分

- `packages/shared/src/agent-host/session-spec.ts`：v1 `SessionSpec`、`ExecutionTargetRef`、`ModelBindingRequest`、`BackendBinding`。v1 没有被层级切片升级，旧 Host manifest 仍可读。
- `packages/shared/src/agent-host/commands.ts`、`events.ts`、`capabilities.ts`、`binding-plan.ts`、`metadata.ts`：命令、事件、能力报告、BindingPlan 和 additive external metadata 的 strict schema。
- `packages/shared/src/agent-host/hierarchy.ts`：`Project`、`RepositoryBinding`、`WorktreeWorkspace`、`AgentSession`、层级引用/重复校验和纯 `ExecutionSnapshot` 派生。它只做词法 cwd 检查，不做 Git、realpath、符号链接、权限或 target 现状检查。
- `packages/services/src/agent-host/harnessRegistry.ts`、`modelBindingPlanner.ts`、`registryCatalog.ts`：可信内置 adapter 注册、target/capability/model admission 和冻结 Registry fingerprint。
- `IAgentHostService.getDirectory()` 与 `listSessionSummaries()` 已接入 target/RPC/lazy service；live summaries 只读 Host 内存状态，cold summaries 只读 manifests/index 并标 stale/offline/unknown，不启动 worker或扫描 transcript。native ZCode directory entry 由 Host 注入；Pi 未加载或无受控资源时保持 disabled/fallback。
- `packages/services/src/agent-host/mockHarness.ts`：文本、工具、审批、拒绝、简单延迟/失败/序号场景的 deterministic fake。
- `commandJournal.ts`、`eventJournal.ts`、`journalStorage.ts`：持久 accepted record、事件序号、source-event 去重、gap/fault fence 和进程锁的基础实现。
- 当前 39 个 agent-host + 4 个 Catalog 测试包括 schema、层级引用、identity、journal、projection、router、channel scope、owner concurrency、fake Pi worker、fake model bridge 和 Catalog 原子/版本校验；本轮新增 directory/sidebar 测试已通过 9/9，ConversationTransport bridge/source/pagination services 57/57、UI transport/facade/SessionDataLayer integration 6/6，ProjectSidebar directory/summary/projector fixtures 7/7。相关分包 suite 合计 70 个已执行用例；Worktree/migration 并行 suite 另记 64/69。

### P1 明确缺口

这些缺口不能因为 hierarchy schema 已完成而跳过：

- `packages/shared/src/agent-host/directory.ts`、`packages/services/src/agent-host/harnessDirectory.ts`、`IAgentHostService.getDirectory/listSessionSummaries` 已提供版本化 manifest、静态 light/dark asset ID、safe fallback、live/cold summary 和现有 Registry 的只读 additive port；Pi 真实品牌资源、remote manifest loading 与完整 Host asset bytes port 仍缺。
- `packages/shared/src/agent-host/sidebar.ts`、`packages/services/src/agent-ui-projection/sidebarProjector.ts` 已提供纯 `SidebarSnapshot/Summary` projector，focused suite 9/9 通过；它尚未接入 UI、Catalog 或 sessions-index transport，也没有全套 E2E。
- 基础 Project Catalog 已落盘于 `packages/services/src/project-catalog/`：strict v1 文件、原子写、文件锁、idempotent create/update 和 future/invalid file fail-closed；`projectCatalog.test.ts` 当前 4 个测试通过。它只保存 Project metadata 和 opaque `workspaceIds`，不拥有 RepositoryBinding/WorktreeWorkspace。
- RepositoryBinding/WorktreeWorkspace 持久化、target-scoped discovery/adopt/revalidate、代际证据和原子写已有实现及确定性测试；跨 Catalog refs 的重试、UI 接管、迁移联动和真实 target acceptance 仍缺。
- Mock 的场景字段包含 delay/failure/gap，但缺少计划要求的完整 slow、异常退出、重复事件、缺失序号、未来 schema、能力原因和大规模 summary fixture 审计。
- 没有两项目、每项目至少两个工作区、同工作区三个会话（含同 Harness 两个）的 Sidebar fixture 和排序/focus fixture。当前 hierarchy fixture 证明数据模型关系，不能代替侧栏读模型。
- 目录已有 Host manifest factory/静态 asset ID 端口和安全 fallback；生产 UI 目前只加载已登记的本地 ZCode 资源，Pi 资源来源/再分发清单和完整 Host asset bytes/URL port 仍需补齐，capability 仍由 probe/session 提供。
- 迁移代理正在补齐 SessionHierarchy source 联合和旧 cwd/native owner 保留；未 linked 的记录只能显示待核实，不能由 UI 猜测归属。

### P1 后续接入边界

本轮已完成目录/摘要契约和纯 projector；下一步应把它们接到 Catalog/Host，而不是再造执行状态：

1. 让内置 factory 在现有 Registry registration 旁提供受信 manifest，继续由 probe/session 提供 capabilities。
2. 让 Catalog/Worktree Host 提供已验证 hierarchy snapshot 和 bounded summaries；Project Catalog 仍只保存 metadata/workspace refs。
3. 将 `projectSidebarSnapshot` 接入后续 UI view facade，保持 focus/view state 在 UI store，禁止 projector 写回 owner。

最小接口边界应复用现有 `HierarchySnapshot`、`StoredAgentSessionSummary`、`ExecutionTarget` 和 Harness capability reports。Catalog/WorktreeService 后续只需提供已验证的 hierarchy snapshot，不让 projector 读取 Git 或 journal 全文。

## P2：SessionRouter、原生 facade、目录驱动 UI 和旧数据接缝

状态：**服务通道和路由骨架已有，产品面和迁移未实现**。

### 已实现

- `packages/services/src/agent-host/sessionRouter.ts`：native/external 归属决策、target identity 检查、外部 admission flag、未知 Harness fail-closed。
- `packages/shared/src/agent-host/metadata.ts` 及 `sessions-index.ts`/`snapshot.ts` additive metadata：旧 native session 缺失 metadata 时仍按 `zcode` 解释，未扩展旧 `glm` wire identity。
- `packages/ui/src/v4/agentHostConversationFacade.ts`：关闭开关返回原 native transport；开启时按已知 session owner 路由，未知 session 不回退 native；有 deterministic facade test。
- `IAgentHostService`、`rpcTargetService.ts`、`client/src/remoteServiceAccess.ts` 已建立独立 target-local RPC 面。Desktop local Host 和 standalone server Core 进行服务登记；generic web/replayable channel 排除该写入/历史频道，已有 scope/server-info 测试。
- `packages/shared/src/agent-host/v4.ts`、`packages/services/src/agent-host/conversationBridge.ts`、`packages/ui/src/v4/agentHostConversationTransport.ts` 已提供 additive external create/subscribe/ACK barrier/frame/recovery/rowsRange/command seam；Host 仍拥有 snapshot、seq、journal、dispatch 和 receipts。runtime admission 独立于 delivery profile：只读订阅默认 `existing-only`，明确 attach/新建动作才传 `start-if-needed`；desktop-continuous 覆盖 online，web-remote-replayable 覆盖 recovery，且两种模式都能冷读 terminated history。bridge 现在依赖窄 source port，cold subscription 在 source attach 后保持同一 subscription 接收 live/recovery；rowsRange 从完整 Host journal 投影跨 tail window 分页。ProjectSidebar 已挂到旧 WorkspaceSidebar Project/Workspace 区域并保留 legacy fallback；真实 Electron focus/offline E2E 与 production native/external create mount 仍未认证。

### 未实现/未认证

- 没有完整的 `ZCodeHarnessAdapter` 产品适配层。当前外部 Pi Host 已有一条 bounded V4 bridge/transport seam，但 Router 和 facade 仍不能替代统一 HarnessAdapter 的全部控制/事件实现。
- facade/ConversationTransport 已有生产可消费 port；ProjectSidebar native selection 复用既有 task callback，external selection 在 mapping port 未就绪时 fail-closed disabled。完整 Harness Picker/Header 共用、external create mount 和 side-by-side UI regression 仍未认证。
- Project Catalog、WorktreeService、只读发现和显式接管已有 service ports；ProjectSidebar UI 正在接入，主检出/linked worktree、旧 session owner 保留和跨 target 映射仍依赖迁移 source 联合。
- 没有严格 sidecar migration、future-version write rejection、旧 session/model/permission 保留和回滚演练。
- `ZCODE_MULTI_HARNESS_ENABLED`：env 契约已锁在 `docs/agent-host/MULTI-HARNESS-ADMISSION.md` 与 `isMultiHarnessNewSessionAdmissionEnabled`（仅 `"1"` 开启；生产 `node.ts` / server CLI 共用）。完整产品 E2E（Picker/侧栏/create mount on/off）仍缺。

P2 验收需要 native facade 开关 on/off、旧历史与设置保留、同工作区三会话不新增 worktree、后台不抢焦点、Picker/侧栏/Header 统一目录图标。当前只具备路由和隔离 channel 的确定性证据。

## P3：Pi、现有模型层和统一 GUI

状态：**Pi worker 和 fake model loop 已有；真实模型、SSH 和 GUI 验收未完成**。

### 已实现

- `packages/services/src/agent-adapters/pi/piHarnessAdapter.ts`：固定 Pi SDK 0.87.1 adapter，create/attach/send/cancel/resolve/terminate/subscribe，worker 进程和 sequence identity 校验。
- `piWorker.ts`/`piProtocol.ts`：worker-local Pi agent loop、隔离 `HOME`/agent directory/session directory、Pi ModelRuntime provider、请求 correlation ID、abort、结构化事件转发。
- `piModelStream.ts`：Pi transcript 到现有 ModelRequest 的桥；不支持图片、opaque reasoning/signature、非 auto tool choice 等能力时 fail-closed。
- `createPiHarness.ts`、`modelBinding.ts`、`registryCatalog.ts`：生产 wiring 通过 live Registry selection/fingerprint 和 `AiSdkModelAdapter.createModel()` 创建 host-managed model；没有另造 HTTP client。
- worker hook 在后端阻止未授权 write/edit/bash；read 可按声明 unattended；工具路径、审批、turn/interaction/epoch 和结果事件有 deterministic coverage。
- `agent-ui-projection/projector.ts`：V4 子集投影、终端 message 替换 delta、工具/审批/usage/rows window；不会从投影触发工具。
- `agentHostPiModelBridge.test.ts`、`agentHostPiWorker.test.ts`、`agentHostPiToolLoop.test.ts` 覆盖 fake model 文本、拒绝图片、真实 Pi SDK worker、读→写→bash→追问和拒绝审批。

### 缺口和限制

- 当前已记录 92 次隔离 live Pi/Provider 尝试；StepFun Linux/Mac 新版路径通过，AxonHub Linux 新版通过，AxonHub Mac 路径按拒绝结果收尾。仍需按完整 acceptance matrix、用量和 route trace 汇总，不能把尝试次数当 host-managed/P4 完成。
- `createRegistryPiHarness` 默认构造 `AiSdkModelAdapter({})`，与 CLI bootstrap 的 `ApiProviderModelRuntime` 实例及其 execution config、status sink、request-auth 装配不同。代码路径存在，但真实路由、辅助调用、日志和认证仍需验证。
- Pi adapter 当前只认证 `reasoningLevel=off`；images、reasoning、opaque provider state、runtime model switch、native resume 等明确 unsupported。
- Pi `probe()` 要求 target platform 与当前 process platform 相同；SSH target 在现有实现中不能作为独立远端 worker 执行。P3 要求的 Pi 最小 SSH 和四个本地 ZCode/Pi×Provider 组合均未完成。
- UI 没有生产挂载，不能验收 Pi/Pi/ZCode 同 worktree、模型切换不改变 Harness 图标、后台不抢焦点和共享文件风险提示。
- 同 worktree 多写会话、一个会话停止不影响另一个、同 native/backend ID 隔离，当前没有真实多 worker/文件并发认证。

P3 的真实验收必须包含两个不同 Provider、本地 macOS、Linux SSH、读→修改→测试→二轮追问、审批拒绝无副作用、实际 requested/effective route 和完整 trace。当前只完成协议与 fake-loop 子集。

## P4：Runtime Host、owner fencing 和 SSH 持久化

状态：**Target-local durable 基础已实现，独立生命周期和远端恢复未完成**。

### 已实现的基础

- `SessionHost` 在 backend create 前写入 `creating` manifest，使用 CommandJournal/EventJournal；accepted command 先持久化；不确定 send 会阻止下一次 prompt；历史读取不加载 adapter/Provider。
- `EventJournal` 按 `(hostSessionId, runtimeEpoch, sequence)` 校验、去重 source event、拒绝 gap/foreign event；journal lock 提供同一 journal 文件的进程占用检查。
- `AgentHostTargetService` 做 target/worktree 回调、host mount、history list/snapshot/events/query；`createRpcAgentHostService` 只暴露窄 RPC allowlist。
- Desktop local Host 和 standalone server Core 已有 service registration；server HTTP 对 generic web 和 trusted host channel 采用不同暴露策略。
- Pi worker bundle 入口存在于 desktop out、standalone dist 和 Linux release staging；有 bundle verification script 和无凭据初始化 smoke 的历史证据。

### 未完成的 P4 硬门槛

- 仓库已有通用 server supervisor、platform service manager、`cli serve --daemon`、launchd/systemd 与 runtime/lock 入口；外部 Harness 的活动计数、owner 生命周期、GUI 断开恢复和 SSH 持久化仍未接线验证，不应另造第二 daemon。
- owner/lease/fencing 仍主要是内存 map 和按 journal 文件的锁。`AgentHostTargetService.#owners` 在异步 create mount 前存在竞态；Pi adapter 的 `#sessions` 也在异步 spawn 后写入。需要跨请求/跨进程的唯一 owner reservation、stale generation 和 crash recovery 测试。
- Worktree Catalog 已提供 realpath/filesystem evidence、generation、discovery/adopt/revalidate；lazy AgentHost 的 `authorizeWorktree`（`authorizeLazyWorktreeAdmission`）已做 catalog 查找 + `revalidate` + `worktreeGeneration` recheck，generation / path / lifecycle 不匹配则拒绝 admission。UI 接管、跨 target 映射与真实 SSH/删除竞态仍未验收。
- SSH upload/install/attach/resume、远端事件持续消费、GUI 完全退出、SSH 断开/重连、审批中断线和服务崩溃恢复均未实测。`IRemoteBackend.exec()` 的 stdio 连接不能当作持久化 Host。
- 没有工作区删除期间冻结新 admission、运行/审批/未知状态预检、目录消失/重建和离线重同步流程。
- P3 四个本地组合加四个 SSH 组合、真实 Provider、owner crash/process fault 均未认证。

P4 完成前不得标为首个可用版本。下一步依赖 P1 Catalog/identity、P3 真实 Pi route，然后实现 supervisor、远端安装协议和 owner fencing。

## P5：Model Gateway、Codex 和 Claude Code

状态：**部分完成，仅 FakeModel / experimental。P5 未完成。** Gateway core、Responses，以及 Codex FakeModel 控制/绑定已在 tip；真实 SSH 与 live Provider 未认证。

已在 tip 上，但不能计入 P5 完成：

- `packages/services/src/model-gateway/` 已存在。Gateway core、route authorization、Responses ingress/egress 与兼容矩阵已落地。Codex app-server 的 FakeModel 控制/绑定已接入 Agent Host（active-turn 绑定冻结、idle rebind、短 TTL 续期、target-side turn lease、审批单赢家）。证据是 loopback FakeModel，不是 live Provider 或模型质量认证。
- #26：SSH kind 上 Codex 使用共享 `TargetModelGateway`。`packages/services/test/modelGatewaySshAdmission.test.ts` 覆盖 FakeModel admission：`kind: "ssh"`、共享 owner 注入，以及 tunnel drop 之后同一 loopback 仍可服务。SSH 执行目标上的 Gateway 是 **remote Core loopback**；关闭 SSH tunnel **不等于** 关闭 Gateway，也不撤销 grant。
- 兼容矩阵在 `target.kind === "ssh"` 时仍为 **experimental**（远端凭据路径未认证）。FakeModel 只证明 Codex 共享 Gateway 注入，不认证远端凭据。
- Claude 已有 structured control 与 Messages 实验路径（pinned CLI stream-json、loopback FakeModel；见 `CLAUDE-CODE.md` 与 `packages/services/src/agent-adapters/claude/SPEC.md`）。该路径的 Gateway 仍是 **adapter-local**（未注入时 `new TargetModelGateway(...)`）。Claude **不是** 共享 `TargetModelGateway` owner；`lazyTargetService` 只把共享 owner 注入 Codex。
- 历史隔离探针 `probeCodexAppServer.mjs` / `probeClaudeMessages.mjs` 与 Codex 0.156.1 观察仍单独保留，不改写成 0.157.1 或 live 认证。

未完成（下列项保持未认证，P5 不得标完成）：

- 真实 SSH / remote credentials 未认证。`packages/services/test/runtimeOwnerFence.test.ts` 的「真实 SSH 断线后 Core 仍在运行」保持 skip（当前没有可授权的真实 SSH 目标）。
- live Provider、实际模型身份与模型质量未认证。
- Claude → 共享 `TargetModelGateway` owner 未接线。
- auxiliary endpoint 矩阵、可用的 `workspace-write` sandbox、生产组合与跨 target 部署未认证。

P5 必须按 Harness 拆成 control/event 认证和 host-managed model ingress 认证。FakeModel 控制面成功只能标 experimental，不能标 live certified，也不能把 P5 标成完成。

## P6：通用 ACP、长尾 Harness 和发布加固

状态：**部分完成（脚手架 + 一个可选 Agent）；P6 未完成**。

已在 tip 上、但不能标 P6 完成：

- 可复用 ACP transport/adapter 与 session machine：`packages/services/src/agent-adapters/acp/`（`COMPATIBILITY.md` / `SPEC.md`）。
- 长尾示例：Devin **可选** ACP profile（`agent-adapters/acp/agents/devin.ts`，`devin acp`）；与 print-mode `devin` 同 harness id，**不得**在同一 `HarnessRegistry` 双注册（见 `devin/PROTOCOL.md` 与 exclusivity 测）。
- lazy Host 默认 Devin 路径仍是 **print-mode `-p`**（`createExperimentalRegistryDevinHarness`），不是默认 ACP。

仍缺：能力协商/版本矩阵产品化、安装诊断与升级手册、长期压力测试、第二个生产 ACP Agent、把 lazy 默认切到 ACP、发布加固。历史 ACP retirement 测只保护 native 边界，不是完整 P6 验收。

交付依赖 P1 manifest/factory、P3/P4 已验证 model binding/target Host，以及至少一个真实可用 ACP Agent。验收必须证明第二个同协议 Agent 只增加 manifest、绑定配置和必要扩展，不修改公共会话状态机；不支持 resume 的 Agent 只能历史只读；未知扩展安全降级；协议升级回到实验状态。

## §13 Project → Worktree Workspace → Agent Session

状态：**P1 数据契约、Worktree/Catalog ports 和 ProjectSidebar 首批实现已存在；真实 UI/E2E 与迁移联动仍未闭环**。

### 13.1 可见实体和行为

- `Project`、`WorktreeWorkspace`、`AgentSession` 的共享 schema 已存在；ProjectSidebar 首批已显示 Project/Workspace/Agent 三层树、空工作区、main/detached head 和 stable session rows；Catalog 为空时保留旧 workspace/task 区域，生产 focus/offline E2E 仍未认证。
- 现有 `tabStore.ts` 仍只是窗口 view/tab 状态；独立 Project Catalog 已存在，ProjectSidebar 不以 tabs 作为数据库。

### 13.2 数据模型和身份

- hierarchy schema 已覆盖 `Project.id/name/iconAssetId/defaultWorkspaceId`、`RepositoryBinding`、worktree generation/head/origin/lifecycle/verification、session workspace/harness/title/model binding。
- `deriveExecutionSnapshot` 只从 binding/workspace/session 派生 target/path/generation/cwd；不做 realpath/Git/远端 authority。现有 `SessionSpec.hostSessionId` 与新 `AgentSession.id` 的 Host identity 一对一映射仍需在接入前明确。
- 缺少 durable Project Catalog、binding/workspace/session store、跨进程唯一性和 future schema migration。

### 13.3 发现、导入、接管、新建

WorktreeService 已实现 `git worktree list --porcelain -z` discovery、main/linked/detached/bare 分类、explicit adoption、generation/evidence revalidation、幂等创建及确认式 linked-worktree 移除。移除复用 target-local 持久 fence，与 native CommandInbox 和 AgentHost create/send 共用；UI 接线、完整离线重同步、真实 SSH/macOS 矩阵仍待验收。

### 13.4 同工作区多 Agent

共享 schema 允许同一 Workspace 多个 session，hierarchy fixture 有两个 Pi session；没有生产 create flow、独立 native/backend/model/approval/stop owner、引用计数 worker、共享文件冲突提示或同 worktree 多写认证。

### 13.5 图标、状态、侧栏和 focus

- 新增 `HarnessIcon`、`SessionStatusIcon` 和 Host manifest directory 接缝；ZCode 复用既有受控静态资源，未知/Pi 未授权资源安全 fallback。Pi 真实品牌资源、许可清单和 Header/Picker 共用挂载仍待后续接线。
- 纯 projector 已有 activity/freshness/recent outcome/unread/pending 聚合模型；轻量 sessions-index transport、UI view store 和后台订阅仍未接入。
- `projectSidebarViewStore` 已独立持久化展开/隐藏/选择状态，树行使用 Project/Workspace/Session stable IDs；后台 summary 事件走有界刷新且不改 active selection。真实 browser/Electron focus/offline E2E 仍待执行。

### 13.6 生命周期、删除和安全

Worktree 服务现有 archive 元数据/fence 与确认式 remove；remove 会并发读取 native CommandInbox/live V4 phase 与完整 AgentHost activity index，unknown、running、approval、accepted queue、main、dirty/untracked、submodule、locked/stale 都 fail closed。Main TaskRealtimeBus 只按既有 session/lease owner route 请求 Host 原生只读事实，不复制 queue。拒绝不结束会话；Git 成功但 Catalog 写失败时保持 fence 并在重试时先核对 Git、不会重复 remove。hide/detach/cancel/terminate 的 UI 语义和离线 freshness 仍未全链路验收；宿主不能枚举外部终端进程，预检明确显示该边界。

### 13.7 旧数据迁移

没有从持久化 session/workspace 索引收集旧数据、解析 worktree/common directory、添加 project/workspace 关联、保留 cwd/model/native ID、dry-run/backup/schema map/rollback 的迁移脚本。现有 Claude history import 不等于 v0.3 层级迁移。

### 13.8 交付与产品验收

未完成的场景包括：主检出+两个 linked worktree、同工作区三个会话、两个同 Harness、模型换品牌图标不变、manifest icon fallback、关闭视图再打开、后台更新不抢焦点、隐藏工作区待审批、SSH freshness、同路径跨 target、branch 改名/目录重建、删除竞态、旧 cwd 子目录、共享 worktree 写入和 50 worktree/10 session summary 压测。

当前 63 个 agent-host/Catalog/directory/sidebar/ConversationTransport 测试只证明纯 Host/UI/层级/Catalog/数据层契约子集，不能替代 §13 产品验收。

## PR/批次依赖台账

| 批次 | 计划内容                                                                      | 当前状态                                                                                              | 下一依赖/验收门槛                                              |
| ---- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 01   | P0 基线、隔离目录、原生 fixture、来源/许可                                    | 部分完成                                                                                              | 固定工具链下 native + SSH baseline 和 trace                    |
| 02   | Agent/Session/Turn/Item、Project hierarchy schema、Registry、图标描述、Mock   | schema/Registry/Mock、directory/sidebar pure contracts 已完成；完整 fault/fixture 仍缺                | manifest factory、target probe、完整 fault/fixture             |
| 02A  | Catalog、RepositoryBinding、WorktreeService、发现/接管/新建                   | Catalog/Worktree discovery/adoption ports 与确定性测试已有；UI candidate/adoption retry 进行中        | 依赖 02；迁移 source、真实 target 与 UI 回滚验证               |
| 03   | SessionRouter、ZCode adapter、additive metadata、旧 session→workspace mapping | Router/metadata 有，adapter/migration 无                                                              | 依赖 02A；native owner 不变和 migration dry-run                |
| 04   | UI facade、目录 Picker、capability gate、native regression                    | facade/channel 有，未挂载                                                                             | 依赖 03；UI on/off、旧数据和服务端拒绝                         |
| 04A  | Orca 三层侧栏、summary、双图标、view/focus                                    | ProjectSidebar 首批已挂 legacy Project 区域，service summary/view store 有；真实 E2E/icon source 仍缺 | 依赖 04 + 02A；E2E/focus/offline/summary                       |
| 05   | 现有模型执行入口、ModelBindingPlanner                                         | planner/catalog/bridge 有，runtime 配置复用和 live route 无                                           | 依赖 02；真实 requested/effective route 与辅助调用             |
| 06   | Pi transport、model bridge、Harness adapter                                   | fake/local worker 有                                                                                  | 依赖 05；两个 Provider、本地矩阵、真实审批                     |
| 07   | 外部 journal、V4 projector、Pi 双模式、多会话 E2E                             | journal/projector 有，UI/E2E 无                                                                       | 依赖 04A + 06；共享 worktree 多会话和 UI                       |
| 08   | Runtime Host、SSH 生命周期、目标继承、恢复/fencing                            | target-local 基础与通用 supervisor/service manager 已有；Harness lifecycle/SSH restore 未接线         | 依赖 07；八组合、断线/GUI exit/crash                           |
| 08A  | worktree removal admission、重建、离线重同步、archive/hide                    | Worktree 移除/fence/native+external 准入与隔离 Git/CLI 测试已实现；UI/SSH 离线重同步未验收            | 依赖 08；UI/E2E、SSH 离线恢复及删除竞态矩阵                    |
| 09   | Gateway core + Responses + Codex                                              | 部分完成 / FakeModel only：core + Responses + Codex 控制/绑定已在 tip；#26 SSH 共享 TargetModelGateway 仅为 FakeModel admission，兼容仍 experimental | 依赖 08；live Provider、真实 SSH 凭据与生产组合仍未认证        |
| 10   | Messages + Claude structured adapter                                          | 部分完成 / FakeModel only：structured/Messages 实验路径已有，Gateway 仍 adapter-local，不是共享 owner | 依赖 09；共享 TargetModelGateway owner 与 live Provider 未认证 |
| 11   | 通用 ACP + 一个长尾 Agent                                                     | 部分完成：ACP adapter + Devin 可选 ACP profile 已在 tip；lazy 默认仍 print-mode；第二 Agent/发布加固未做 | 依赖 08 和已验证 model binding；勿把 print-mode 写成 ACP 完成 |
| 12   | 层级/并发/focus 压测、迁移回滚、版本锁定发布                                  | 未实现                                                                                                | 依赖 08A/09/10/11；50 worktree、10 session、8h、fault matrix   |

建议执行顺序：

```text
P1 manifest + SidebarSummary + pure projector
→ P1 Catalog/WorktreeService/discovery/adoption
→ P2 ZCode adapter + migration + facade mount
→ P2 Orca sidebar/icons/focus
→ P3 live Pi model route + two-Provider local matrix
→ P4 supervisor/owner fencing/SSH persistence
→ P5 Responses/Codex + Messages/Claude
→ P6 ACP/long-tail/release/load
```

每批必须附变更边界、未支持能力、实际命令/版本/target、失败原因、迁移影响和回滚方式。没有真实 target、隔离凭据和预算的批次只能完成确定性或 fake 验收，不能把状态提升为 live certified。

## 后续真实认证所需外部输入

在不读取凭据、不把 key 放入命令行或日志的前提下，完成全计划至少需要：

1. **固定 macOS 本地环境**：已按用户授权探测到可连接的 macOS arm64 目标，但默认 shell 没有 pnpm、默认目录不是仓库；baseline 已准备工具链/隔离 scope，仍需验证 GUI exit、local worker、审批和本地两个 Provider 的完整 trace。
2. **固定 Linux SSH target**：P4 计划需要可授权连接的 Linux x86_64 主机、target-local Node/runtime 与可写隔离目录；需要验证 bundled worker、服务 supervisor、upload/install、attach/resume、断线重连和远端审批。当前探测到的是 macOS 目标，不能替代该 Linux SSH 组合；只提供 SSH 登录或 `exec()` 不足以满足 P4。
3. **两个不同 Provider 的隔离授权**：用户已要求少量 live 消费，当前已由主代理集中完成 92 次受控 Pi/Provider 尝试；StepFun 新版 Linux/Mac 路径和 AxonHub/DeepSeek Linux 新版已有证据，Mac 拒绝路径仍按拒绝结果记录。后续只补 acceptance matrix 缺口，凭据仍只由 credential store/target host 读取，不进入本台账、事件或普通日志。
4. **Codex/Claude 固定版本输入**：Codex app-server 0.156.1、Claude Code 2.1.263 或重新锁定的替代版本及其 protocol fixture；需允许针对 fake Gateway 先做协议追踪，再由用户授权真实 Provider route。
5. **产品验收环境**：能同时保留两个 worktree、同 worktree 多 session、可安全创建临时文件并恢复；明确是否允许 8 小时/十万合成事件压力测试和可接受资源预算。

当前已有受控 live Provider/Pi route 尝试和 SSH capability probe；尚未把它们扩展成完整 GUI/SSH/owner-crash acceptance，也不把 partial route 结果写成 P3/P4 全部认证通过。凭据、真实账户和内部地址仍不进入台账。
