# 分支、PR 与代码导航整理记录

日期：2026-09-29。完整逐项清单：[branch-consolidation-2026-09-29.json](branch-consolidation-2026-09-29.json)。项目下一阶段工作以 [总体交付计划](PROJECT-DELIVERY-PLAN.md) 为准。

## 已执行的远端整理

| 项目                            | 整理前                | 本次结果                                                                  |
| ------------------------------- | --------------------- | ------------------------------------------------------------------------- |
| 原有远端分支                    | 220                   | 删除 216，保留 4；本次整理工作分支仅在 PR 期间临时存在                    |
| 已含于集成历史的旧分支          | 15                    | 核对 tip 为集成 snapshot 的祖先后删除引用，提交仍在历史中                 |
| 已合并 PR 的旧分支              | 90                    | 核对当前 tip 等于 PR head，且 merge commit 已在集成历史中后删除引用       |
| 未合入/无法证明完全吸收的旧分支 | 111                   | 先建立并核验同 SHA 归档标签，再删除原分支引用；不把这些代码自动混入集成线 |
| 归档标签                        | 本次新增 112          | 111 个分支 tip，加 1 个整理前集成 snapshot                                |
| 旧重复 PR                       | #1–#14、#19           | 已关闭并写明取代关系；没有把“关闭”伪装成独立功能新合并                    |
| 总集成 PR #15                   | 目标为 wave1 功能分支 | 目标调整为 main，继续 Draft，成为唯一主线接纳入口                         |
| main                            | `30e8d0a`             | 本次没有改变 main，也没有宣称集成版可发布                                 |

所有引用删除都带 expected SHA 的 `force-with-lease`，按批次原子提交。操作前重新读取打开的 PR 及远端 tip；有新提交/活跃依赖的分支会保留。实际本批 216 项均删除成功。

“已合并”与“归档”严格区分：111 个归档项包含 107 个 `goal/*` 历史实验、旧 `work/multi-harness-completion`、原登录计划等独立 tip。这些工作完整保留，但仍需 M1 评估其适配性和测试后才能移植。

## 保留的四条原有工作线

| 分支                                    | 用途                       | 后续处理                                                                                            |
| --------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| `main`                                  | 默认基线                   | 只通过 #15 和候选验收接纳项目交付                                                                   |
| `cursor/wave4-harness-integration-b7a9` | 唯一集成线                 | 新工作从此派生；保持原名称，避免破坏现有引用                                                        |
| `cursor/wave5-release-hardening-c3f2`   | #16 的独立发布演练         | 1 个独立提交、8 文件约 659 行；先复核版本锁定与隔离回滚测试，再合入集成线。fixture 不等于安装包认证 |
| `cursor/mac-live-recovery-gated-3d50`   | #17 的 Mac 测试/修正与报告 | 4 个独立提交，包含 socket 路径修正和历史实机证据；需解决与当前集成线的冲突，并在标准构建候选上补测  |

#16/#17 均没有因本次整理被强制合并。原始分支及 PR 保持可继续工作，M1/M2 分别追踪其收敛。

## PR 关系

```text
已关闭的 #1–#14 ── 原提交已在集成历史 ──┐
已合并子 PR ───────────────────────────┤
                                      ▼
                        wave4 集成分支 ── #15 (Draft) ── main
                                      ▲
                             #16 / #17 独立增量待验收

#19 原计划 ── 已被演进后的登录计划及总计划取代；原 tip 有归档标签
```

#19 未合并旧文档，因为目标分支已经有后续演进版本；盲合冲突会倒退状态。关闭理由已写入 PR，原文本/提交仍可恢复。

## 可恢复性

1. 本机已生成并 `git bundle verify` 通过完整备份 `ZCode-before-consolidation-20260929.bundle`，包含清理前全部本地与已获取远端引用。文件约 44 MB；SHA-256 见 JSON 清单。
2. GitHub 上的 `archive/2026-09-29/integration-before-consolidation` 固定到 `f130e1940c0d70ddc71d3fe586fc2a333b9f212e`。
3. 111 个独立 tip 使用 `archive/2026-09-29/<原分支名>` 标签。已核对每个远端标签与原 tip 完全相同。
4. 其他已整合提交可从集成 snapshot、原 PR head refs 或完整 bundle 恢复。清单保留原名称、SHA、关联 PR、处理方式和结果。
5. 旧 PR 标题/正文/分支关系的完整 JSON 也保存在本机备份；仓库内不复制可能含执行机路径的旧正文。

示例：恢复归档中的旧工作到一个新分支，不覆盖当前集成线。

```sh
git fetch origin refs/tags/archive/2026-09-29/work/multi-harness-completion
git switch -c recovery/multi-harness-completion FETCH_HEAD
```

恢复已合并 PR 的原始 head 可使用 GitHub `refs/pull/<编号>/head`。如果远端引用不可获取，从 bundle 中按清单取回 `refs/remotes/origin/<原分支名>`，不要猜测或重建丢失提交。

## 代码与文档整理范围

- 新建唯一项目总计划，区分首个可用版本与 P0–P6 全部完成，并给出 M0–M7、代码职责、依赖、验收矩阵和 main 接纳方式。
- 将 `IMPLEMENTATION.md` 从重复的逐 PR 历史汇编改为模块导航，纠正“没有持久 Catalog/会话迁移/创建路径”等过时说法；旧内容完整保存在 snapshot 标签的 Git 历史。
- 重写 `ACCEPTANCE.md` 为证据入口与等级说明；历史 live/checkpoint 文档标明版本和使用边界，不删除原失败记录。
- 登录移除计划保留实施范围，去掉不断增长的 PR 编号段落，转向总计划 M3 的真实验收。
- 登录检查脚本按职责拆成六组断言及共用 source scanner，入口和输出字段不变；不修改运行时登录、模型、权限或任务行为。

## 本次验证

- 清理前 `pnpm typecheck`：通过。
- 清理前 `pnpm lint`：84 warnings / 4 errors。其中验证脚本自身 1 个 `max-lines`，其余三个为 `ProjectSidebarAgentCreateForm.tsx`、`claudeHarnessAdapter.ts`、`remote/connect.ts`。
- 验证脚本拆分前后通过结果等价（只排除允许缩短的 soft note）。
- 成功与故障注入等价验证覆盖 9 个场景：基线、登录面板恢复、旧 locale、Provider UI 连线、旧 helper、共享 DTO、旧状态字段、CLI 浏览器调用，以及必须保留的 MCP OAuth。
- 可复现入口：`node --test scripts/product-login-checks/refactor.test.mjs`。只在临时源码 fixture 中注入，测试缺少历史基准时明确失败。
- 改动脚本的单独 lint：0 warnings / 0 errors。最终根 lint 为 84 warnings / 3 errors：验证脚本的行数错误已消除，保留三个已有运行时文件的行数错误。

最终 `pnpm typecheck` 通过，架构检查 0 violations / 0 new；9 个等价场景连同父测试共 10 tests 全部通过、0 skipped。改动文件格式检查、文档链接、清单计数及 `git diff --check` 通过。验证入口从 1,402 行缩减为 182 行，按职责拆分后的各文件均低于 400 行。

本次没有运行真实 Provider/SSH/GUI 或全量发布矩阵，未将任何历史实机报告提升为当前候选认证。
