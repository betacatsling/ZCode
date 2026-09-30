# ZCode 多模型 × 多 Agent Harness × Orca 式项目层级改造计划

版本：0.3（加入 Project → Worktree Workspace → Agent Session 层级）  
编写日期：2026-09-24  
源码基线：`zai-org/ZCode@328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f`（该提交说明为 v3.14.3）  
参考代码基线：`BytePioneer-AI/codex-host@d9fa7aa26474127bb80cbf086cd49503f7cc4ccf`（该快照根 package.json 标记 0.10.0，不表示已核实同名发行 tag）。[C0][C12]  
状态：架构与实施计划；本次根据用户提供的 Orca 侧栏截图和三条层级要求修订，并补查同一固定源码基线的 tabStore、Git 类型、图标入口和 CodexHost Pi manifest。尚未实施、编译或进行真实 Agent/SSH 联调；没有改动用户仓库、Git worktree 或现有会话。

本版是完整合并计划，不仅是增补说明；保留 v0.2 文件。v0.3 的产品层级、工作区执行位置继承规则、同工作区新增会话行为优先于旧版相应描述。源码仍固定到上列 commit，不将检索时看到的更新 main 混作同一基线。

## 0. 本次修订摘要

**本版新增且进入首个可用版本的三条产品要求：**

1. 项目下有多个长期存在的工作区；Git 项目中每个工作区对应一个实际 worktree，主检出也作为工作区，不以 branch 或 tab 代替。
2. 一个工作区可以有多个独立 Agent 会话，允许不同 Harness 混跑，也允许同一种 Harness 开多个会话；“新增 Agent”默认复用当前 worktree，不自动创建新 worktree。
3. 会话行展示真实 Harness 图标，并分别展示运行状态、标题和更新时间；图标来自注册目录，不从模型名或标题猜测。

执行位置绑定在 worktree 工作区上，由其下所有 Agent 会话继承；模型和 Harness 是每个会话自己的选择。侧栏稳定采用 **Project → Workspace → Agent Session**，主机以工作区标签和筛选维度出现，不强制再加一层主机树。

P1 提前引入三层实体和归属契约；P2 完成工作区发现/接管、旧会话映射、三层侧栏和图标；P3/P4 增加同 worktree 多会话、后台不抢焦点与 SSH 继承验收。第 13 节给出完整规格。

以下保留 v0.2 确定的 CodexHost 参考方向：

CodexHost 作为 Harness 控制/事件适配的主要参考实现，不作为统一模型层已经完成的证据。复用边界是设计与经过许可审查的局部模块，而不是把整个 CodexHost 或 Codex Desktop 接线搬进 ZCode。

- 公共契约采用 `HarnessAdapter → HarnessSession → HostEvent/HostItem` 的分层思路；ACP 是某个 adapter 的内部传输，不是整个产品的强制中间协议。[C1][C2][C3]
- 保留现有 ZCode Model Runtime，新增 Model Binding Adapter/Gateway；不能把 CodexHost 的原生 Model Catalog 当作模型推理调用的统一抽象。[C5][C6]
- Pi 首先复用/参考原生 RPC 的会话与事件设计，但在“RPC + 显式模型扩展”和“SDK worker”之间做受限验证后再选路线。通过原生模型目录跑通聊天不算完成统一模型接入。
- 把 CodexHost 的 UI projector 设计换成 ZCode V4 projector，保留已有 UI 和原生 V4 路径；不迁移 Codex Desktop 注入、私有 UI 兼容补丁或静态 Agent 名单。[C7][C8]
- P0 增加源码来源/许可清单，P1 增加插件工厂与能力目录，P3 增加原生/宿主模型双模式验收，P4 保留独立持久化硬门槛。详细代码导航与任务见第 12 节。

## 1. 目标与范围

保留 ZCode 现有 Model Provider、模型目录、模型选择、模型调用适配能力，把 Harness 与模型解耦，再把 Harness 输出转换为统一的 UI 表示。项目组织多个 worktree 工作区，每个工作区承载多个独立 Agent 会话。创建或接管工作区时确定执行位置；在其中创建会话时选择 Harness 和兼容模型。

产品目标：

```text
Project：ZCode 改造
├── Workspace：主检出 [主要] [Local Mac] [当前 branch]
│   ├── Agent Session：Pi — 调研
│   ├── Agent Session：Pi — 实现
│   └── Agent Session：ZCode — 审阅
└── Workspace：harness-refactor [server1] [feature/harness]
    ├── Agent Session：Codex — 实现
    └── Agent Session：Claude Code — 审阅

每个 Workspace 绑定一个真实 worktree 和执行目标。
每个 Agent Session 独立绑定 Harness、模型、原生会话、权限与状态。
Agent 名单为目标形态；真实可用性仍以分阶段验收与 Host 目录为准。
```

“自由组合”的实现定义是：所有已通过认证的 Harness × Model × Execution Target 组合都可以选择；未支持或语义有损的组合有明确原因，不能用静默丢字段或自动换模型冒充支持。协议接通不等于该 Harness 在该模型上的任务质量已经验证。

第一期平台按 macOS 桌面端、macOS 本地执行和 Linux SSH 执行设计；Windows、WSL、Docker 复用接口，但不进入首个版本的验收范围。

首个可用版本要求：三层侧栏、真实 worktree 管理、每工作区多个会话、Harness 图标，以及 ZCode + Pi、来自两个不同 Provider 的模型、本地 + SSH、结构化 GUI、可靠断线重连与审批。随后接入 Codex、Claude Code，最后扩展通用 ACP 长尾 Agent。侧栏的三种图标可先以 Mock 验证，不把尚未接入的真实 Harness 标成可运行。

暂不做：重写整个 UI（本版明确重构项目侧栏与导航）、替换终端内核、重写任何 Harness 的 agent loop、统一所有 Harness 的内部上下文存储、跨 Harness 无损迁移运行中会话、自动挑选最优 Agent、自动多 Agent 协作调度、插件市场、所有模型与所有 Harness 的全组合承诺。同工作区多会话管理属于首期，不等于必须增加自动委派调度。

## 2. 已核实的源码边界

以下是源码事实，不是计划中的新接口。

| 边界               | 当前文件                                                                       | 对改造的影响                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Agent 身份         | `packages/shared/src/providers.ts`                                             | 当前 Agent provider 枚举只有 `glm`。[S2]                                                                                             |
| Agent 归一化       | `packages/shared/src/zcode-agent-policy.ts`                                    | 归一化函数始终返回 ZCode Agent，不能原样用于第三方会话。[S3]                                                                         |
| 第三方兼容退役测试 | `packages/ui/test/nonCliAcpRetirement.test.ts`                                 | 有拒绝第三方 Agent 身份、移除旧设置的断言。应限定原生路径的适用范围，而非整份删除。[S4]                                              |
| 模型执行工厂       | `apps/zcode-cli/packages/bootstrap/src/app/provider-registry-model-runtime.ts` | 已经通过 Registry 解析选择、验证配置并创建模型，值得复用。[S5]                                                                       |
| 统一模型执行       | `apps/zcode-cli/packages/adapters/src/model/model.ts`                          | 有 `generateText`、`streamText`、`bind`、请求与选项校验，不应再平行发明一套模型客户端。[S6]                                          |
| V4 命令            | `packages/shared/src/zcode-protocol-v4/command.ts`                             | 当前包含 createSession、sendText、stop、resolveInteraction、队列与文件恢复等产品语义。[S7]                                           |
| UI 传输接口        | `packages/ui/src/v4/transport.ts`                                              | 已经有命令、ACK、查询、订阅、重同步、历史分页和附件接口。[S8]                                                                        |
| UI 投影状态        | `packages/ui/src/v4/conversationProjectionStore.ts`                            | snapshot 整体替换、delta 必须连续、断档重订阅；不能靠零散文本事件直接填充 UI。[S9]                                                   |
| 服务装配           | `packages/services/src/node.ts`                                                | 新路由器、模型服务和宿主的候选装配位置；仍需实施时确认完整依赖图。[S10]                                                              |
| Agent 进程         | `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`                | 当前有 ZCode 协议和进程生命周期耦合；应先包装，不直接拿来启动任意协议 CLI。[S11]                                                     |
| 远程执行底座       | `packages/server/src/remote/backend.ts`                                        | 已有 detect、upload、exec、断线通知等；接口本身并不证明 GUI 退出后进程仍存活。[S12]                                                  |
| 窗口 tab 状态      | `packages/ui/src/store/tabStore.ts`                                            | 有 per-window 的 WorkspaceTabState、workspaceIdentity、远端信息和展开/选择状态；持久化项目与工作区不能继续仅靠打开的 tabs 枚举。[H1] |
| Git 工作区分类     | `packages/shared/src/git.ts`                                                   | 已有 not-repository / main-tree / linked-worktree 类型；可复用分类，不代表已实现新 worktree 生命周期服务。[H2]                       |
| 现有 Agent 图标    | `packages/ui/src/lib/providerCliIcon.tsx`                                      | 该基线忽略传入 provider 并返回 GLM 图标；需保留原生兼容入口并增加真正按 Harness 解析的图标组件。[H3]                                 |
| 参考插件图标       | CodexHost `packages/adapters/pi/manifest.json`                                 | 声明 id/name/entry/icon，相对图标路径作为资源声明，可参考其元数据来源；不能直接透传任意文件路径给浏览器。[H4]                        |

源码审阅不等于运行验证。P0 必须实测干净环境中的构建、原生会话与 SSH 行为。

## 3. 核心架构决定

### 3.1 保留模型层，增加两个不同方向的适配边界

```text
                         ZCode GUI
                  命令 ↓          ↑ UI 快照/增量
                    Session UI Facade
                    /               \
       原生 ZCode V4 路径          外部 Agent 路径
          （先保留）          UI Projector ← Canonical Events
                                          ↑
                                  Harness Adapter
                            Pi / Codex / Claude / ACP
                                          │ 模型调用
                              Model Binding Adapter
                               /                 \
                     直接调用模型服务          Model Gateway
                               \                 /
                             现有 Model Runtime
                             现有 Provider Registry
                                      │
                                  Model APIs

上述执行服务由 Execution Target 上的 Runtime Host 持有。
GUI 是客户端，不是运行中会话的所有者。
```

