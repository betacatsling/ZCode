# 剩余工作包：可独立派发的 54 个小任务

依据 [ACCEPTANCE](ACCEPTANCE.md) 与源码 `8d5d32b`。**这是后续执行清单，不是本轮自动扩展功能的授权，也不是已完成报告。** 本轮只做整合/文档/检查。I-01 已形成处置表，I-03 已完成只读耦合评审；其他项按实际证据推进，不能从依赖满足推断通过。

## 派发统一合同

每个任务以表格一行作为最小工作包，交给一个 Agent 时补充：候选 commit、独立 cwd、该行允许的文件、对应 spec、禁止改动、精确验证命令及报告位置。输出必须包含实际 diff、测试结果、未验证项和阻塞；无关修改不纳入。

- 模型：开发 subagent 可用 6Astra / 6Sol / 6Luna。可用性失败需报告，不悄悄换渠道。
- 写入：一 worktree 一写入方。共享 schema、Host owner、Core authority、Catalog RPC 分别单一负责人；测试发现跨界 bug，先交还 owner，不平行修改同一实现。
- 分工：可以并行测试/审查独立边界；有接口依赖的任务先冻结合同，再由独立组件实现，最终单一集成人合并。
- 资源：用户已要求实际代码修改、安装、构建和重测试移到 server1 专用目录；本机只保留编排、文档、审查。确需 macOS Electron/原生窗口验收时单独安排轻量且隔离的 Mac 窗口；不能拿 Linux 无头结果替代。远端逐步提高并发，不硬凑100个共享目录写入者。
- 凭据：模型联调使用目标自身受授权配置，秘密只在进程内；不得复制 HOME、密钥或全局配置。项目 API 全局计数上限 100，重试和辅助调用也计数。额度不足写未验证。
- 状态/时序：spec 先行，明确 owner、commandId、epoch/generation、失联/unknown、重放与取消边界；禁止用超时制造同步成功。
- 报告：源码/测试存在、当前执行、历史报告、产品认证分别记录。重任务使用后台通知；不靠轮询消耗 Agent。

## I：来源与安全整合（单一集成人）

| ID | 所有者 / 文件边界 | 输入 → 交付物 | 验收标准 | 依赖 / 环境 |
|---|---|---|---|---|
| I-01 | 集成；Git 来源及 INTEGRATION-ASSEMBLY | 107 分支/脏树/patch-ID → 等价、替代、遗漏、搁置清单 | 不重复导入 protocol WIP/Pi 旧所有权；原 main 和脏树保留 | 无 / 本地；处置表已形成 |
| I-02 | Model 测试；仅 `openai-developer-role.test.ts` | 原 model-runtime 多出的拒绝断言 → 格式化、独立 test-only patch | 顶层 instructions 与多 system 冲突在 HTTP 前拒绝；sent=0；不改 runtime | I-01 / 本地或 server1 |
| I-03 | Native safety 审查；四个遗漏提交 | `d7b6f7b/8d06d09/b82107b/6d84856` → 耦合/冲突/接口清单 | 排除等价前置 `5e96141`；不得移入分支上无关删除；不能逐个盲 pick | I-01 / 只读；已判定需联合对齐 |
| I-04 | Native safety 单一写入方；runner/child/observer/受影响 Model hook | I-03 + 安全 spec → 有界联合整合补丁 | pre-effect 权限身份、usage 关联、SSE 边界、退出回收用 synthetic 负例证明；不调用真实模型 | I-03、V-01 / 独立 worktree |

## V：当前候选可复现基线

