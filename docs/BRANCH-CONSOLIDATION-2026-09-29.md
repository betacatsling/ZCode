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

## PR #16：M1 旧资产筛选（2026-09-30）

### 元数据与比较口径

| 项目 | 结果 |
| --- | --- |
| PR | #16 `M1/M7：发布版本锁定与隔离回滚演练（待集成验收）` |
| 状态 | **open / Draft / 未合并**；GitHub 报告 mergeable clean，但没有合并结果 |
| head | `cursor/wave5-release-hardening-c3f2` @ `db215c8e20d7c9635643b56d65364e0d03d81f54` |
| base（GitHub 元数据） | `cursor/wave4-harness-integration-b7a9` @ `5ae4353d46caf9c3f22c44b07fa57cdd31127161` |
| commit list | 1 个提交：`db215c8 feat: drill macOS-local harness release rollback`（父提交 `8caf1a793b7303a3b41b55c0f3b0ca4acd212906`） |
| 对比 tip | `426bdf711b8e14e984b571067b8bcdeb4c8385c9`（当前 `cursor/wave4-harness-integration-b7a9`） |
| GitHub 文件统计 | 8 个文件，659 additions，0 deletions |

GitHub 的 changed-files 与 `8caf1a7..db215c8` 的提交级 diff 都是同一组 8 个新增文件。需要注意：head 的实际父提交不是 GitHub base SHA `5ae4353`；直接做 `5ae4353..db215c8` 会把父分支已有的 Pi/Claude 等变更也混入，得到 14 个文件。以下只按 #16 自身提交的 8 个文件分组，不把父提交差异冒充 #16；正式采纳前需维护者确认 base/parent 漂移（此元数据风险不计入下表资产数量）。

### 分级汇总

按独立资产组计：**可采纳 2 组（5 文件）／过期 0 组（0 文件）／需复核 2 组（3 文件）**。没有发现已经被当前 tip 完全等价覆盖、应直接判定过期的 #16 文件；“可采纳”不等于已通过当前候选验收。

| area | file(s) | change | grade | evidence | follow-up |
| --- | --- | --- | --- | --- | --- |
| 发布演练说明 | `docs/harness-refactor/RELEASE.md`; `packages/services/src/agent-host/release/SPEC.md` | 记录 macOS/launchd 限定、版本锁定、隔离临时目录、native/external sidecar、回滚和未支持项 | **可采纳** | 两个文件在 `426bdf7` 均不存在；总计划 §4/§7 要求 M1 固定依赖并保留 #16 的 fixture 限制，现有本记录也明确“fixture 不等于安装包认证” | 可作为独立文档补丁；合入前更新比较 SHA、当前构建结果和实际证据链接，不把历史 7 pass 直接升级为当前 tip 认证 |
| 隔离与回滚基础 helper | `drillRoot.ts`; `nativeReplay.ts`; `upgradeRollback.ts` | 只在 `tmpdir` 内操作，复用 `readLegacyZCodeSession` 区分 native/external，备份/恢复原生文件并保持 sidecar 分离 | **可采纳** | tip 没有 `agent-host/release/`；当前仍有 `readLegacyZCodeSession`（`sessionRouter.ts`）和既有 schema/sidecar 语义，未发现同功能后续实现 | 可作为 standalone M1 fixture patch；在 tip 上运行隔离路径、坏记录、回滚幂等/失败不替换等测试后再采纳；不接入生产启动路径 |
| macOS 假传输与演练测试 | `macLocalFakeTransport.ts`; `releaseDrill.test.ts` | 用 `CommandJournal` 演练同工作区三会话断线不重放、删除期间拒绝新会话、版本/回滚/未来字段负例 | **需复核** | tip 仍有 `CommandJournal.open`/`query`（`agent-host/commandJournal.ts`），但 release fixture 在 tip 不存在；PR 正文的 7 pass 是旧分支结果，不能替代 `426bdf7` 当前 API/构建验证 | 在 tip 新 worktree 运行 targeted test、typecheck、lint/architecture check；确认 `CommandJournal` 的 current/unknown/duplicate 语义与 40 次循环仍成立，再作为独立 patch |
| 版本锁定表 | `versionLock.ts` | 锁定 Model Gateway、Codex/Pi/Claude/ACP/ZCode、schema 和 wire 版本；部分值用源码正则测试 | **需复核** | 当前 tip 的现值仍匹配：`MODEL_GATEWAY_VERSION=0.3.0`、Pi `0.87.1`、Codex `0.157.1`、ACP `0.1.0`、V4 wire `3`、ZCode protocol `1`；但 Pi/Codex adapter version 是源码字面量，且没有当前 release 模块 | 先解决 PR base/parent 漂移，再决定是否保留源码正则锁定或改为稳定导出；在标准构建中验证锁定值随依赖/CLI 变更失败而非静默过期 |

### 结论

#16 不是应整分支合入的“发布完成”资产。它的隔离根目录、native/external 分类和回滚说明具有 M1 复用价值，文档与基础 helper 可小步采纳；假传输测试和版本锁定必须在 `426bdf7` 上重新运行并审查。即使这些测试通过，也只证明隔离 fixture 语义，不证明真实 macOS launchd 安装、安装包升级/回滚、真实 Provider、SSH 或 GUI。按 M1 标准，先处理 base/parent 漂移，再以 standalone patch 采纳可复用部分；不直接合并整条 `cursor/wave5-release-hardening-c3f2`。