Harness Adapter 负责控制与事件：创建、发送、停止、恢复、审批、工具状态等。
Model Binding Adapter 负责把现有模型能力接给 Harness：SDK 自定义模型接口、私有模型 RPC 或兼容 HTTP 入口。
UI Projector 负责把标准事件变成 ZCode 当前 V4 可消费的产品投影。

ACP 是 Harness 与宿主之间的协议，不是通用模型注入协议。加入 ACP 并不能自动把任意模型注入该 Agent。[S13]

### 3.2 两种模型绑定，三种实现路径

用户面只有两种明确语义：

| 模式              | 行为                                                  | 是否满足统一模型路由     |
| ----------------- | ----------------------------------------------------- | ------------------------ |
| `host-managed`    | 用户从 ZCode 的模型目录选择，调用经过保留的模型执行层 | 是                       |
| `harness-managed` | Agent 自行管理模型和账号，界面明确标记                | 否；作为可选兼容模式保留 |

`host-managed` 内部可以使用直接 SDK 适配或 Gateway。不能把“向 CLI 写入真实 Provider URL 和 Key、让它绕过现有模型执行层直接请求”算作完成统一模型层。

原生 ZCode 优先继续使用现有工厂。Pi 参考 CodexHost 的 `PiAdapter / PiHarnessSession / PiTurnTransport / PiRpcSession` 分层，把原生传输与公共会话分开。[C4][C4b] 先比较两条路线：A 为原生 Pi RPC 加经过明确启用的自定义模型扩展，扩展调用宿主模型服务；B 为独立 SDK worker，自定义模型执行同样调用宿主模型服务。两者均不在 Electron 主进程运行，不复制 Pi 的 agent loop。A 不能只选择 Pi 已有 Provider 就声称复用了 ZCode 模型层；B 不能为了模型注入破坏所需的扩展、工具和历史语义。按固定 Pi 版本实际验证后决定，不预先承诺 A 的模型扩展已经可用。Pi 的 SDK/Provider 文档仍是模型接入的核对来源。[S14][S15]

Codex 等外部 CLI 使用自身模型协议时，通过 Model Gateway 接回同一套模型执行能力。Codex 的 app-server 客户端接口与 custom model provider 配置是两个不同的集成面。[S16][S17]

### 3.3 不复刻整个 ZCode app-server

不把“写一个伪 ZCode Agent、让 UI 完全不用动”作为默认路线。V4 不只是消息事件，还包含幂等命令、查询、队列、订阅序号、快照与历史等状态契约。[S7][S8][S9]

采用渐进式路径：原生会话通过 facade 转发原有 V4；外部会话由独立 Session Host 维护命令与事件，再由 UI Projector 输出支持的 V4 子集。高级能力必须在客户端隐藏、服务端拒绝，不能仅在界面上藏按钮而后台仍能调用。

这不是另造两套永久 UI：两条路径共用现有展示组件；差异封装在 facade、projector 与 capability resolver。原生路径不同时拥有两份可写会话状态。

### 3.4 模型选择与运行事实分开保存

保存用户请求的模型选择；在每一轮开始时冻结实际绑定，记录模型目录版本、Provider、模型、适配器版本和执行目标。后续目录更新不能悄悄改变运行中的轮次。

除非用户显式配置，否则主模型、压缩模型、子任务模型等模型角色都应解析到同一选择。无法控制的后台调用必须报告，不能标记为完整 `host-managed` 认证。

不支持运行中切模型的 Harness，只允许下一轮或新会话生效。跨 Provider 的私有推理状态、签名、缓存标记等不能盲目迁移。

## 4. 契约与数据设计

以下类型是设计草案，不是 ZCode 已存在的 API；实施时复用现有 ModelSelection 等类型，配套运行时 schema、版本和测试。

```ts
interface SessionSpec {
  schemaVersion: 2;
  hostSessionId: string;
  projectId: string;
  workspaceId: string;
  execution: {
    // 宿主从 Workspace / RepositoryBinding 派生并校验，不由 UI 任意覆盖。
    targetId: string;
    workspaceIdentity: string;
    worktreePath: string;
    worktreeGeneration: string;
    cwdRelativeToWorktree: string; // 缺省 "."；迁移旧子目录会话时保留原 cwd。
  };
  harness: {
    id: string;
    adapterVersion: string;
  };
  modelBinding:
    | { kind: "host-managed"; selection: ModelSelection }
    | { kind: "harness-managed"; nativeModelId?: string };
}

interface BackendBinding {
  hostSessionId: string;
  backendSessionId: string;
  backendVersion: string;
  runtimeEpoch: string;
}

interface CapabilityReport {
  support: "supported" | "unsupported" | "experimental" | "unknown";
  reason?: string;
  constraints?: Record<string, unknown>;
}
```

hostSessionId 是宿主自己的稳定身份，不能要求等于所有 Agent 的 native session id。绑定应包括 target、workspace 和 Harness，避免不同主机同路径、不同后端同 ID 串读。同一 workspace + harness 可以有多个 hostSessionId，不能按这两个字段单例缓存会话。Project、Workspace、RepositoryBinding 的详细实体见第 13.2 节。

工作区确定执行目标，同工作区会话只能继承；切换到其他机器应选择/创建另一工作区，不把运行中会话拖拽换目标。Harness 与模型仍在会话级独立选择。

模型兼容性检查输出 `BindingPlan`，包含 route、请求/生效模型、支持能力、限制、凭据引用、启动覆盖配置、版本指纹。它不持久化 Secret 值。能创建聊天不代表 tools、images、reasoning、resume 等全部可用；每项能力分别报告。

### 4.1 Harness 接口

Harness Adapter 提供探测、创建、连接现有会话、发送、停止、交互回复、事件订阅和能力查询。版本不支持的可选操作返回结构化 `unsupported`，不降级成具有不同副作用的操作。

把以下动作严格区分：

| 动作               | 语义                                   |
| ------------------ | -------------------------------------- |
| `detach`           | 关闭客户端订阅，不终止任务             |
| `cancelTurn`       | 取消指定执行轮次，不等于杀死会话       |
| `terminateSession` | 用户明确结束整个会话及其受管执行       |
| `resumeExecution`  | 用 Harness 的原生会话状态续跑          |
| `viewHistory`      | 读取宿主已记录的展示历史，不承诺可续跑 |

不要创建 ClaudeSSHAdapter、ClaudeLocalAdapter 等乘积类。Agent 接口依赖 ExecutionTarget；执行层负责目标机器上的启动、文件与进程能力。

### 4.2 标准事件与投影

基础事件参考 CodexHost 的 Turn/Item 层次：`turn.started → item.started/updated/completed → turn.completed`；消息、可见推理、工具、命令执行、文件变更和子 Agent 是不同 Item，审批和问题是需要回应的交互，而非普通日志。[C1] 用量、会话状态、计划与错误按各自语义记录。扩展事件使用命名空间与版本，未知事件只能安全展示，不能让后端随意注入 UI 代码。不是机械把所有原生事件强塞入同一文本字段。

CodexHost 的能力模型区分权限选择 live/atCreate、fork/forkAcrossCwd、观察子 Agent/读取 transcript，值得参考；但本项目额外保留独立的 resume、viewHistory、detach、host-managed-model 能力及 unknown/experimental 状态。不能因为存在一个接口方法就假设所有 adapter 支持。[C5][C10]

每条宿主事件拥有 session、runtimeEpoch、sequence、eventId，并按需带 turnId、messageId、toolCallId、interactionId、parentId。保存 source event identity 用于去重与排障。原始诊断事件默认不完整落盘，开启时要有脱敏、配额、权限与保留期限。

投影是可重建的读模型；它不能成为重新执行工具的触发器。不能把最终 message 再追加到已经展示过的 delta 后面形成重复文本。工具参数只有完整结束时才按合法 JSON 提交，不把半截 JSON 当最终工具调用。

宿主不根据 stdout 文本猜测审批，不根据文本中的“完成”认定任务结束；使用后端结构化生命周期。缺少准确状态时显式显示未知。

### 4.3 明确状态所有权

| 数据                                       | 权威方                                                              |
| ------------------------------------------ | ------------------------------------------------------------------- |
| 项目分组、名称、工作区引用与排序           | 用户 profile 的 Project Catalog；首期明确单写入方，不伪装多端强一致 |
| 实际仓库绑定、worktree 身份/代际与执行准入 | 目标 Runtime Host；Catalog 只缓存它的验证结果                       |
| 用户会话选择、BindingPlan、宿主会话索引    | Runtime Host                                                        |
| 当前窗口焦点、展开态、草稿/滚动位置        | 独立 UI view store；不拥有执行生命周期                              |
| Agent 内部上下文、压缩状态、原生恢复文件   | 对应 Harness                                                        |
| 外部 Agent 的标准展示事件和投影日志        | Runtime Host                                                        |
| ZCode 原生会话的 V4 执行与投影事实         | 现有 ZCode runtime；先不复制写入                                    |
| 仓库文件、Git 状态                         | 执行目标上的文件系统与 Git                                          |
| Provider Secret                            | 经授权的凭据存储/模型服务，不是 renderer                            |

不能把统一展示历史直接当成所有 Harness 的原生运行状态。需要跨 Harness 接续时，另做显式的“创建新会话并导入摘要”，不称为无损恢复。

## 5. Model Gateway 设计

### 5.1 必要性

进程外 CLI 不会因为宿主定义了一个 TypeScript `Model` 接口就自动使用它。Gateway 把 Harness 所用的请求协议转换为现有 ModelRequest，再将现有模型输出转换回该 Harness 期望的响应协议。

```text
Harness 请求
  → 对应协议的 Ingress Decoder
  → 会话 BindingPlan 校验
  → 现有 ModelRequest / Model Executor
  → 现有 Provider Adapter
  → 模型服务
  → ModelEvent
  → 对应协议的 Stream Encoder
  → Harness
```

API 协议路径按接入需求递增实现：Codex 所需 Responses、Claude Code 所需 Anthropic Messages、长尾所需 Chat Completions。不要为了看起来通用一次实现三套完整协议。Claude Code 官方文档明确列出网关需接收的 Anthropic 格式与头部/功能语义，说明只改 base URL 不等于兼容。[S18]

