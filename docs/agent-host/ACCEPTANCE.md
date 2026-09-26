# 当前实现与 v0.3 计划的差距

源码审计基线：`8d5d32b3bee0242a3f68ed2b79b4796fe0bd1bb6`，候选分支 `work/multi-harness-completion`。目标：[v0.3 计划](../../ZCode_Multi_Harness_Refactor_Plan_v0.3_Orca_Hierarchy.md) §§6、9–10、12–13。

**结论：不是“只写了接口”，也不是“已完成产品”。主要领域组件、适配器及多条 joined 测试已经存在；剩余集中在生产准入、兼容性阻塞、遗漏成果整合和真实场景验收。** 不给无依据的完成百分比。

## 状态口径

- **实现存在**：当前候选源码有对应行为和所有者。
- **受限/未启用**：代码存在，但版本、协议、能力或功能开关限制产品使用。
- **未实现**：有明确缺失的源码接缝；不能与“未测试”混为一类。
- **待验证**：测试存在或旧记录称通过，本轮未在当前源码/环境完成验收。
- **历史证据**：明确绑定旧 commit/目标/模型；缺失原日志不得升级为本轮 PASS。

本轮实际命令及结果只放 [BASELINE](BASELINE.md)。源文件/测试存在不等于命令通过；Mock、Fake Model、loopback 浏览器不等于真实 Provider、SSH 或实体手机。

## 逐项对照

| 计划项 | 当前已经有 | 真正剩余的 gap | 后续任务 |
|---|---|---|---|
| P0 基线/构建 | 固定工具链、架构检查、独立数据/fixture、分项目 typecheck 入口 | 当前候选 adapters 前置构建实际 TS2351 失败（root typecheck 单独通过）；仍需安装包/平台验证，历史日志不能混记 | V-01～V-04、R-01/R-02 |
| P1 契约/目录 | v2 session/project/workspace schema；Host manifest+factory 注册与探测；Mock、命令/事件日志 | 四态能力在完整产品路径的认证矩阵；不是“没有 registry” | H-01、A-01/A-02 |
| P1/P2 项目层级 | `ProjectCatalog`、`TargetWorktreeService`、`CatalogWorkspaceAdmission`、hierarchy service 与三层 UI | **明确缺口**：公共 create 只支持新分支；Target 私有 recoverCreation 未经 RPC 暴露；无 receipt 的 pending intent 缺公开安全处置。另有远端/删除/迁移验收 | H-02～H-08 |
| P2 原生路径 | Core factory、Native receipt/mapping/Catalog reference、原 ID 解析、原 CLI Inbox 与 SQLite 所有权 | Native 新建仍默认关闭；生产开关决策、远端可信 attachment 及旧会话完整回归未封板 | N-01～N-04 |
| P2 UI/facade | `WorkspaceShellLayout` → hierarchy owner → native/external pane；真实 `ProjectSidebar`、selector、能力门控 | 生产代码已接线但 Desktop `ZCODE_DESKTOP_CORE_ATTACHMENT=1` 仍需显式启用；打包闭环、三会话/焦点/隐藏审批/移动端完整验收未完成 | U-01～U-04 |
| §13 品牌图标 | trusted asset ID、静态 PNG 校验和中性 fallback；身份不从模型名猜测 | Pi/Codex/Claude 真品牌资源和分发权证据不足；fallback 不等于“真实品牌图标”验收 | A-03/A-04 |
| P3 Pi 统一模型 | 独立 SDK worker；`captureHostModel` 复用 Registry/Model executor；每轮冻结；实际 tool approval；父进程 effect 清理 | 显式 `reasoningLevel=off` 等兼容约束；指定全部模型的能力/质量认证，不可由品牌推断支持 | M-01～M-05 |
| P3 Native 模型接缝 | `runZCodeProtocolAgent` 已有可信 Node `startProviderRegistryRuntime` 注入依赖 | 旧“无注入接缝”的 blocker 已过期；仍需隔离、无泄密的真实 Native 运行与路由证据 | M-02/M-04；不是再造 Registry |
| P4 生命周期 | standalone Core/Supervisor、持久 owner/command/event、维护准入、可信 stale-owner 恢复及子进程测试 | 当前打包目标上的 GUI 退出、SSH 断开/重连、待审批恢复、后续模型调用独立于 GUI 的完整证据 | L-01～L-05 |
| P4 远端归属 | 工作区 target/generation、远端连接注册表、scoped Core attachment 等边界存在 | 默认安装/路由集成与真实远端 Native 准入仍需证明；不能用目标本地 Core 代替认证后的远控 authority | N-03、L-02/L-03 |
| 手机恢复链路 | 桌面 consent、one-use challenge、现有 Host ACL、独立浏览器 replayable attach/revoke；joined E2E 存在 | 当前证明范围为 loopback；不是实体手机/非 loopback TLS 部署认证，也未覆盖全部审批与断档情形 | U-04、L-05 |
| P5 Codex | pinned app-server 0.156.1 adapter，取消/审批/resume/usage，Responses Gateway/token lease，真实 OS-child/Fake upstream 测试 | 未在常规生产 Host 注册；off-only/私有推理拒绝等限制，辅助端点与真实路由认证未完成 | C-01～C-04 |
| P5 Claude Code | SDK transport/adapter、审批 hook、inflight/resume receipt、Messages codec/Gateway 均已存在 | **具体阻塞**：pinned CLI 仍发 beta 头，Gateway 明确拒绝，profile 故保持 unsupported；隔离 root 校验也须补齐 | C-05～C-08 |
| P6 ACP | 可复用 v1 transport/adapter、trusted profile/factory、协商 loadSession 和拒绝不确定执行 | 第二 profile 主要为 synthetic；两种真实 Agent 的 settings/审批/恢复认证不足。ACP 为 harness-managed，不声称模型注入 | A-01/A-02 |
| §10 压力/性能 | disposable fixtures、负载 runner、比较器、真实 Electron 单会话诊断和测量规范 | **明确实现缺口**：production driver 的 mount/sample/facts 仍拒绝未提供的产品采样接缝；8h/100k/50/10/5、匹配 baseline 未完成 | P-01～P-05 |
| 发布/升级/回滚 | 有打包、版本/owner 检查与保护机制 | 安装产物指纹、Linux/macOS 实际执行、升级/回滚及全部 release gate 尚未封板 | R-01～R-03 |
| 遗留分支整合 | 既有 309-commit 汇总作为单一候选，多数看似分叉已有等价实现 | native-private-final 的部分安全 runner 和一条未提交 model 测试未整合；旧 protocol WIP 不应回灌 | I-01～I-04 |