| ID | 所有者 / 文件边界 | 输入 → 交付物 | 验收标准 | 依赖 / 环境 |
|---|---|---|---|---|
| V-01 | CI；工具链/忽略构建产物，不改产品 | 干净候选、mise/lock → HEAD/Node/命令/退出码日志 | Node24.14/pnpm10.33；依赖前置、typecheck、lint、架构真实结果，失败定位，不“修绿”证据 | 本轮本地结果见BASELINE；后续server1 |
| V-02 | 合同 QA；既有 services/UI/CLI 测试 | 当前候选 + 测试入口 → 分模块 pass/fail/skip 清单 | 普通测试无账号；Native/Codex 真实子进程 opt-in 独立记录；glob 不冒充全仓覆盖 | V-01 / server1；平台限定另记 |
| V-03 | 干净安装 QA；安装/生成输出 | 冷目录、离线依赖缓存 → 可复现安装及缺资源清单 | 不借用别的 worktree dist；ignore-scripts 不当作 Electron/native ready | V-01 / server1，平台资源另验 |
| V-04 | adapters测试编译 owner；Ajv导入/构造接缝 | 本轮TS2351与历史default/named互退 → 同时满足NodeNext类型和真实ESM的最小修复 | spec/test先行；adapters build与真实schema测试均过，不能只改导入让一侧绿 | I-01 / server1；当前明确构建阻塞 |

## H：Catalog / Worktree（公共合同单一所有者）

| ID | 所有者 / 文件边界 | 输入 → 交付物 | 验收标准 | 依赖 / 环境 |
|---|---|---|---|---|
| H-01 | 能力目录 QA；registry/hierarchy tests | 当前 manifests/probe → 版本×目标×操作四态表 | supported/unsupported/unknown/experimental 有原因；UI 与后端准入不矛盾 | V-01 / 本地 |
| H-02 | Catalog 合同→bridge；serviceContract/targetBridge | Target 已支持 existing、新建请求目前仅 new → 现有分支创建的公共合同及接线 | 不强制覆盖/切换已占用分支；new/existing 均有拒绝与成功测试，UI 后续消费同一接口 | V-01 / 独立合同写入方 |
| H-03 | Target 恢复合同；worktreeService/RPC | 私有 `recoverCreation` → 经审核 identity 的公共恢复操作 | 只确认原 operation/candidate/generation；不重放 Git、不按路径猜归属；错误 identity 拒绝 | V-01；与 H-02 合同串行 |
| H-04 | Catalog 恢复设计；projectCatalog | pending intent 阻塞全部写入 → 缺失 receipt 的处置规则及实现方案 | 先确认“可信无副作用”和“未知”区别；未经产品/owner 对齐不新增 abandon/retry 后门 | H-03 / 先设计对齐，再实现 |
| H-05 | Catalog 恢复 QA；独立恢复测试文件 | H-03/H-04 → 故障重启/遗留 intent 回归 | 已完成 receipt 只读修复；未知保留，非相关元数据操作策略符合确定合同 | H-03/H-04 / server1 |
| H-06 | Git 删除 QA；独立删除竞态测试 | target remove/preview/admission → 可复现并发场景 | 冻结后重检；dirty/主检出/待审批/offline/unknown 不删除；新会话不能穿透 | V-02 / server1 disposable Git |
| H-07 | 身份 QA；独立重建/双目标测试 | generation/行政身份/remote identity → 隔离回归 | 同路径不同主机不串；删除重建不能恢复成旧 workspace；移动仅在同实例证据下更新 | V-02 / 两个隔离 target |
| H-08 | 迁移 QA；legacyWorkspaceMigration/fixture | 旧 cwd/普通文件夹/linked/bare/offline → dry-run 和回滚报告 | 保留原 ID/cwd/模型，非 Git 不 init，离线不批量丢树；备份与重复运行有证据 | V-02、N-02 / 本地+server1 |

## N：Native 接入（原 CLI 仍是业务 owner）

| ID | 所有者 / 文件边界 | 输入 → 交付物 | 验收标准 | 依赖 / 环境 |
|---|---|---|---|---|
| N-01 | Core owner；coreAuthority 与 native-create 合同 | 当前 test-only gate → 生产启用前置清单和决定 | 不直接移除 `ZCODE_CORE_NATIVE_CREATE_TEST_ONLY`；明确 receipt/Catalog/lease 全部前置 | V-02、I-04 / 先审查 |
| N-02 | Native 回归 QA；nativeLegacyProduct tests | 已有 legacy/public Core fixture → 当前源码执行结果 | 原 ID、fork/edit/retry、busy 队列、权限、停止、两种 delivery 均按原 owner 验证 | V-02 / 本地或 server1 |
| N-03 | 远端 attachment owner；Core/连接注册表公开接缝 | remoteSessionId 来源及窗口scope → 可信请求的目标路由合同与测试 | 按窗口/target/identity/generation 校验；不能以 caller 字符串或本地 Core 冒充认证 | L-02、N-01 / server1隔离 |
| N-04 | Native 发布门控 QA；仅门控/回滚测试 | N-01～N-03 → opt-in/on/off及冷恢复矩阵 | 关闭新准入不隐藏原历史、不换 owner、不重新发已接受输入 | N-01/N-02/N-03 / 两端 |