### 5.2 不能省略的语义

必须测试 system/developer 指令、工具定义、流式参数、tool result 的配对、多工具调用、结束原因、取消、错误、用量、上下文限制、模型参数、图片等支持范围。

Provider 私有的签名、推理 opaque state、缓存内容必须在模型侧维持正确往返；不支持时明确拒绝或使用经验证的无该功能路径。不能伪造签名，不能把 private reasoning 当普通正文，不能悄悄丢工具调用或图片。

处理每个 Harness 实际调用的辅助端点，而不是只实现一次普通聊天 POST。实例：模型目录、计数、独立压缩或其他扩展请求。精确端点集由固定版本的运行追踪确定，无法支持的功能应被关掉并体现在兼容矩阵。

鉴权与能力解析属于 BindingPlan，不得把模型名称猜测当作协议事实。计划中的 Compatibility Matrix 同时包含 Harness 版本、Gateway 版本、模型来源、参数与目标平台。

### 5.3 安全与部署

Gateway 默认只绑定目标机器 loopback 或 Unix socket。Agent 使用会话级受限令牌，令牌在服务器端绑定可访问路由与模型，不接受客户端任意更改上游 URL。设置并发、请求体、日志与 token 使用预算。

真实 Provider Key 由模型服务读取，不交给 renderer；给 Agent 的配置采用受支持的会话级覆盖、隔离 profile 或环境变量，不覆盖用户全局配置，也不把密钥放入命令行参数与普通日志。

远程 Gateway 和凭据授权路径不能依赖 Mac GUI 持续在线。使用远端凭据、独立常驻模型服务，或用户明确授权的远程凭据方案。不同认证方式分别测试；统一路由不意味着可把一个服务的订阅用于其他服务。

## 6. 分阶段实施

每阶段以验收证据为门槛。不要在接口尚未冻结时让多个 coding agents 同时修改共享协议、迁移脚本或核心 facade。

### P0：固定基线和验证当前行为

**交付：**源码 commit、工具链和依赖版本记录；原生生命周期图；当前 UI→V4→runtime→model 与 SSH 链路图；构建结果；现有失败清单；基础回归用例与脱敏 trace fixture。加入 CodexHost 参考 commit、逐模块来源清单和许可决策，区分“参考后独立实现”“依赖模块”“复制/修改源码”。源码存在、测试存在、测试已运行、真实环境通过分别记录。

v0.3 增加：检查 tab→workspace→session 现有归属与 cwd；建立主检出、linked worktree、非 Git 路径、离线 SSH、同路径不同主机样本；核对 Git 版本和机器可解析输出能力；画出旧数据到新三级实体的映射，不在此阶段移动任何目录。

从独立开发数据目录运行，禁止测试覆盖日常会话与凭据。当前 README 给出了 Node/pnpm 版本和 bootstrap、桌面、SSH 资源准备命令；执行时按固定 commit 的 mise 与 README 为准。[S1]

**验收：**原生 ZCode 新建、发送、工具调用、停止、审批、恢复可以复现；至少一次 SSH 实际执行；每个失败都归类为基线失败或环境缺失，不能伪报全部通过。

**回滚：**只有测试、基线文档与隔离开发配置，无业务变化。

### P1：契约、注册表、兼容性规划与 Mock Harness

**交付：**SessionSpec、BackendBinding、AgentCommand/Event、BindingPlan、Capabilities、ExecutionTarget 接口；HarnessRegistry；标准错误码；MockHarness；序列化/反序列化与契约测试。参考 CodexHost 的 manifest + factory + adapter/session 边界，目录机制先只支持可信内置或显式启用的来源；无需插件市场，也不加载仓库里未经用户授权的代码。[C2][C3][C8] GUI 选择器从目标 Runtime Host 的目录和能力查询生成，禁止再平行维护一份硬编码 Agent 名单。

v0.3 同阶段交付 Project、RepositoryBinding、WorktreeWorkspace、AgentSession 关联、归属校验、SidebarSnapshot/Summary、图标资源描述和目录驱动测试。manifest 只描述图标资源与名称，执行能力继续以 inspect/session 为准。

Mock 必须能产生文本流、工具、审批、重复事件、异常退出、慢响应、缺失序号等，不依赖真实模型 API；另提供两个项目、每项目至少两个工作区、一个工作区三个会话（含同 Harness 两个会话）的侧栏 fixture。

**验收：**拒绝未知 Harness、非法模型组合、错误目标、重复 ID；可独立测试两类适配，不需要启动 Electron；每个能力有 supported/unsupported/unknown/experimental 和原因。

**回滚：**新增模块未启用，原生路径不受影响。

### P2：引入会话路由和 UI facade，保留原生路径

**交付：**SessionRouter、ZCodeHarnessAdapter、V4 facade、元数据扩展、会话能力驱动 UI；把已知旧 ZCode 会话读取为 harness=zcode；原生内部依旧可以保留 glm 命名。

v0.3 并入本阶段：Project Catalog、WorktreeService、只读发现/显式接管/新建工作区；三层侧栏、Agent 会话行、HarnessIcon + SessionStatusIcon、轻量汇总与持久化 view state；旧会话映射迁移。完整规格与安全行为见第 13 节。先以原生 ZCode 与 Mock 验证层级，不等所有 Harness 做完才改侧栏。

围绕 `transport.ts`、服务装配与会话索引引入新接口。不要先全库替换 `provider`，不要把所有未知后端归一成 glm。审计 `nonCliAcpRetirement` 测试并拆分“原生兼容策略”和“外部会话支持”两类断言。[S2][S3][S4][S8]

**验收：**开启新 facade 后，原生现有功能与 fixture 行为不变；关闭开关恢复旧路由；旧历史、模型配置和权限设置不丢失。同工作区新开三个原生/Mock 会话不增加 worktree 数；关闭最后一个视图不删除工作区；归档/隐藏不删除文件；不同图标在侧栏、Picker 和 Chat Header 一致；后台状态更新不抢焦点。

**回滚：**保留旧入口，新增字段可忽略；升级前备份，旧程序不应直接打开未来版本的外部会话数据。

### P3：Pi + 现有模型层 + 统一 GUI 的端到端验证

**交付：**Pi transport 选择记录、独立 worker 或 RPC 子进程、Pi ModelBindingAdapter、Pi HarnessAdapter、外部会话事件日志、命令日志、最小 ZCodeV4Projector；已有两个不同 Provider 的模型接入。先跑通原生控制/事件基线，再切换 host-managed 模型模式；前者只是阶段检查，不是此阶段最终验收。

Pi 的 agent loop、上下文、工具和扩展资源继续由 Pi 负责。控制/事件路径参考 CodexHost 的 RPC adapter，模型路径按第 3.2 节验证选择。模型请求必须经过保留的模型执行层，且记录实际执行路由；仅对 Pi 自己的 native model reference 编解码不满足该条件。[C4][C4b][C6][S14][S15]

第一轮只做文本、文件读取/修改、工具执行、取消、历史、明确可执行的审批；随后添加其他能力。需要审批时必须有真正阻止执行的后端钩子/工具包装/沙箱，不能只在 UI 画一个按钮。

**验收：**ZCode/Pi × 两个 Provider 模型的四个本地组合均完成“读文件→修改→执行测试→下一轮追问”；记录真正经过的模型路由。Pi 最小 SSH 执行也应在此阶段验证，不能把远端路径、cwd、配置问题全部留到最后。

层级验收：同一 worktree 中并存两个 Pi 和一个 ZCode 会话；模型与上下文独立，暂停/取消一个不影响另外两个；显示正确 Harness 图标，不按模型品牌换图；对同 worktree 写入的冲突风险明确提示，不自动替用户创建分支。

**回滚：**隐藏 Pi，新建禁用；其历史保持可读，原生路径独立可用。

### P4：Runtime Host 与 SSH 持久化

**交付：**目标机器上的常驻 Runtime Host；受管 worker 生命周期；事件/命令持久化；稳定身份；断线重连；单 owner 锁或 fencing；凭据和模型服务可用性检查；附件与路径隔离。

先验证现有远程 server 能否承担独立生命周期，再决定扩展它还是增加薄 supervisor；不预设必须再造一套 daemon。不得把 `IRemoteBackend.exec()` 提供的连接直接当作持久化承诺。[S12]

macOS 本地和 Linux 远端采用目标系统支持的独立服务生命周期。关闭窗口/断开 SSH 默认 detach，停止任务是独立操作。stdout 必须由宿主持久消费，避免 UI 离线造成管道背压堵死 Agent。

**验收：**P3 的四个组合在本地与 SSH 共八个组合完成认证；Mac GUI 完全退出、SSH 断开/重连时远端任务继续；恢复不重发 prompt、不重复修改文件；审批等待中重连仍是同一个请求；服务崩溃后的可恢复与不可恢复状态准确区分。

层级验收：工作区固定目标机器；同路径不同主机不串归属；远端断开后保留树与带过期标记的摘要，不能标成所有 Agent 已停止或完成；隐藏工作区有待审批时项目级仍有可达入口；工作区删除期间新会话准入被拒绝。

**回滚：**版本化服务目录和协议握手；旧会话仍由原 owner 管理，不能开关切换后被第二个 owner 重新启动。

**P4 完成后才称为首个可用版本。**

### P5：Gateway + Codex + Claude Code

**交付：**Model Gateway 核心及按需协议入口；Codex app-server adapter；Claude Code 的可用结构化 SDK/ACP adapter；兼容矩阵；CLI 独立配置与版本探测。

Codex 优先接官方 app-server，而非解析 TUI；模型侧使用 custom provider 指向已验证 Gateway。Claude Code 的事件侧与模型侧分别测试；仅接通 ACP 并不证明它接受宿主的任意模型。[S13][S16][S17][S18]

每种 Harness 拆为两个验收：先证实事件/控制面完整，再证实 `host-managed` 模型链实际生效。未通过后者的，只能标记为 `harness-managed` 或实验组合。

**验收：**每个支持组合必须通过主调用、多轮工具、审批、取消、恢复、用量、辅助模型调用检查。实际执行模型与界面选择一致；无法映射的特性明确拒绝；外部 CLI 的全局模型配置与登录配置未被覆盖。

