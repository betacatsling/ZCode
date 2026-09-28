# ZCode 分支测试报告

日期：2026-09-28

- 仓库：https://github.com/betacatsling/ZCode
- 分支：`cursor/mac-live-recovery-gated-3d50`
- 被测提交：`fc3222818595b9c751e04ce1b57005e16f034c12`
- 环境：macOS 27.0（26A428），Node 24.14.0，pnpm 10.33.2。
- 测试过程中未修改源代码；本报告作为独立文档提交。

## 结果

| 检查 | 结果 |
| --- | --- |
| 分支新鲜度 | 与远端指定分支同步；单分支克隆未取得 origin/main，因此未比较 main 距离 |
| 锁定版本依赖安装 | 通过 |
| 内部依赖构建 `pnpm --filter @zcode/adapters... build` | 通过 |
| `pnpm typecheck` | 补齐内部包构建后通过，退出码 0 |
| `pnpm lint` | 失败：3 errors，84 warnings |
| 新增测试文件单独 lint | 通过，0 errors / 0 warnings |
| 相关自动测试 | 分批及排障重测后，共 28 个不同用例通过、3 个跳过；并非全仓库测试 |
| 真实 Electron + launchd + Provider 恢复 | 未执行，不能认定通过 |

## 自动测试范围和执行记录

所有命令均在仓库根目录运行，使用上述固定工具版本。

首轮测试：

```sh
pnpm exec tsx --test \
  packages/server/src/remote/liveRecovery.gated.test.ts \
  packages/server/src/remote/persistentTargetClient.test.ts \
  packages/zcode-server-cli/src/server-core/runtimeLifecycle.integration.test.ts \
  packages/zcode-server-cli/src/server-core/taskActivityTracker.test.ts \
  packages/zcode-server-cli/src/server-core/externalTaskActivity.test.ts \
  packages/zcode-server-cli/src/runtime/installationOwnership.test.ts \
  packages/services/test/agentHostRecoveryFence.test.ts \
  packages/services/test/commandJournalRestartStress.test.ts \
  packages/services/test/agentHostJournal.test.ts \
  packages/services/test/agentHostSession.test.ts \
  packages/services/test/agentHostConcurrency.test.ts
```

首轮结果：25 pass、2 个测试文件加载失败、3 skipped。两个文件均因内部包 `@zcode/adapters/model` 尚未构建而加载失败。

构建依赖后重测：

```sh
pnpm --filter @zcode/adapters... build
pnpm exec tsx --test \
  packages/zcode-server-cli/src/server-core/runtimeLifecycle.integration.test.ts \
  packages/zcode-server-cli/src/server-core/externalTaskActivity.test.ts
```

结果：externalTaskActivity 的 2 个用例通过；runtimeLifecycle 在 macOS 默认临时目录下失败，错误为 `listen EINVAL`，发生于创建 `server/run/control.sock`。

将临时目录改为 `/tmp` 后，Core 可以启动，但因 `/tmp` 与其真实路径 `/private/tmp` 不一致，测试 fixture 的授权校验失败，报 `unauthorized execution target or worktree`。

最终重测命令：

```sh
TMPDIR=/private/tmp pnpm exec tsx --test \
  packages/zcode-server-cli/src/server-core/runtimeLifecycle.integration.test.ts
```

结果：1 pass、0 fail。该用例实际启动独立 Core 进程，验证客户端断开后的任务活动、审批 identity 保留、重复 send 被拒绝为 duplicate、崩溃后恢复为 execution-unknown 以及显式停止。它使用 Mock Harness，不代表真实 Electron 和 Provider 实机验收。

## 已确认问题

1. **Mac 默认环境下恢复集成测试不能直接通过。** 默认临时目录导致通信 socket 路径过长而报 EINVAL；较短且规范化的 `TMPDIR=/private/tmp` 可以通过。普通 `/tmp` 仍触发 fixture 的 realpath 严格比较问题。相关位置为 `packages/zcode-server-cli/src/server-core/runtimeLifecycle.integration.test.ts:127`、`packages/zcode-server-cli/src/runtime/paths.ts:43`、`packages/services/src/agent-host/mockRuntime.ts:32`。
2. **全仓库 lint 不通过。** 三项均为文件超过 400 行限制：
   - `packages/ui/src/project-sidebar/ProjectSidebarAgentCreateForm.tsx`：459 行。
   - `packages/services/src/agent-adapters/claude/claudeHarnessAdapter.ts`：583 行。
   - `packages/server/src/remote/connect.ts`：538 行。
   这三个文件在被测提交 `fc32228` 与其父提交之间没有变化；并非此次新增 Mac 测试文件引入。

## Mac 实机验收限制

新增的 `liveRecovery.gated.test.ts` 三项均使用 `skip` 注册。即使配置齐全，代码也仍会返回“未观察”的跳过理由。它是实机验收登记，不是自动实机恢复测试。

本机检测到 Darwin 和图形会话，但未设置 `ZCODE_LIVE_ELECTRON_EXECUTABLE`、`ZCODE_LIVE_PROVIDER_API_KEY`，实际结果为：

- 窗口关闭后 Core 仍在：skipped。
- Electron 全退后任务继续且不重发 prompt：skipped。
- 审批中断线仍是同一请求：skipped。

未进行真实 Provider 请求，未执行 Electron 关闭/重开验收，未连接远端。实机操作标准位于仓库 `docs/harness-refactor/MAC-TEST.md`。

## 日志

以下原始日志仅保存在测试执行者本机，未纳入仓库；其中包含本机绝对路径和运行时地址。复现命令及结论已记录在上文：

- `zcode-branch-install-pinned.log`：依赖安装。
- `zcode-branch-build-deps.log`：内部包构建。
- `zcode-mac-gated.log`：Mac gated 测试。
- `zcode-branch-recovery-tests.log`：首轮自动测试。
- `zcode-branch-recovery-retest.log`：构建后重测及默认临时目录失败。
- `zcode-branch-recovery-short-tmp.log`：`/tmp` 路径校验失败。
- `zcode-branch-recovery-canonical-tmp.log`：`/private/tmp` 恢复集成测试通过。
- `zcode-branch-typecheck-retest.log`：最终类型检查通过。
- `zcode-branch-lint.log`：全仓库 lint 错误详情。
- `zcode-branch-changed-lint.log`：新增文件 lint 通过。