## U：UI 产品路径（通过 hooks 服务访问）

| ID | 所有者 / 文件边界 | 输入 → 交付物 | 验收标准 | 依赖 / 环境 |
|---|---|---|---|---|
| U-01 | Desktop rollout；main 接入与资源检查 | `ZCODE_DESKTOP_CORE_ATTACHMENT` + packaged Core → 生产入口方案/诊断 | 真 service 可用才显示 hierarchy；缺资源明确失败；不能只改 fixture 或强开开关 | R-01、H-01、N-01 / Mac |
| U-02 | UI QA；同 workspace 多会话 E2E | 实际 Shell/Host 两 Pi+一 Native → 创建/切换/取消证据 | worktree 数不增；独立模型/上下文/draft；取消一个不影响其他；品牌不随模型变 | V-02、N-02 / Mac |
| U-03 | UI QA；focus/attention E2E | actual Shell + 后台事件/隐藏workspace → 焦点/草稿/可达审批报告 | 发现/流式/恢复不抢焦点；隐藏审批有入口；空主 workspace不因关视图消失 | V-02 / Mac+mobile viewport |
| U-04 | 配对手机 QA；pairedPhoneActual及独立用例 | loopback consent/replayable attach → 断档/待审批/revoke矩阵 | 同 Host，重连不重发；拒绝迟到审批；实体手机/TLS未测单列，不能用 viewport冒充 | L-01、V-02 / Mac+浏览器 |

## M：真实模型（统一预算所有者）

| ID | 所有者 / 文件边界 | 输入 → 交付物 | 验收标准 | 依赖 / 环境 |
|---|---|---|---|---|
| M-01 | Provider QA；只读 metadata probe | 两目标现有 registry → StepFun全部/AxonHub DeepSeek精确ID+API+能力清单 | 秘密不输出；不把 Pi agent registry 当 ZCode支持证明；不自动改协议配置 | 无 / 本地+server1，零付费 |
| M-02 | Native fixture；既有 bootstrap 注入接缝 | `NativeProtocolBootstrapDependencies.startProviderRegistryRuntime` → 受信隔离 fixture | 复用真实 registry/model，不另建HTTP客户端；secret不落盘；先Fake通过 | V-02、I-04 / 独立测试范围 |
| M-03 | 预算/证据 owner；联调runner计数 | M-01清单+100次上限 → 全局调用账本与停止机制 | 工具循环、重试、辅助模型均计数；失败不无限重试；保留 requested/effective脱敏事实 | M-01 / 单一计数所有者 |
| M-04 | 本地模型 QA；唯一 live lane | 两家代表模型+Pi/Native → 四格读→改→测试→追问证据 | 实际模型路由一致，拒绝无副作用，批准有效；只认本次版本结果 | M-02/M-03、U-02 / Mac |
| M-05 | 扩展兼容 QA；逐模型单元格 | M-01其余模型+剩余额度 → 支持/受限/失败/未验证矩阵 | 禁止静默换模型；reasoning/images/tools限制逐项；额度耗尽保留未测 | M-04、L-03 / 两端；与其他paid lane串行或统一配额 |

## L：独立生命周期与远端