**回滚：**按 Harness 和 Gateway 协议分别关闭新会话准入；不影响 Pi 和原生 ZCode。

### P6：通用 ACP、长尾 Agent 和发布加固

**交付：**可复用的 ACP transport/adapter 支持；复用 P1 的 Agent manifest 与工厂；能力协商；版本兼容报告；可诊断的安装/启动检查；更多 Agent 的认证结果；长期压力测试和升级手册。ACP 只是接入策略之一，原生 SDK/RPC/服务可表达更多真实能力时不强行再套 ACP。[C3]

选择一个具备当前可用 ACP 实现的 Agent，验证“只加 manifest、模型绑定配置和必要扩展，不再修改公共 UI/模型客户端”。ACP 的 session load 等能力是协商出来的，不能按品牌假设。[S13]

**验收：**新增第二个同协议 Agent 不再修改公共会话状态机；不支持 resume 的可以查看历史但不会伪装续跑；未知扩展安全降级；新的版本若改变协议则回到实验状态。

**回滚：**注册表禁用单 Agent 或固定旧适配器；不做静默跨版本会话迁移。

## 7. 建议 PR 切分与依赖

以下是计划，不是已创建的 PR。

| PR  | 内容                                                                                         | 依赖                           |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------ |
| 01  | 基线、隔离目录、原生 fixture、CodexHost 参考/许可清单                                        | 无                             |
| 02  | Adapter/Session/Turn-Item + Project/Workspace/Session 契约、schema、registry、图标描述、Mock | 01                             |
| 02A | Project Catalog、RepositoryBinding、WorktreeService、只读发现与显式接管/新建                 | 02                             |
| 03  | SessionRouter / ZCode adapter / additive metadata；旧会话到 workspaceId 的映射               | 02、02A                        |
| 04  | UI facade、Host 目录驱动 Picker、能力开关、原生回归                                          | 03                             |
| 04A | Orca 式三层侧栏、轻量汇总、Harness/状态双图标、view state 与 focus 测试                      | 04、02A                        |
| 05  | 现有模型执行层可复用入口与 ModelBindingPlanner                                               | 02                             |
| 06  | Pi RPC/SDK transport 受限验证、自定义模型桥、Harness adapter                                 | 05                             |
| 07  | 外部事件/命令日志、ZCodeV4Projector、Pi 双模式与同工作区多会话端到端                         | 04A、06                        |
| 08  | Runtime Host、SSH 独立生命周期、工作区目标继承、恢复和安全                                   | 07                             |
| 08A | 工作区移除准入、目录消失/重建、离线重同步、隐藏与归档安全回归                                | 08                             |
| 09  | Gateway core + Responses + Codex                                                             | 08                             |
| 10  | Messages 协议 + Claude 原生 SDK adapter（参考 CodexHost 生命周期）                           | 09；Gateway 契约固定后部分并行 |
| 11  | 可复用 ACP 接入与一个长尾 Agent，不扩展公共专用分支                                          | 08；复用已验证模型绑定         |
| 12  | 层级/并发/focus 压测、迁移与回滚演练、版本锁定和发布                                         | 08A、09、10、11                |

契约和共享 schema 指定一个集成人负责。模型侧、Pi adapter、UI projector 可以在契约冻结后并行；不要让不同 Agent 独立发明自己的 SessionId、能力字段或事件格式。

每个 PR 要附：变更边界、未支持能力、实际运行测试、失败与原因、迁移影响、回滚方法。测试未运行必须写未运行；live Agent 测试使用单独的授权凭据和预算，不在普通 PR CI 自动消耗账号额度。

## 8. 建议代码布局

先在已有 packages 内增加清晰目录，避免一上来增加大量独立 workspace 包。以下全部是拟新增位置，既有文件见第 2 节。

```text
packages/shared/src/project-workspaces/
  project.ts
  repository-binding.ts
  worktree-workspace.ts
  sidebar-summary.ts
  worktree-operations.ts

packages/shared/src/agent-host/
  session-spec.ts
  harness-plugin.ts
  backend-binding.ts
  capabilities.ts
  commands.ts
  events.ts
  binding-plan.ts

packages/services/src/project-workspaces/
  projectCatalog.ts
  repositoryBindingResolver.ts
  worktreeService.ts
  worktreeReconciler.ts
  sidebarIndexService.ts
  legacyWorkspaceMigration.ts

packages/services/src/agent-host/
  harnessRegistry.ts
  harnessPluginLoader.ts
  sessionRouter.ts
  sessionHost.ts
  modelBindingPlanner.ts
  commandJournal.ts
  eventJournal.ts
  runtimeSupervisor.ts

packages/services/src/agent-adapters/
  zcode/
  pi/
  codex/
  claude-code/
  acp/

packages/services/src/model-gateway/
  gateway.ts
  routeAuthorization.ts
  ingress/
    responses.ts
    anthropicMessages.ts
    chatCompletions.ts       # 有实际接入需求再做
  egress/
  compatibility/

packages/services/src/agent-ui-projection/
  zcodeV4Projector.ts
  conversationPublisher.ts
  sessionsIndexPublisher.ts
  commandTranslator.ts

packages/ui/src/project-sidebar/
  ProjectSidebar.tsx
  ProjectNode.tsx
  WorktreeWorkspaceNode.tsx
  AgentSessionRow.tsx
  WorkspaceCreationDialog.tsx
  DiscoveredWorktreesDialog.tsx
  sidebarViewStore.ts

packages/ui/src/agent-host/
  HarnessIcon.tsx
  SessionStatusIcon.tsx
  HarnessSelector.tsx
  ModelBindingSelector.tsx
  CompatibilityStatus.tsx
  SessionCapabilities.ts
```

模型执行器复用现有实现，但不能从 UI 或桌面层跨目录深导入 CLI bootstrap。P0 查清 workspace/build 依赖后，通过稳定 Node 导出或一个最小叶子包开放模型执行能力；把依赖装配留在宿主，避免模型包反向依赖 Harness 或 UI。

依赖方向：shared contracts ← model/execution/harness services ← UI facade。共享事件层不能 import 任意具体 Harness；Model Provider 层不能 import 具体 Agent。

## 9. 可靠性、安全和语义不变量

### 9.1 命令、事件与故障恢复

UI 重连只恢复订阅与查询命令结果，不能自动重新发送已可能执行的 prompt。每次用户动作使用稳定 commandId；accepted 表示已接收，不代表任务完成。宿主先持久化命令接收，再派发并记录后端确认。

对“命令已经发给后端，但宿主还没记下确认就崩溃”的窗口，若后端支持幂等查询则对账；不支持则标记 execution-unknown，要求明确恢复决定。不能承诺任意第三方 Agent 的端到端 exactly-once，也不能盲目重试可能修改文件的操作。

事件序号按 session/epoch 单调递增。重复事件去重，缺口请求重同步。晚到的 stop 必须绑定 expected execution，不能停止下一轮；晚到审批必须绑定原 interaction 和 runtime epoch，不能放行另一个工具。

### 9.2 工具与工作区

Harness 负责它的工具执行；宿主监听工具事件不再重复执行。MCP 或客户端提供工具的执行也必须经过同一命令与权限路径。只在有真实控制点或沙箱时声明可强制审批；否则 UI 显示能力限制。

同一 worktree 中多个 Agent 共享实际文件与 Git 状态。“在此工作区新增 Agent”默认复用当前 worktree，不能偷偷派生新分支；另提供明确的“创建隔离工作区并启动 Agent”。在共享目录中启用并发写入时说明风险，独立上下文不构成文件隔离。宿主可提示潜在重叠写入，但不能宣称能约束绕过其工具层的全部外部进程。

运行中、待审批、仍有工具执行或状态未知的工作区默认禁止删除；显式停止并核对准入状态后再移除。Git diff 是工作区观察，不能在多人同时写入时自动归因为某一个工具调用。详见第 13.6 节。

### 9.3 模型与认证

不静默降级为另一个模型，不自动把未知 model route 指向默认 Provider。记录 requested 和 effective 绑定，发现不一致立即阻止或明确提示。

API Key、refresh token、Authorization 头不进入 UI 事件、普通日志或导出诊断。隔离临时配置并在会话结束/令牌过期时清理；持久化恢复记录只保留凭据引用。运行中令牌刷新应由独立宿主完成，不能依赖 renderer。

### 9.4 UI

后台会话产生事件不得抢前台焦点。文本输入、分屏 resize、会话切换不能创建或销毁执行中的 Agent。长历史分页/虚拟化，流式更新批处理；客户端不在线时宿主仍消费和保存输出。

工具卡、审批与文件修改的权威状态来自宿主/后端；UI optimistic 状态不能伪造成功。高级 ZCode 原生能力可继续保留，外部 Agent 没有同等能力时不展示可执行入口。

## 10. 测试与发布门槛

### 10.1 三类测试

**契约与确定性测试：**Mock Harness、Fake Model、录制的协议 fixture；验证事件映射、序列化、取消、权限、断档、重复与错误。普通 CI 默认执行，不依赖外部账号。

**真实集成测试：**固定 Agent/adapter 版本、两个不同 Provider 的模型；任务至少包含两轮对话和工具循环，不能只测试回答一句 hello。记录实际路由与运行参数。

**故障与用户体验测试：**GUI 退出、SSH 断开、进程退出、日志截断、审批断线、模型错误、配置变化、多会话 focus、worktree 删除竞态、旧数据升级与回滚。

### 10.2 首个版本的明确验收