## 不应继续作为“缺功能”分派的旧结论

1. “没有 Project Catalog / WorktreeService / 三层侧栏”——已有实现，需做产品场景验收。
2. “facade 从未挂载 / Core 工厂不存在 / 必须 typecheck 失败”——后续 composition 与 joined tests 已补上；默认启用另算。
3. “没有 Gateway、Claude、ACP adapter”——有受限实现；Claude 当前确有协议阻塞，不能因此否认代码存在。
4. “Native 无法注入隔离 Registry”——bootstrap 当前已有受信 Node 依赖；旧 paid fixture 尚未利用它不等于接缝不存在。
5. “Pi portable / protocol-compat 分支不在 ancestry，所以全都待合并”——已有 cherry-pick/后续替代，重复导入会回退安全语义。

## 真实模型与 SSH 验收边界

- 用户指定：StepFun 全部模型、AxonHub 的 DeepSeek 模型，用于**项目联调**；不是开发 subagent 的模型限制。
- 后续真实项目 API 调用总上限 **100 次，包括重试/工具循环/辅助调用**。本轮文档整合消耗 **0 次**。
- 先只读确认目标机器实际 registry、模型 ID/API 类型与凭据存在性，不输出 key/URL；清单不是支持认证。至少先完成 ZCode/Pi × 两家代表模型 × 本地/SSH 的八格，再在额度内扩展。达上限后剩余项明确未验证，不伪报“全部模型通过”。
- 当前只确认 SSH 登录及系统信息，远端系统 Node 20 不满足固定 Node 24。需要隔离的打包运行时，不能替换系统 Node。
- 旧 Pi 两个模型的本地成功属于历史组件证据；不覆盖 Native、当前候选、SSH 或生产 GUI。

## 下一步顺序

先 I/V（来源与当前检查）→ H/U/N/L（首版生产链路和安全验收）→ M（有预算的真实组合）→ C/A（新增 Harness 认证）→ P/R（长期与发布）。无依赖的小任务并行；同一协议或 owner 文件只设一个写入方。具体输入/输出/验收和并行波次见 [TASKS](TASKS.md)。

旧状态表及阶段叙述完整保存在 [archive](../archive/multi-harness/README.md)，不再作为当前进度。