| ID | 所有者 / 文件边界 | 输入 → 交付物 | 验收标准 | 依赖 / 环境 |
|---|---|---|---|---|
| L-01 | Supervisor QA；现有 recovery/core tests | marker namespace/pid+token/generation → 当前故障矩阵 | live/foreign/ambiguous owner拒绝；真实reaped后恢复；未知command journal字节不动 | V-02 / server1 |
| L-02 | SSH 包装；安装/attach专用脚本与artifact | 固定Linux closure+manifest → server1隔离安装/attach报告 | Node24/ABI正确；无secret/越界symlink；不替换现有服务；artifact哈希可追溯 | R-02 / server1 |
| L-03 | 远端模型 QA；唯一远端paid lane | 已安装Core、两家代表模型 → Native/Pi四格工具循环 | 目标本地执行与route证据；最多消耗共享M-03余额；StepFun API类型先确认 | L-02、M-02/M-03、N-03 / server1 |
| L-04 | detach QA；独立故障脚本 | 运行中目标任务 → GUI完全退出、SSH断连再附着证据 | 后续Model调用仍能继续；相同session/command；prompt与文件副作用不重复 | L-02；真实模型场景另依赖L-03 / Mac+server1 |
| L-05 | 审批/重连 QA；独立场景 | 待审批任务+两种delivery → 同interaction恢复/过期拒绝报告 | 不把离线标完成；一次批准只一次effect；revocation仅断view不偷停任务 | L-01/L-02 / 两端；Fake先行 |

## C：Codex / Claude（不以品牌名推断能力）

| ID | 所有者 / 文件边界 | 输入 → 交付物 | 验收标准 | 依赖 / 环境 |
|---|---|---|---|---|
| C-01 | Codex QA；现有native controls/byte faults | CLI0.156.1+FakeGateway → 可重现控制/usage/未知执行结果 | 真子进程reap、cancel/resume、重复审批与缺失usage负例；不是付费认证 | V-02 / 支持平台 |
| C-02 | Gateway composition owner；Gateway生命周期/lease | 现有Responses ingress/encoder/token → target-local production composition | loopback/会话令牌/冻结route/abort；unsupported在Model前拒绝；无全局CLI改写 | C-01 / server1 |
| C-03 | Host注册 owner；lazyTargetService等单一注册点 | C-02+trusted manifest+probe → Codex明确opt-in availability | 只有版本/route/reasoning配置已认证才可选，未支持返回原因 | C-02、H-01 / 与其他Host改动串行 |
| C-04 | Codex协议 QA；辅助请求矩阵/独立tests | 固定CLI请求轨迹 → 辅助端点、private/cache/developer语义表 | 不丢字段不伪造signature；真实Provider样本需M-03额外分配且不得超过总额 | C-01/C-02 / Fake先行 |
| C-05 | Claude transport调查；固定版本受支持配置 | 当前beta头拒绝证据 → 官方机制或候选版本的受限wire probe | 无不支持beta头才可前进；禁止偷剥头/patch SDK冒充兼容；找不到即明确阻塞 | 无 / disposable无凭据 |
| C-06 | Claude路径安全 owner；contract/transport | profile根目录承诺 → 完整worktree及个人HOME范围校验 | worktree其他子目录/HOME下profile均拒绝，合法专用profile可用 | V-02 / 单独安全测试 |
| C-07 | Messages协议 owner；ingress/route tests | C-05所有实际请求 → endpoint/header/body能力矩阵 | count/compact/hello等要么正确支持要么明确拒绝；无静默丢语义 | C-05 / Fake |
| C-08 | Claude joined QA；SDK→Gateway fixture | C-05～C-07 → 两轮工具/deny/allow/cancel/resume/route证据 | 真实SDK结果、final assistant和退出确认；production资格单独判定 | C-05/C-06/C-07 / 无账号先行 |

## A：通用 ACP 与资产

| ID | 所有者 / 文件边界 | 输入 → 交付物 | 验收标准 | 依赖 / 环境 |
|---|---|---|---|---|
| A-01 | ACP profile QA；trusted factory与专用fixture | 一个固定真实ACP executable → settings隔离/审批/load/cancel报告 | 仓库配置不能绕过审批；load协商失败不冒充resume；不支持保持disabled | V-02 / server1 |
| A-02 | 第二ACP QA；另一manifest/profile | A-01共享合同+不同真实Agent → 第二认证报告 | 仅manifest/profile必要扩展；不改公共UI状态机；synthetic不计真实第二Agent | A-01 / server1 |
| A-03 | 资产许可 owner；source-map/provenance | Pi/Codex/Claude拟用图像+来源 → 分发权/归属决定 | press-kit可下载不等于有分发权；无授权继续中性fallback | 无 / 文档审查 |
| A-04 | 资产resolver owner；静态allowlist/validator/tests | A-03已批准资产+旧分支validator差异 → 独立安全补丁 | 检查字节/路径/外链/SVG执行风险与打包；图标依harnessId不依模型 | A-03 / 不整支合并brand-assets |