| 检查           | 合格标准                                                                   |
| -------------- | -------------------------------------------------------------------------- |
| 选择真实性     | 实际模型调用经过选定 Provider/Model；不只改变 UI 标签                      |
| 组合覆盖       | ZCode/Pi × 两个 Provider 模型 × 本地/SSH，八个已认证组合                   |
| 工具循环       | 读文件、修改、测试执行、下一轮追问完整成功                                 |
| 关闭 GUI       | 远端当前任务继续，后续模型调用也不依赖 GUI                                 |
| 重连           | 不重复 prompt、工具副作用或审批；历史与状态收敛                            |
| 权限           | 拒绝时工具未执行；重复/过期审批无副作用                                    |
| 隔离           | 同路径不同主机、同 worktree 多会话、同 native ID 不串状态                  |
| 配置           | 不改用户的全局 Agent 配置或凭据                                            |
| 回滚           | 开关关闭能恢复原生入口；新旧存储不会互相损坏                               |
| UI 体验        | 后台输出不抢焦点；会话切换不重启任务                                       |
| 层级           | Project → Worktree Workspace → 多 Agent；空工作区与主检出都有稳定节点      |
| 同工作区多会话 | 同 Harness 可开两个以上；创建会话不增加 worktree，不串模型/上下文/停止命令 |
| 图标           | 按实际 harnessId；模型换品牌不改 Agent 图标；未知/失效资源有安全 fallback  |
| 管理语义       | 新建/接管/隐藏/归档/删除互相区分；发现不会启动 Agent 或自动清理 Git        |
| 远端归属       | 工作区绑定稳定目标；离线不删树、不显示虚假完成，重连身份不变化             |

建议压力验收目标：至少 50 个发现的 worktree、跨至少 5 个展开工作区的 10 个会话并发、至少 8 小时运行、重复断线/重连、总计至少十万条合成事件。这些是拟定测试负载，不是现有性能结论。记录输入延迟、会话切换 p95、事件积压、内存和子进程数；与 P0 固定硬件/负载基线对比，交互 p95 的初始回归预算可设为不超过 10%，最终阈值由实测基线确认。以静置后的内存趋势和已退出子进程回收判断泄漏，不声称进程 RSS 必须完全回到启动值。

Gateway 的纯适配耗时要单独记录，不能用模型本身的响应波动掩盖；用本地 Fake Provider 测性能，用真实 Provider 测兼容性。

### 10.3 发布策略

原生路径保留独立功能开关；外部 Agent 按 Harness、模型路由和版本控制新会话准入。功能开关只改变新建策略，不重新接管运行中会话。

数据 schema 采用版本化、只增字段/独立 sidecar 的渐进迁移；备份与只读检查先行。新程序的外部数据不要直接交给旧程序解析；旧程序若遇未来 schema 应拒绝写入。

UI/Host/adapter/CLI 版本握手；不匹配时保持诊断和历史读取，不静默重建正在运行的会话。CLI 升级先跑协议 fixture 和认证矩阵，再更新固定版本。

## 11. 第一个实施任务

第一个任务只做 P0 和最小 P1，不接真实第三方 Agent、不改模型路由、不重写 ZCode runtime。

交付：基线报告、现有链路/状态所有权图、CodexHost 源码参考与许可清单、Project/Workspace/Session 与两类 Adapter 的纯类型和 schema、MockHarness、兼容性/归属检查单元测试、三层侧栏 fixture、后续文件变更清单。参考来源具体到文件和 commit，复制代码前先完成归属记录；不要让 coding agent 把整个 codex-host 目录无差别拷进来。

先固定工作区主导的会话归属，再实施真实 Agent。不能先把 hostSessionId→workspace 的归属写成多个互不一致的临时字段，最后再补一棵展示树。

优先证明边界能成立，再证明 Pi 的完整端到端链路；在此之前不并行接入七个 Agent。

最终演进顺序：

```text
原生行为不回归
→ 三层实体、worktree 工作区、Orca 式侧栏与图标
→ ZCode + Pi 共用模型层与 UI、同工作区多会话
→ 本地/SSH 会话可靠持久化
→ Gateway 接入 Codex / Claude Code
→ ACP 低成本扩展长尾
```

## 12. CodexHost 源码参考与移植边界（v0.2 新增）

### 12.1 结论与对照

最有价值的不是它的 Codex Desktop 注入入口，而是中间的 Harness 插件契约、原生协议适配、稳定身份、公共输出与展示投影。我们的对应关系是：

```text
CodexHost：原生 Harness → HarnessSession → HostEvent/HostItem → Codex UI projector
本项目：  原生 Harness → HarnessSession → 标准事件/日志 → ZCode V4 projector

本项目额外要求：
原生 Harness → ModelBindingAdapter（SDK/RPC/Gateway）→ 现有 ZCode Model Runtime
```

CodexHost 的 `HarnessModelRef` 是 adapter 拥有的 opaque 标识；Pi 具体把 provider 和 model ID 编码成 native ref，并提供原生模型目录。[C5][C6] 这对保存/选择原生模型很有价值，但不是一个可注入任意 Harness 的统一 `ModelExecutor`。只复用这部分会得到“多 Harness 各用自己的模型配置”，并不会自动实现本项目的目标。

### 12.2 代码导航：读什么、拿什么、不拿什么

| 参考入口                                                   | 已查看的内容                                                     | 用途                                   | 移植限制                                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/harness-adapter/src/text-session.ts` [C1]        | Adapter/Session、控制命令、HostItem/HostEvent、交互和快照契约    | P1 契约、P3 adapter 骨架               | 不直接继承所有 Codex 产品假设；本项目补 sequence/epoch、detach 和模型绑定            |
| `packages/harness-adapter/src/plugin.ts` [C2]              | manifest 入口返回工厂、Context 不含 Host/Renderer 内部           | 插件构造与依赖隔离                     | 环境快照不是安全过滤；不得注入不必要的真实密钥                                       |
| `.agents/skills/codexhost-add-harness/SKILL.md` [C3]       | 接入过程、职责、原生优先、后端/发行/Desktop 分开验收             | 编写本项目 add-harness 开发流程        | 它是被审阅的项目文档，不是对本项目自动生效的指令；文中的“七个”等说明不可替代当前源码 |
| `packages/adapters/pi/src/pi-adapter.ts` [C4]              | PiTurnTransport、依赖注入、公共/原生类型分离、活动轮次状态       | Pi adapter/transport 分离              | 不照抄整个文件；模型注入另做                                                         |
| `packages/adapters/pi/src/pi-rpc-session.ts` [C4b]         | Pi 状态、工具/文本/交互事件、RPC 参数和错误类型                  | 固定原生边界、timeout/cleanup 调研入口 | 本次没有执行 Pi RPC，不能据源码声明断线存活或完整版本兼容                            |
| `packages/shared-contracts/src/harness-models.ts` [C5]     | opaque ref、有效配置、权限 live/atCreate、history/subagents 能力 | 状态与能力设计                         | capability 不等于品牌名单；我们要补 resume、历史只读与统一模型路由能力               |
| `packages/adapters/pi/src/pi-model-catalog.ts` [C6]        | ref 编解码、目录校验、实际模型与 thinking 校验                   | 原生模型身份适配                       | 不取代 ZCode Provider Registry/模型执行器                                            |
| `packages/protocol-core/src/codex-ui-projector.ts` [C7]    | 公共 Item/Turn 到 Codex 展示的映射；工具展示兼容处理             | ZCodeV4Projector 设计                  | 不保留 Codex wire 格式；不为了展示把读取工具伪装成命令执行                           |
| `packages/adapters/claude-code/src/sdk-transport.ts` [C9]  | SDK query、流式输入、交互 ID、Abort/timeout、状态结构            | Claude 控制/事件接入                   | 这不是统一 Model Gateway；SDK 与认证语义单独验证                                     |
| `packages/adapters/claude-code/src/plugin.ts` [C9b]        | darwin 受管远端选择 Broker、其他场景直接 adapter                 | 研究执行策略封装                       | 不是所有平台/Agent 的通用持久化证明                                                  |
| `packages/harness-adapter/test/text-session.test.ts` [C11] | fake lifecycle、流式最终态、usage replacement、拒绝/并发测试     | P1 确定性测试                          | Fake 测试存在或通过都不能代替原生、模型、SSH 实测                                    |

其他只作为继续阅读导航的目录：`packages/mapping-store/`、`packages/harness-broker/`、`packages/host-runtime/`。此处不宣称已全面审计这些目录；实施时先读其实际源码/测试，确认状态所有权、进程归属与脱离前端后的行为，再决定复用。

### 12.3 直接借鉴的五个设计

**工厂而非全局注册副作用。** Manifest 决定身份/入口，工厂接收有界 Context，返回 adapter；每个 execution target 独立探测可用性。插件身份与目录去重、API 版本及显式启用在 Host 验证。能力只以运行时 inspect/session 报告为准，不复制到另一份静态名单。[C2][C8]

**原生协议留在 adapter 内。** Pi RPC、Claude SDK、原生服务、ACP 都可以存在，但 Host 不 import 这些协议类型。适配器负责把真实能力转换成公共契约；公共契约不够时扩展公共语义，不添加按 Harness 名称区分的隐藏后门。[C3][C4][C9]

**Turn/Item 而非零散文本回调。** start/update/complete 具有稳定 item identity；完整 snapshot 用于终态与历史核对，而不是追加一次重复文本。拒绝接收的轮次不发 started/completed；并发轮次被拒绝时不改变活动轮次。CodexHost 已有这些行为的 Fake 测试可参考。[C1][C11]

**原生身份是 opaque reference，不是 UI ID。** 保留 adapter 返回的真实 native session locator，Host 使用自己的 session/turn ID。history 重复读取必须保持稳定；fork/rollback 是对话状态操作，不等于 Git/worktree 回滚。[C10] 本项目再加 execution target 和 workspace identity 隔离。

**支持能力包含作用域与证据。** 例如 selectPermissionMode 是否只能创建时设置、fork 是否可跨 cwd、子 Agent 是否可观察/读 transcript，不能压成一组没有上下文的布尔值。[C5] 本项目还有 supported/unsupported/unknown/experimental 的认证状态和实际模型生效记录。

### 12.4 明确不复制的四部分

**不复制 Codex Desktop 私有 UI 接线。** 当前 CodexHost 文档明确承认 Picker、配置、恢复等仍有静态/专用接线；插件加载成功不会自动完整出现在 Desktop。[C3][C8] 我们拥有 ZCode 源码，应该正式改 facade/selector/projector，而不是再加外部注入和 DOM/私有 API 补丁。

**不复制为 Codex UI 进行的语义伪装。** `codex-ui-projector.ts` 有把某些通用工具提升到 command-execution 展示通道的处理，以获得特定 UI 卡片效果。[C7] ZCode 应按真实语义显示工具；带坐标的完整 diff、无坐标片段、实际文件系统观察要区分，不能把 preview 当已发生的修改。

**不把 Broker 或 close() 等同持久化。** Claude 插件中存在特定平台的 Broker 选择，[C9b] 而插件运行时文档也描述 Host 输入 EOF 时收集快照并关闭资源等流程。[C8] 我们的 detach、cancelTurn、terminateSession、GUI 退出/SSH 断线行为依然必须独立设计、实际故障测试，不能因为参考项目有 Remote 就免验。

**不把某份 adapter 模型配置扩展当统一模型服务。** 仍由 ModelBindingPlanner/Gateway 控制实际路由。原生 model.select 返回成功与模型实际执行吻合须分别核验；辅助模型/压缩请求也要覆盖。不为了“自由组合”复用不适用的认证或修改用户全局配置。

### 12.5 PR #337：与 ZCode 直接相关，但方向相反且已归档

本次读取到 CodexHost PR #337（`draft/zcode-integration`，head `b66013bbcc6a8d5292f671957528680b13be57f8`）是 Draft、未合并，说明明确要求归档保留、不可合并。[C13]

它尝试的是“把 ZCode 作为 Agent 接进 CodexHost”，不是“把 CodexHost 的后端接进开源 ZCode”。PR 保存了旧 stdio/Desktop 接入，并记录手动配对、单工作区、换目录改配置/重启、真实账号/CAPTCHA 和部分生命周期尚未验收等限制。保存前验证针对 ZCode 3.12.3，不能等同本计划固定的 3.14.3 开源基线。

用途是参考已发现的失败场景和原生协议调研，不能将它当即插即用的成熟实现，也不将其反向作为必须引入 ZCode 桌面认证/配对代理的理由。我们的原生 ZCode 路径继续直接使用自己的开源 runtime。

### 12.6 源码使用与许可门槛

CodexHost 该快照根 `package.json` 明确声明 `LGPL-3.0-only`，根 LICENSE 是 LGPL v3；不是 MIT/Apache。[C12][C14] 参考接口与架构、直接依赖、复制并修改源码是不同的使用方式，需要分别记录。

在代码复用前建立 `third-party-source-map.md`：上游 commit、原文件、目标文件、是参考还是复制/修改、该文件适用许可、保留声明、分发方式和待确认义务。优先先按清晰契约写本项目实现；确需复用实现时单独模块化、保留来源与适用声明，再核对分发、对应源代码和替换/重新组合等要求。不要把复制的 LGPL 源文件直接改标 Apache-2.0；也不要假设放到独立进程便自动免除许可要求。分发前对具体整合方式做许可审查，本文不是完整法律结论。

### 12.7 新增验收用例

| 场景                                       | 预期                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| 安装一个未在 UI 源码列过的受信插件         | Host 目录发现并返回描述，UI 据目录生成入口，无新的硬编码品牌分支           |
| 插件发现但未授权启用                       | 不执行工厂、不启动 CLI；项目内文件不能偷偷启用插件                         |
| Turn 拒绝接收/并发冲突                     | 不产生虚假 started/completed，不影响当前活动轮次                           |
| 流式 item.completed 携完整快照             | 对齐/upsert，不将同一正文再次 append                                       |
| 批准/问题等待后取消                        | 原始 interaction 明确关闭，迟到答复不能继续工具                            |
| usage 返回完整快照                         | 按 replacement 语义处理，不重复累加；Gateway/Agent 两路统计标明来源        |
| Session readSnapshot()                     | 只读且 identity 稳定，不触发 prompt，不重放到实时事件输出                  |
| Pi 原生模型模式与 host-managed 模式切换    | 原生模式只算适配验证；host-managed 必须以真实调用轨迹证明经过 ZCode 模型层 |
| ZCode V4 投影缺失序号或 runtime 换代       | 保持权威状态不被错误 merge，恢复订阅，不重发已可能执行的命令               |
| GUI 关闭而 Remote Agent 仍需下一次模型调用 | Agent、输出消费、Gateway 与认证链独立可用，不只证明进程 PID 还在           |

最终评判标准仍是 P4 的闭环和 P5/P6 的兼容矩阵，不是源码拷贝数、插件数量、构建成功或单条聊天成功。

## 13. Orca 式项目层级与多会话侧栏（v0.3 新增）

本节是产品与实现规格；除明确引用的源码和 Git 行为外，以下均为计划中的设计，不是 ZCode 已实现能力。界面参考用户提供的 Orca 截图，不推断截图中每个颜色或图标的原始内部语义。

### 13.1 三层可见实体与关键行为

```text
项目图标  Project 名称                         [+ 工作区] [更多]
  状态  Workspace 名称 [主要/主检出]
        [Local Mac / server1]  branch-name
        3 agents                              [+ Agent] [折叠]
        状态  Pi 图标      调研适配接口        3m
        状态  Pi 图标      实现会话管理        1m
        状态  Codex 图标   审阅当前变更        9m
  状态  第二个 Workspace 名称
        [server1]  feature/another
        0 agents                              [+ Agent]
  已隐藏 N 个发现的工作区                      [管理]
