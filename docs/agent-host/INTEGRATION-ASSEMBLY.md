# 整合基线与分支处置

## 本轮交付范围

先整合已有成果、清理状态文档和定位真实 gap；不继续增加功能，不启用未认证 Harness，不调用付费模型，不部署/重启现有 SSH 服务。

- 原工作目录：`main@438c257`，已有未提交改动保留。
- 已有汇总：`goal/5be7ed74-convergence-assembly@8d5d32b`，相对 main 多 309 个提交（含合并/文档，不是 309 个已验收功能）。
- 本轮候选：`work/multi-harness-completion`，目录 `.worktrees/multi-harness-completion`，从 `8d5d32b` 创建。
- 本轮在候选树整理文档；**尚未合入 main、尚未发布**。原分支、脏 worktree、用户配置均未删除或覆盖。

107 个 `goal/5be7ed74-*` 分支进行了 Git 等价性盘点；重点项有源码/patch-ID 核对。非重点分支不是全部语义审计通过。`git branch --no-merged` / `git cherry +` 不能独自证明源码未合入：早期成果大量通过 cherry-pick、拆分提交或后续替代整合。

## 重点处置表

| 来源 | 核对事实 | 本轮决定 |
|---|---|---|
| convergence-assembly `8d5d32b` | 最新现有汇总，包含 Core、层级、UI、适配器、恢复及多类测试 | 作为候选基线，不从旧主目录重新实现 |
| protocol-compat 脏树 | 16 个脏/未跟踪文件与 `268c997` 捕获内容相同；该提交等价于汇总内 `0a6b4dc` | **不再合入**；它是 WIP，后续 `af6a64a` / `5b1e8a8` 已改进 developer/cache/private-state 语义，回灌会回退 |
| model-runtime 已提交部分 | 5 个分歧提交均有等价 patch，例如 `7bd755a` → `54592c4` | 已整合，不重复 cherry-pick |
| model-runtime 未提交测试 | `openai-developer-role.test.ts` 多一条“顶层 instructions 与两个 system 消息冲突”拒绝断言 | 原处保留，TASKS I-02 单独评审；不是缺失模型 runtime |
| pi-portable-mount | `a14dd4b` / `1e62cb6` 的源码 patch 分别等价于 `75318e1` / `579e96a`；`284358d` 又更新父进程 effect 所有权 | 已整合/被替代，不能从旧 tip 恢复 worker-only 清理 |
| native-private-final | 前置 `5e96141` 等价于 `096db29`；`d7b6f7b`、`8d06d09`、`b82107b`、`6d84856` 的部分安全 runner/usage/权限身份改动确实缺失 | **待独立复核** I-03/I-04；不整支合并，不把历史 synthetic 报告当当前验收 |
| brand-assets | `ab5d7d4` / `eac1584` 的 Pi PNG 与 provenance/validator 不在候选内；分发授权仍待确认 | **暂不导入品牌图像**，保持中性 fallback；验证器代码与资产授权分别审查 |
| 旧 `.tmp` 报告 | 阶段报告混合互相覆盖的“当前状态”，部分外部日志已不存在 | 移到不可变 [archive](../archive/multi-harness/README.md)，当前结论统一到 ACCEPTANCE |

以上是处置清单，不是未审改动的合并许可。尤其不能为了得到“已整合”状态盲合 protocol WIP 或未获授权图像。

## 当前装配已经存在

旧版本文描述的“仅导出、不挂载、必须等待缺失 Core 工厂”已过期：

- `packages/services/src/coreAuthority.ts` 已提供 Core authority。
- `workspace-hierarchy/lazyComposition.ts` 装配真实 Catalog、Target admission、Host、hierarchy 和维护栅栏。
- `packages/desktop/src/host/targetCoreMount.ts` 将 Core 服务挂入现有 window Host，而非复制可写业务所有者。
- `packages/ui/src/app-shell/WorkspaceShellLayout.tsx` 已有 hierarchy/owner 路由；Native 新建与桌面 Core 接入仍受专门门控。
- `actualShellReadonlyJoin.spec.ts` 等 joined E2E 已存在；源码存在/历史运行不等于正式启用及完整产品认证。

```text
Project Catalog（元数据） → Target（Git / generation / admission）
                                  ↓
                     Core maintenance / owner fence
                        ├─ Native CLI CommandInbox / SQLite
                        └─ External SessionHost / journals → adapter
Desktop continuous ─────┐
Mobile replayable ───────┴─ 同一 owner，经 facade/projector 形成只读 UI 视图
```

共享协议、owner/lease、工作区代际和 accepted queue 不因文档清理改变。完整当前差距见 [ACCEPTANCE](ACCEPTANCE.md)，独立工作包见 [TASKS](TASKS.md)。
