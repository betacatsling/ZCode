# 多 Harness 实现导航与证据边界

更新：2026-09-29。项目级进度、优先级与完成标准统一见 [总体交付计划](../PROJECT-DELIVERY-PLAN.md)，不再在本文件逐条追加 PR 编号或 tip SHA。

本次对照源码为整理前集成版本 `f130e1940c0d70ddc71d3fe586fc2a333b9f212e`。原长篇阶段汇编保留在 Git 标签 `archive/2026-09-29/integration-before-consolidation` 的同路径；其中“当前环境”“尚无实现”等描述属于当时记录，不能继续当作最新源码结论。

## 实现地图

| 领域                           | 已存在的实现                                                                             | 尚需项目级证明                                                  | 详细契约                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 共享身份与路由                 | AgentHost/SessionSpec、Project/Workspace 层级、V4 投影和原生/外部分流                    | 跨版本、跨 target 与真实产品面一致                              | [CONTRACT](CONTRACT.md)、[HIERARCHY](HIERARCHY.md)、[PROJECTION](PROJECTION.md)                          |
| Project Catalog                | profile-local Project metadata、目标 workspace 展示缓存、schema v2 持久化                | 真实离线/重连 freshness 与多窗口交互                            | [PROJECT-CATALOG](PROJECT-CATALOG.md)                                                                    |
| Worktree                       | discover/adopt/create/revalidate/remove、generation 与 admission fence                   | 真实 SSH、目录变化、删除竞态和 UI 联动矩阵                      | [WORKTREE](WORKTREE.md)、[WORKSPACE-ADMISSION](WORKSPACE-ADMISSION.md)                                   |
| 层级迁移                       | 持久索引来源、preview/apply、CAS、备份/rollback、保留原 owner locator                    | 用户升级数据集与真实 UI 迁移/回退验收                           | [SESSION-MIGRATION](SESSION-MIGRATION.md)                                                                |
| 工作区会话创建                 | createWorkspaceSession、native owner/外部 manifest、幂等 receipt 和 read-only membership | 同 worktree 多会话、跨 target 历史、UI 焦点及故障回归           | [SESSION-MIGRATION](SESSION-MIGRATION.md)、[创建与历史 spec](../specs/agent-creation-harness-history.md) |
| 外部 Host                      | SessionHost、CommandJournal/EventJournal、target 服务与能力目录                          | 生产组合、进程崩溃、连接授权、长期生命周期                      | [SERVICE](SERVICE.md)、[DIRECTORY](DIRECTORY.md)、[RUNTIME-HOST](RUNTIME-HOST.md)                        |
| Pi                             | 真实 SDK worker、Model bridge、局部 FakeModel 和历史 live 记录                           | 当前候选的原生/Pi × Provider × local/SSH 完整矩阵               | [PI-WORKER](PI-WORKER.md)、[LIVE-CERTIFICATION](LIVE-CERTIFICATION.md)                                   |
| Codex                          | app-server adapter、Model Gateway 与多项 FakeModel 控制/绑定测试                         | 真实 Provider/SSH、sandbox、grant 与长会话认证                  | [CODEX-HARNESS-ADAPTER](CODEX-HARNESS-ADAPTER.md)、[CODEX-APP-SERVER](CODEX-APP-SERVER.md)               |
| Claude                         | structured adapter、Messages 路径及局部集成测试                                          | 共享 Gateway owner 接线与生产 live 认证                         | [CLAUDE-CODE](CLAUDE-CODE.md)                                                                            |
| ACP / Devin / OpenCode / Goose | reusable ACP、可选 Devin、opt-in OpenCode/Goose 和 SessionHost fake-transport 测试       | 第二同协议 Agent 的默认生产接入、版本兼容、安装诊断和 live 运行 | [SECOND-ACP-INSTALL-DIAG](SECOND-ACP-INSTALL-DIAG.md)                                                    |
| UI                             | ProjectSidebarMount、Harness picker/header、既有 V4 conversation provider、原生历史入口  | 可见 UI + durable owner 的完整端到端证据                        | [PROJECT-SIDEBAR](PROJECT-SIDEBAR.md)、[UI-CONVERSATION](UI-CONVERSATION.md)                             |

## 需要纠正的旧台账结论

- 不再说“没有 durable Project Catalog”：当前契约和实现已有 schema v2 文件、目标引用与 freshness。
- 不再说“没有旧会话迁移/备份/回滚”：SessionHierarchy 已有这些能力，剩下的是当前产品组合与真实升级验收。
- 不再说“没有工作区会话创建路径”：已有公开 Host 创建、owner association 和幂等 receipt。其存在不自动证明 UI/多 target 全链路可用。
- 不把过去某次 live 成功、失败或假模型循环结果升级为当前候选完成；保持完整运行版本和失败记录。
- 不把移除登录的代码清理计入 ACP/P6 完成。二者共用项目交付入口，但验证对象不同。

## 当前生产边界

1. lazy Host 当前登记 Pi、Codex、Claude、Devin。OpenCode/Goose 的 opt-in fixture 不等于默认生产登记。
2. Codex 构造已接收共享 TargetModelGateway；Claude 构造当前没有注入该共享对象，仍可创建 adapter-local Gateway。统一所有权是 M5 的明确工作包。
3. `ZCODE_MULTI_HARNESS_ENABLED` 只控制新外部会话准入，不能替代 capability、认证、workspace/target 校验。见 [MULTI-HARNESS-ADMISSION](MULTI-HARNESS-ADMISSION.md)。
4. Core loopback Host 能力签发边界仍需 M2 审查；“能连上 loopback”不能作为完整授权证明。
5. 受支持、实验性、未知与不支持必须如实显示。测试 stub、固定 FakeModel 或命令探针不改变产品能力承诺。

## 验证与维护方式

现有测试文件中的具体场景是用例事实来源；本文件不再复制一份排列组合清单。新增场景与其行为修改一起提交，验收结果写入候选版本的统一证据表。

[ACCEPTANCE](ACCEPTANCE.md) 给出证据入口和等级；[总体交付计划](../PROJECT-DELIVERY-PLAN.md) 给出 M1–M7 的出口。只有标准构建、真实矩阵、安全负例和发布候选验收都满足时，才提升阶段状态。