```

**Project** 是逻辑仓库项目，不是当前打开的文件夹列表或 Agent 品牌分组。可改名、设图标、固定和排序；不会因关闭窗口或最后一个会话消失。

**Workspace** 是一个长期存在的实际 Git worktree。主检出也作为 workspace；“主要”徽标对应明确的主检出/默认工作区语义，不从 branch 字符串是否等于 main 猜测。Git 支持 main worktree 与 linked worktree，且可以 detached HEAD；bare repository 没有可直接执行 Agent 的主工作目录。[H5] 主检出标记与“项目默认进入的工作区”应分成两个字段，UI 文案不要混淆。

**Agent Session** 是可继续对话的会话，不是一个 OS 进程，也不是单轮任务。会话的当前轮次完成后仍可继续下一轮；同一个 Harness 可以有多个独立会话。选用什么模型不改变该会话所属 Harness 的身份图标。

终端是工作区的辅助视图，不强制置于每个 Agent 下，也不计入 N agents。后台子 Agent 默认挂在父会话的详情/子树中；若显式映射成独立可写宿主会话，可另行纳入计数，但不能同一项重复计数。

### 13.2 拟新增的数据模型与身份边界

以下为领域草案；实施时给字段配套 schema、持久化版本与校验，不直接当作现有 API 使用。

```ts
interface Project {
  id: string;
  name: string;
  iconAssetId?: string;
  defaultWorkspaceId?: string;
}

interface RepositoryBinding {
  id: string;
  projectId: string;
  executionTargetId: string;
  // Git 自身解析后的信息；路径用于定位，不独自充当永久 ID。
  gitCommonDir: string;
}

interface WorktreeWorkspace {
  id: string;
  projectId: string;
  repositoryBindingId: string;
  title: string;
  worktreePath: string;
  worktreeGeneration: string;
  isMainWorktree: boolean;
  head: { kind: "branch"; ref: string; oid: string | null } | { kind: "detached"; oid: string };
  origin: "created" | "adopted";
  lifecycle: "active" | "archived" | "missing" | "removed";
}