## P：负载接缝与长期证据（Fake Provider，不花模型额度）

| ID | 所有者 / 文件边界 | 输入 → 交付物 | 验收标准 | 依赖 / 环境 |
|---|---|---|---|---|
| P-01 | 性能mount owner；production-driver.mount | 现有单会话Electron诊断 → runner接入真实Shell/Sidebar/Pane | 同一Core owner、50worktree/10会话/5展开；不能返回假metadata | U-02 / Mac；先冻结采样合同 |
| P-02 | 浏览器采样 owner；独立sample模块 | P-01公开page/owner接口 → typed/switch到paint测量 | 每会话至少20对测量，focus/draft稳定，不以RPC返回代替paint | P-01合同 / Mac |
| P-03 | 进程指标 owner；独立facts模块 | P-01进程/sequence接口 → backlog与Core/Host/renderer metrics | 真pid/RSS/heap、消费cursor和清理后存活核对；不能以runner内存代替 | P-01合同 / Mac；后端大事件可server1 |
| P-04 | baseline QA；prepare/comparator | 同机可挂载旧版本+固定dataset → 基线与候选短窗口比较 | 不同保存commit、相同driver/hardware/config/sample人口；两个p95分别≤约定10% | P-01/P-02/P-03 / 独占测量窗口 |
| P-05 | 长期 QA；runner不改产品 | 完整driver+隔离资源窗口 → 两种delivery各8h/100k/50/10/5结果 | 清理/重连/积压/进程/内存有证据；短benchmark不当8h，失败保留失败 | P-01/P-02/P-03 / 预约资源；不得自动在本轮启动 |

## R：安装与发布（最后决策，不自动 push/release）

| ID | 所有者 / 文件边界 | 输入 → 交付物 | 验收标准 | 依赖 / 环境 |
|---|---|---|---|---|
| R-01 | macOS packaging；desktop资源/打包测试 | 固定候选及Core/worker closure → 实际安装包+smoke+哈希 | 包内入口/SDK/Node/native资源实跑；bootstrap通过不代替installer | V-01/V-03 / Mac |
| R-02 | Linux packaging；server-cli stage/worker | 固定候选→版本化Linux包与manifest | Node24及ABI依赖齐；离开开发node_modules仍可启动Core/Pi；无secret | V-01/V-03 / server1隔离 |
| R-03 | 发布集成 owner；版本/schema/rollback演练 | 平台包及所有目标范围gate → release/no-release决定 | 新旧存储不互写；升级/回滚不换owner/重放；未认证组合不开放；需明确发布授权 | N-04、L-04/L-05、P-04/P-05、适用C/A/M / 两端 |

## 并行波次与冲突规避

```text
I-01 ─┬─ I-02
      └─ I-03 → I-04 ───────────────┐
V-01 → V-02/V-03 → H/U/N/L 基础QA ├→ M-04/L-03 → M-05
M-01 → M-03 ──────────────────────┘
R-02 → L-02 → N-03/L-03/L-04/L-05
C-01 → C-02 → C-03       C-05 → C-07 → C-08
A-03 → A-04              A-01 → A-02
U-02 → P-01 → P-02/P-03 → P-04/P-05 → R-03
```

- 首波可以并行：I-02、I-03、H-01、M-01、C-05、A-03；V-01 独占构建资源。每项产物小，不把“做完P4”交给一个 Agent。
- 合同冻结后可以并行：UI独立场景、Native既有回归、Codex协议、Claude路径安全、ACP固定profile；所有代码在隔离worktree，公共owner改动排队。
- Catalog H-02/H-03/H-04 和 Core/Host 注册跨文件时使用同一集成人；不得因为任务多就并发写同一合同。
- 故障/性能任务不能在普通日常用户目录或生产SSH服务上执行。真实模型有统一额度负责人，不能给每个Agent各100次。

当一个任务证据不足时输出最小阻塞与下一动作；不扩大范围、不新增兜底分支、不把“看起来能跑”升级为完成。