interface AgentSessionRecord {
  id: string;
  workspaceId: string;
  harnessId: string;
  title: string;
  // modelBinding、backendRef、状态和时间沿用前述会话模型。
}
```

`RepositoryBinding` 是内部仓库实例绑定，不新增一层可见树。首期一次导入默认创建一个 Project 和一个 binding；同 target 下、同一 git common directory 的 worktree 归属同一 binding。不同 SSH 主机上的同一路径不合并；多个独立 clone 即使 origin URL 相同也不自动合并。后续如需让同一逻辑项目承载多个机器上的仓库实例，可显式增加 binding，不改变三层 UI。

项目名、工作区显示名、branch 名、绝对路径、临时 SSH connection/session ID 都不能作为宿主永久身份。稳定 target ID 由连接管理维护；worktreeId/代际由宿主记录。Git 的 main/linked 检出信息、worktree 路径和公共目录通过 Git 命令读取，不能假设 `.git` 一定是目录。[H5][H6]

工作区移动或 branch 改名只更新位置/展示事实；只有能核实是同一实例时才保留绑定。目录删除又重建时不能仅因路径相同就复用旧会话身份。对宿主观察之外发生、无法可靠区分的重建标为 `needsVerification`，要求校验或重新接管，不承诺能自动识别所有外部文件系统变化。

**归属规则：** Session.workspaceId → Workspace.repositoryBindingId → executionTargetId。SessionSpec.execution 是服务端派生的校验快照，不能被客户端改成另一个主机。新会话默认 cwd=worktree 根；允许显式选择该 worktree 内的子目录，必须验证规范化路径、符号链接策略和目标身份。恢复旧子目录会话时不能擅自把 cwd 改成根。

### 13.3 导入、发现、新建与接管工作区

**添加项目：**选择目标主机和仓库目录 → 在该目标上探测 Git/根目录/公共目录 → 只读枚举 worktree → 展示主检出和已有 linked worktree → 用户接管所需条目。输入本来就是 linked worktree 时，也应识别所属 common directory，不为每个路径建重复项目。

**发现接口：**优先使用目标 Git 支持的 `git worktree list --porcelain -z`；启动时检测版本，缺少该能力时使用已测试的解析分支或明确要求升级，不能随意按空白拆输出。列表、状态和路径验证都在实际执行目标上完成。[H5]

发现本身不移动文件、不创建/删除分支、不 prune、不执行仓库 hook、不启动 Agent。候选状态与用户接管记录分开：发现不等于采用；不采用的数量可以展示为“未添加/已隐藏 N 个发现的工作区”。采用后的用户命名、排序和固定状态不能每次扫描丢失。

**新建工作区：**用户选目标 repository binding、基准 ref、分支（新建或已存在）、目标目录和显示名 → 校验 → 执行 Git 操作 → 成功后登记 workspace → 可选地创建首个 Agent。第一版不自动 clone 到其他机器；目标没有仓库时明确提示先导入仓库。

执行应通过有参数边界的远端 helper 或安全 argv 协议，不把用户给的 branch/path 拼进未经转义的 shell。校验 branch、目标目录占用、同 branch 已检出、仓库锁、权限和可用空间；默认不使用强制覆盖已有分支的选项。Git 创建成功但 Catalog 写入失败，要提供可恢复的未登记候选，不假装整体成功或删除用户已有内容。

**主检出：**不额外执行一次 worktree add 来伪造“main”。没有用户会话的主检出仍显示；分支可以是 main、master 或其他名称。bare repository 先展示“需创建工作区”，不能指向 bare Git 目录运行普通 Agent。

**非 Git 旧数据：**不能为了凑层级偷偷 git init。可在兼容区保留 folder workspace 并明确标记“普通文件夹，无 worktree 隔离”；或只读保留旧会话并提示迁移。它是兼容例外，不算已实现 worktree 工作区。既有非项目用途（如临时/系统工作区）也不自动合并成普通 Git Project。

### 13.4 创建多个 Agent：共享文件，独立会话

在工作区点“+ Agent”，只选择 Harness、模型和可用权限配置。执行位置与工作目录由工作区继承并显示为不可误改的上下文。确认后仅创建新会话，不创建 worktree，不切 branch，不改变已有会话的模型。

同一工作区下允许：Pi + Pi + ZCode；后续允许 Pi + Codex + Claude Code。每个会话的原生身份、上下文、模型绑定、审批、用量和停止命令都独立。adapter 可以复用底层服务进程，但必须证明多路会话隔离；不能因为关闭一个 session 就无引用计数地杀掉其他 session 共用的进程。

项目/工作区可以有默认 Harness/Model，但它们只是新会话的默认值，不能在修改默认值后批量改掉现有会话。恢复以各会话已确认配置为准。

多个会话共享同一个 worktree，因此共享实际文件、Git index、未提交变更、依赖环境及通常的构建输出。它不是文件/进程/端口的完整沙箱。另提供独立动作“创建隔离工作区并启动 Agent”；不把这个动作偷换成普通“新增 Agent”。

同 worktree 多写 Agent 的提醒不能变成“同工作区只能一个 Agent”。需要允许用户选择并发工作；只读权限必须后端可强制时才宣称强制。Git diff 默认称为“工作区变更”，只有原生工具具有可靠归因时才标记“本会话变更”，不把所有共享修改归给当前选中的会话。

### 13.5 图标、状态和侧栏渲染

**每个会话行由四部分组成：**状态标识 + Harness 品牌图标 + 会话标题 + 更新时间。模型详情放 tooltip/secondary label，品牌图标不随模型选择变化。通用小组件 `HarnessIcon` 同时用于侧栏、Agent Picker、Chat Header 和可见子 Agent，避免四套品牌名单。

现有 ZCode `renderProviderCliIcon()` 在固定基线只返回 GLM 图标，[H3] 应把它留作原生兼容包装，新的会话 UI 使用 `harnessId` 查 Host 目录。CodexHost Pi manifest 已声明 `icon`，可借鉴此元数据机制，[H4] 但本项目新增的浅/深色资源、fallback 字段属于拟扩展，不是上游现有能力保证。

拟设计资源形态：Host 校验后返回 `iconAssetId`，Renderer 通过允许的资源入口读取；可提供 light/dark 两个资产 ID。显示端不用凭空扫描路径，不从会话文本识别品牌，不从互联网上逐行请求 logo。SVG 如被允许，应按静态不执行的图像资源加载并校验，拒绝脚本、事件属性、外部引用和路径逃逸；不使用任意 innerHTML 或运行插件 UI 代码。缺失/未安装/未知 Harness 显示明确名称和通用或首字母图标，不能退回 GLM/Codex 假装正常。资产来源与再分发权限纳入来源清单。

**状态单独建模。**至少区分执行活动（idle/starting/running/waiting/cancelling）、连接新鲜度（live/stale/offline/unknown）、最近轮次结果和 unread。轮次 succeeded 表示最近一轮结束，不等于 session 被销毁。断开连接不改写成任务已成功或已停止。

汇总拟采用“待审批/问题 → 未确认错误 → 运行中 → 未读完成 → 空闲”的主提示顺序，同时保留各状态计数；连接过期作为独立标记。一个 Agent 等审批、另外两个在运行时，工作区应同时显示待处理与运行数量，不能因单个优先图标掩盖其他状态。

`N agents` 缺省统计该工作区未归档的顶层宿主会话，包含当前闲置但可继续的会话；不统计终端和自动内部子 Agent。搜索过滤时显示“匹配 n / 总 N”。计数与聚合不能因侧栏折叠、分页或隐藏行而少算；明确区分“已发现但未接管的工作区”和“已接管但隐藏的工作区”。后者若有待处理交互，项目摘要及 attention 入口仍可访问。

**focus 规则：**ProjectId/WorkspaceId/SessionId 是稳定 React key；不要用数组下标、标题、branch 或 lastUpdatedAt。用户显式点行/创建前台会话可以改变 active selection；后台输出、状态变化、自动发现、重连和列表补齐不能改变键盘焦点。异步恢复不能覆盖恢复期间用户已经作出的新选择。

展开/折叠、手动排序、固定、上次选中会话、每会话草稿和滚动位置保存在 view store。排序默认稳定，不按 token 流持续重排；相对时间显示不改变身份。只挂载当前需要的正文视图；摘要由轻量 sessions-index 提供，不能为了显示 N agents 读全量历史、inspect 所有 CLI 或启动隐藏 Agent。收起、关闭视图可退订正文流，但 Host 仍独立消费运行输出。

### 13.6 生命周期、安全和删除语义

| 用户动作                | 改什么                                    | 不应隐式做什么                              |
| ----------------------- | ----------------------------------------- | ------------------------------------------- |
| 折叠项目/工作区         | UI view state                             | 不停任务、不删会话                          |
| 隐藏工作区              | 展示偏好；摘要可保留待处理计数            | 不删目录、不关 Agent                        |
| 归档会话/工作区         | Catalog 展示/准入元数据                   | 不以归档代替 cancel；活动条目应明确提示状态 |
| 关闭 Chat/Terminal 视图 | detach 该视图                             | 不自动 terminate Session                    |
| 停止 Agent              | 取消指定轮次或显式终止指定会话            | 不误杀同 workspace 的其他会话               |
| 移除 linked worktree    | 经过预检与确认的 Git 操作                 | 不顺便删 branch、历史或主仓库               |
| 从应用移除项目          | 移除/归档项目入口，按明确策略保留历史引用 | 不 rm 仓库、不默认强杀不在授权范围内的进程  |

Worktree 删除按“检查 → 冻结新会话准入 → 明确停止必要执行 → 重检 → Git remove → 更新目录与历史位置状态”处理。审批等待、运行中工具、连接离线或进程归属未知时不能默认安全。必须显示修改/未跟踪文件、submodule、锁状态等风险；保留主检出，不通过普通 linked-worktree 删除菜单处理。git lock 不等于我们的运行互斥锁。[H5]

宿主无法完整掌握用户从其他终端启动的所有写进程，因此不能宣称检查通过就绝对无并发写入；删除 UI 明确风险并要求用户确认。拒绝删除时不能先悄悄关掉全部会话。删除成功后展示历史保留为“工作区已移除”，只读可用；不可把恢复请求导向恰好在同路径新建的目录。

网络断开只使远端状态过期。扫描失败、超时、权限错误不能当作“仓库工作区列表为空”，不能由此批量归档/删除 Catalog。重连先验证 authority、仓库实例与 worktree 代际，再同步摘要；不自动发 prompt。

### 13.7 旧数据迁移与既有文件接缝

当前基线 `tabStore.ts` 是窗口自己的 tabs/view state，含 workspacePath、workspaceIdentity 与临时远端连接信息。[H1] 新 Project Catalog 必须独立于它；tab 可以引用 workspaceId，不能继续由“哪些 tabs 当前开着”定义哪些项目或 worktree 存在。

迁移只做元数据和归属映射，不改 Git、文件、历史正文和 native session ID：

1. 备份旧数据，在独立 profile 上 dry-run；按存储索引收集会话和 workspace，不只遍历当前开着的 tabs。
2. 在实际 execution target 上解析旧 cwd 的 worktree 根、common directory。Git submodule/嵌套仓库应按自己的仓库身份处理，不能仅按字符串前缀并入外层项目。[H6]
3. 同目标、同仓库实例的 worktree 归同 Project/Binding；每个实际 worktree 一个 Workspace；同 workspace 的多个旧会话全部保留。
4. 保留原工作目录相对位置、模型绑定与原生会话 ID，只添加 projectId/workspaceId 关联。不要在迁移中发 prompt 或重建原生 session。
5. 远端离线、缺路径、未知 Harness、同路径重建等进入待核实区；可读旧历史，不自动回退到本机或默认 Agent。
6. 迁移事务可重复执行，记录旧身份→新身份映射与 schemaVersion；失败可回滚，新数据不交给旧程序写入。

具体接缝：

| 既有入口                                                 | 改造方式                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/ui/src/store/tabStore.ts` [H1]                 | 保留窗口选择能力；加到实体 ID 的适配，Catalog 不以 tabs 为数据库             |
| `packages/shared/src/git.ts` [H2]                        | 复用已有 Git 分类与错误语义，新增工作区管理契约，不误将 branch 等同 worktree |
| `packages/ui/src/lib/providerCliIcon.tsx` [H3]           | 保留原生调用兼容，新会话 UI 迁到目录驱动 HarnessIcon                         |
| `packages/ui/src/v4/transport.ts` [S8]                   | 正文仍复用已有传输；workspace 路由由新身份解析，轻量侧栏走摘要索引           |
| `packages/ui/src/v4/conversationProjectionStore.ts` [S9] | 保留正文连续帧规则；侧栏不直接消费或复制全量 transcript                      |
| CodexHost Pi `manifest.json` [H4]                        | 参考图标元数据；资源加载受校验，不引入第二份静态品牌注册表                   |

此处是经过定位的接入点，不宣称已经枚举全部调用者。P0 仍需追踪会话索引、持久化和多窗口消费者，再提交完整的变更清单。

### 13.8 测试、交付和产品验收

| 测试场景                                     | 合格行为                                                   |
| -------------------------------------------- | ---------------------------------------------------------- |
| 一个 Project 有主检出和两个 linked worktree  | 三个 Workspace 正确归属，branch 名不作为 ID                |
| 同 Workspace 新建三个会话，其中两个 Pi       | 三个独立会话；worktree 数和 branch 不变                    |
| Pi 使用不同厂商模型                          | 仍为 Pi 图标；模型信息单独展示                             |
| Host 新增受信 Harness manifest               | Picker/侧栏/Header 使用同一名称/图标，无需新增品牌条件分支 |
| 图标缺失或恶意资源引用                       | 安全 fallback，不请求任意 URL 或执行资源代码               |
| 关闭最后一个会话视图后重新打开               | 工作区仍在，原会话可恢复或明确报告受限；不新建替身会话     |
| 后台 Agent 更新、发现新 worktree、SSH 重连   | 当前输入焦点、草稿、选中会话不变                           |
| workspace 折叠/隐藏时出现审批                | 项目摘要仍显示待处理，存在可点击入口                       |
| SSH 断开时重新扫描失败                       | 树保留且 freshness 过期，不批量判 missing 或 completed     |
| 同路径在两台主机、或两份不同 clone           | 不串归属、不按 origin URL 自动合并                         |
| 外部 branch 改名 / worktree 被移走或删除重建 | 同实例核实后更新；不确定时标待核实，不错绑历史             |
| 工作区删除与新 Agent 并发创建                | 准入互斥；失败不先破坏会话或用户目录                       |
| 旧 cwd 在 worktree 子目录                    | 归到正确工作区并保留 cwd，不静默换执行位置                 |
| 同 worktree 两会话写文件                     | 明确共享语义；Git diff 不伪归因；取消一个不影响另一个      |
| 至少 50 worktree 候选、10 活动会话           | 摘要查询不读取全部历史、不隐式启动 CLI；无持续列表跳动     |

**首个可用版本的新增交付包：**三级数据模型、WorktreeService、迁移脚本与报告、Orca 式侧栏、双图标组件、轻量聚合索引、三层 fixture、并发/focus/离线安全测试。真实 Codex/Claude 会话仍按 P5 交付；不要为了演示三个 logo 放出不能运行的启动选项。

**最终体验：先选项目，再选 worktree 工作区，在其中启动和切换多个 Agent；工作区决定在哪里执行，会话决定用哪个 Harness 和模型。**

## 附录 A：基线运行入口

以下命令取自核对过的基线 README；尚未在本次审阅中执行。[S1]

```bash
# 仓库根目录；先按该 commit 的 mise.toml 配置工具链。
pnpm bootstrap

# 独立开发数据目录，避免覆盖日常会话。
ZCODE_DATA_BASE_DIR="$HOME/.zcode-multi-harness-dev" pnpm dev:desktop:test

# SSH 验证前准备远程资源。
pnpm bootstrap:with-remote

# 修改 CLI/模型执行代码后，构建相关依赖。
pnpm --filter @zcode/cli... build
```

测试命令按对应 package.json 中实际存在的脚本整理，不能假设 `pnpm test` 已覆盖整个仓库。留意 dev/packaged/remote 是否实际运行刚构建的产物，并记录运行二进制与 bundle 的版本指纹。

## 附录 B：证据与参考

源码链接均固定到此次审阅的 commit。外部协议文档为 2026-09-24 查阅版本；实施阶段仍需固定 SDK/CLI 版本并重新确认。

- [S1] [ZCode README](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/README.md)
- [S2] [Agent provider 枚举](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/packages/shared/src/providers.ts)
- [S3] [ZCode Agent policy](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/packages/shared/src/zcode-agent-policy.ts)
- [S4] [第三方 Agent 退役测试](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/packages/ui/test/nonCliAcpRetirement.test.ts)
- [S5] [模型 Registry runtime](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/apps/zcode-cli/packages/bootstrap/src/app/provider-registry-model-runtime.ts)
- [S6] [统一 Model 执行](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/apps/zcode-cli/packages/adapters/src/model/model.ts)
- [S7] [V4 命令契约](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/packages/shared/src/zcode-protocol-v4/command.ts)
- [S8] [UI ConversationTransport](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/packages/ui/src/v4/transport.ts)
- [S9] [UI projection store](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/packages/ui/src/v4/conversationProjectionStore.ts)
- [S10] [Node 服务装配](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/packages/services/src/node.ts)
- [S11] [原生进程管理](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/packages/services/src/zcode-agent/zcodeAgentProcessManager.ts)
- [S12] [Remote backend](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/packages/server/src/remote/backend.ts)
- [S13] [ACP Overview](https://agentclientprotocol.com/protocol/v1/overview)；[Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [S14] [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [S15] [Pi Custom Providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md)
- [S16] [Codex App Server](https://developers.openai.com/codex/app-server)
- [S17] [Codex Advanced Configuration](https://developers.openai.com/codex/config-file/config-advanced)
- [S18] [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol)

## 附录 C：CodexHost 固定版本参考

以下为本次实际读取的源码/文档入口；部分大型文件按相关区间阅读，没有宣称全仓库审计、完成构建或测试通过。PR 状态是本次查询快照，不作为将来状态保证。

- [C0] [参考 commit](https://github.com/BytePioneer-AI/codex-host/commit/d9fa7aa26474127bb80cbf086cd49503f7cc4ccf)
- [C1] [公共 Harness / Session / HostEvent 契约](https://github.com/BytePioneer-AI/codex-host/blob/d9fa7aa26474127bb80cbf086cd49503f7cc4ccf/packages/harness-adapter/src/text-session.ts)
- [C2] [插件工厂与构造 Context](https://github.com/BytePioneer-AI/codex-host/blob/d9fa7aa26474127bb80cbf086cd49503f7cc4ccf/packages/harness-adapter/src/plugin.ts)
- [C3] [添加 Harness 的开发指南](https://github.com/BytePioneer-AI/codex-host/blob/d9fa7aa26474127bb80cbf086cd49503f7cc4ccf/.agents/skills/codexhost-add-harness/SKILL.md)
- [C4] [Pi adapter 与 transport 接缝](https://github.com/BytePioneer-AI/codex-host/blob/d9fa7aa26474127bb80cbf086cd49503f7cc4ccf/packages/adapters/pi/src/pi-adapter.ts)
- [C4b] [Pi RPC 原生会话边界](https://github.com/BytePioneer-AI/codex-host/blob/d9fa7aa26474127bb80cbf086cd49503f7cc4ccf/packages/adapters/pi/src/pi-rpc-session.ts)
- [C5] [能力与模型引用 schema](https://github.com/BytePioneer-AI/codex-host/blob/d9fa7aa26474127bb80cbf086cd49503f7cc4ccf/packages/shared-contracts/src/harness-models.ts)
- [C6] [Pi 原生模型目录转换](https://github.com/BytePioneer-AI/codex-host/blob/d9fa7aa26474127bb80cbf086cd49503f7cc4ccf/packages/adapters/pi/src/pi-model-catalog.ts)
- [C7] [Codex UI projector](https://github.com/BytePioneer-AI/codex-host/blob/d9fa7aa26474127bb80cbf086cd49503f7cc4ccf/packages/protocol-core/src/codex-ui-projector.ts)
- [C8] [插件运行时的已实现边界与限制](https://github.com/BytePioneer-AI/codex-host/blob/d9fa7aa26474127bb80cbf086cd49503f7cc4ccf/docs/architecture/harness-plugin-runtime.md)
- [C9] [Claude SDK transport](https://github.com/BytePioneer-AI/codex-host/blob/d9fa7aa26474127bb80cbf086cd49503f7cc4ccf/packages/adapters/claude-code/src/sdk-transport.ts)
- [C9b] [Claude 插件中的平台/Broker 选择](https://github.com/BytePioneer-AI/codex-host/blob/d9fa7aa26474127bb80cbf086cd49503f7cc4ccf/packages/adapters/claude-code/src/plugin.ts)
- [C10] [原生身份、历史与恢复契约](https://github.com/BytePioneer-AI/codex-host/blob/d9fa7aa26474127bb80cbf086cd49503f7cc4ccf/.agents/skills/codexhost-add-harness/references/thread-lifecycle-and-history.md)
- [C11] [公共会话 Fake 测试](https://github.com/BytePioneer-AI/codex-host/blob/d9fa7aa26474127bb80cbf086cd49503f7cc4ccf/packages/harness-adapter/test/text-session.test.ts)
- [C12] [package.json 版本与许可证](https://github.com/BytePioneer-AI/codex-host/blob/d9fa7aa26474127bb80cbf086cd49503f7cc4ccf/package.json)
- [C13] [归档的反向 ZCode 接入 PR #337](https://github.com/BytePioneer-AI/codex-host/pull/337)
- [C14] [LGPL v3 许可证文本](https://github.com/BytePioneer-AI/codex-host/blob/d9fa7aa26474127bb80cbf086cd49503f7cc4ccf/LICENSE)
- [C15] [按原生传输划分的代码导航](https://github.com/BytePioneer-AI/codex-host/blob/d9fa7aa26474127bb80cbf086cd49503f7cc4ccf/.agents/skills/codexhost-add-harness/references/current-harness-implementations.md)

## 附录 D：v0.3 工作区与侧栏参考

本次源码引用继续固定原基线；Git 文档于 2026-09-24 核对。用户截图是产品形态参考，本计划不宣称逐像素复刻或已运行 Orca。

- [H1] [ZCode 窗口 WorkspaceTabState 与 tab store](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/packages/ui/src/store/tabStore.ts)
- [H2] [ZCode Git 工作区分类与接口](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/packages/shared/src/git.ts)
- [H3] [ZCode 原生 CLI 图标入口](https://github.com/zai-org/ZCode/blob/328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f/packages/ui/src/lib/providerCliIcon.tsx)
- [H4] [CodexHost Pi manifest 与图标资源](https://github.com/BytePioneer-AI/codex-host/blob/d9fa7aa26474127bb80cbf086cd49503f7cc4ccf/packages/adapters/pi/manifest.json)
- [H5] [Git worktree 官方文档](https://git-scm.com/docs/git-worktree)
- [H6] [Git rev-parse 官方文档](https://git-scm.com/docs/git-rev-parse)
