# Mac 实机恢复测试报告（补充验收）

日期：2026-09-28，时区 UTC+08:00。

**本次实际操作了 Mac 上的 Electron 窗口和退出菜单，使用 AxonHub 的 `deepseek-v4-flash` 触发真实任务和审批。三项恢复行为在诊断运行包下通过。原始分支的标准构建/启动仍失败，不能据此认定原始分支可直接发布。**

被测 checkout 为 `468ef1f`；该提交只增加首轮报告，业务源码仍为 `fc3222818595b9c751e04ce1b57005e16f034c12`。未提交任何业务代码修复。诊断包与原始构建的差异见下文。

## 实机结果

| 场景                                   | 诊断运行包结果 | 实测证据                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 关闭窗口后 Core 仍在                   | pass           | 审批等待时于 16:30:58 关闭窗口。16:30:48 测前及 16:31:12 测后均为 ready；Core PID 78444、generation 1 不变；serviceRegistered=true、launchd job 存在；runningTaskCount 均为 1。macOS 实现把普通窗口关闭转换为 hide，运行日志确认执行了该路径。                                                                                          |
| Electron 全退后任务继续且不重发 prompt | pass           | 16:33:18 通过应用菜单退出，16:33:19 退出完成；16:33:29 确认原 Electron PID 85197 已不存在。进度文件从退出前的 2 行继续增加至退出后的 8 行、12 行。16:33:49 重开；重连后 16:34:48 增至 24 行。全程 Core PID、generation 和 launchd job 不变，任务为 running。最终 36 行，状态 completed，无错误；任务的用户消息和已接纳输入均只有 1 条。 |
| 审批中断线仍是同一请求                 | pass           | 16:31:36 在待决审批上退出 Electron，16:31:46 确认 PID 81590 已不存在；重开后 16:32:38 仍是同一 requestId、同一待决命令。桌面仍显示“需要权限”，没有自动允许或拒绝。核验完成后才在 UI 选择“仅允许这一次”并确认。                                                                                                                          |

脱敏的状态、审批及命令证据见 [MAC-LIVE-EVIDENCE-2026-09-28.json](./MAC-LIVE-EVIDENCE-2026-09-28.json)。

### 任务与请求关联

- taskId：`sess_d7600cc4-6384-45d2-9978-30e7a8cbfef1`。
- commandId/inputId：`53c7a577-c552-4d54-8517-6bfccd780268`。
- 原生审批 requestId：`perm_f71a80bc-4545-4f99-8d25-e842004fabed`。此原生协议字段用于关联审批；未将其冒称为 Pi 的 interactionId。
- 完成后 `queryConversationCommandsV4` 仍返回原 commandId 的 accepted / inputAccepted / startNow 回执。命令回执描述接纳结果，任务快照另外确认 completed。
- 原生 `session_input` 中该会话只有 1 条输入，`admitted_sequence=0`，`promoted_sequence=0`；恢复前后用户消息数均为 1。执行期间文件按原顺序递增，最终为 36 行，没有重置或第二次执行。
- 重开后在桌面打开原任务，见到同一个执行中的工具调用；最终 UI 显示命令成功完成并写入 36 行。

## 测试方法与范围

环境为 macOS 27.0（26A428）、Electron 41.0.3、构建 Node 24.14.0/pnpm 10.33.2，发行运行时 Node 22.16.0。在独立的测试数据根和测试工作目录中运行现有 `server-cli serve --daemon`，实际注册 launchd，未设置跳过服务注册开关，未连接 Linux/SSH、Windows 或 WSL。

真实 Provider 使用用户授权的本机 AxonHub 配置。旧配置中的 `deepseek-v4-flash-vision-exp` 返回 model not found；通过服务的模型列表确认 `deepseek-v4-flash` 可用后执行成功。没有将密钥、Provider 地址或 prompt 正文放入本报告或证据文件。

通过产品公开 RPC 创建原生 ZCode 任务并提交一次请求，在真实桌面打开该任务，真实 DeepSeek 生成受审批控制的前台测试命令。该命令只在测试工作目录中每 5 秒写入并 flush 一行，共 36 行。窗口关闭、应用退出、重开及一次性审批均由桌面 UI 操作。后台用 status.json、launchd job、任务快照、命令查询和只读 SQLite 输入记录交叉核验。

本次通过范围是**原生 ZCode harness 的桌面恢复行为**，不是 Pi/Claude/Codex 全部 harness 的认证。原生 CLI 仍会按默认配置使用用户目录下的 CLI 数据库；仅查询本次明确的测试 session，未删除其他会话数据。

## 原始分支的阻断问题与诊断包差异

从当前 checkout 的标准入口实际尝试构建和启动时，依次暴露了以下问题。后续 pass 依赖诊断产物，不能掩盖这些失败。

1. **标准桌面 Agent 构建失败。** `node scripts/build-desktop-agent-cli.mjs` 在 `@zcode/core` 的两处 TS2322 停止：`context-history-entries.ts:11` 和 `target-completion-verification.ts:174`，原因是 ModelMessageRole 包含 developer，而消息历史类型不接受它。根目录 `pnpm typecheck` 的通过不覆盖这条 CLI 构建链。诊断运行使用编译器已经生成的 JS，再分别构建其余包；没有将标准构建记为通过。
2. **Agent 打包缺少子路径 alias。** `build:desktop-agent` 把 `@zcode/shared/agent-host` 错拼成 `packages/shared/src/index.ts/agent-host`。仅在仓库外的临时打包脚本中补充精确 alias，生成诊断 Agent bundle。
3. **Electron 主进程启动报错。** 标准生成物报 `Dynamic require of "tty" is not supported`。仅对诊断用的 main/host 生成物加入 ESM createRequire shim。
4. **发行 Core 的依赖版本冲突。** 打包后的 axios 1.13.6 导入了顶层 proxy-from-env 2.1.0，报缺少 default export。诊断运行目录为 axios 恢复了其锁定依赖 proxy-from-env 1.1.0 的私有副本。
5. **Core 的 ESM/CJS 启动错误。** 解决上一项后，Core 又报 `Dynamic require of "path" is not supported`（@vercel/oidc 链路）。仅给诊断 Core 生成物加入 createRequire shim。
6. **独立 scheduler 仍报 tty 动态 require 错误。** 没有修复该调度进程，三项测试没有依赖它，也不对定时任务作通过声明。
7. **Pi 会话创建未通过。** 使用真实登记的 workspace、workspaceId、worktreeGeneration 调用 create 时，约 8 秒后报 `ZCODE_FILE_LOCK_TIMEOUT`。栈涉及 workspace admission 内的 authorizeWorktree → revalidate → register；疑似同一工作区锁重入，需另行修复验证。未绕过工作区准入或权限控制，改测原生 ZCode 任务。
8. **旧历史接口契约不匹配。** 原生 `readSessionMessages` 返回中的 id/sessionID/part 字段与当前客户端 schema 不一致，触发 ZodError。验收改用公开 `getTaskSnapshot` 和 V4 命令查询，桌面任务可正常显示。

诊断改动均在 ignored 构建产物或测试运行目录中，未修改或提交业务源码。它们只用于继续观察恢复行为；当前分支仍需修复标准构建、启动和上述未通过路径后再做无临时修正的完整验收。

## 推送前同步的远端修复

测试期间远端新增 `067cddf`（缩短 macOS 过长控制 socket、规范化 mock worktree 路径）。提交报告前已保留该提交并将报告重放到其后。

在同步后的源码上，不再设置 `TMPDIR=/private/tmp`，实际运行下列三个测试文件：

```sh
pnpm exec tsx --test \
  packages/services/test/mockRuntimeDarwinWorktree.test.ts \
  packages/zcode-server-cli/src/runtime/paths.controlEndpoint.test.ts \
  packages/zcode-server-cli/src/server-core/runtimeLifecycle.integration.test.ts
```

结果为 **5 pass / 0 fail / 0 skipped**；同步后 `pnpm typecheck` 退出码 0，`pnpm lint` 仍为 3 errors / 84 warnings。说明首轮发现的临时目录问题已得到针对性修复。本文下半部分保留的首轮路径失败仅是历史记录。

本轮 Electron + DeepSeek 实机运行包仍基于 `468ef1f` 的业务源码；没有把此前实机观察冒称为 `067cddf` 重新打包后的实机验收。该远端提交未修改上文列出的 CLI 类型、alias、ESM/CJS、打包依赖版本或 Pi 准入锁问题。

## 清理观察

任务完成后退出测试 Electron，并显式 stop、卸载此次测试注册的 launchd job；确认 job 和原 Core PID 均不存在。清理后 status.json 仍残留 ready，CLI status 也回退返回该旧快照，随后重复 stop 返回失败。本次是在收到异步 stopping 回执后紧接着卸载 job，未等 stop 完成落盘，因此不将该现象判定为正常 stop 的产品缺陷；清理结果以 launchd 和进程核验为准。

## 日志与保留

完整日志、临时运行环境和首轮记录保留在测试执行者本机。仓库只提交本报告和脱敏证据，不提交配置、密钥、prompt 正文、原始本机路径或运行包。核心日志包括 `zcode-live-agent-build.log`、`zcode-live-agent-bundle.log`、`zcode-live-electron-original-startup-failure.log`、`zcode-live-core-fatal.log`、`zcode-live-core-fatal-2.log`、`zcode-live-electron-real.log`、`zcode-live-electron-approval-reopen.log`、`zcode-live-electron-running-reopen.log`。

---

# 首轮自动测试记录（历史结果）

日期：2026-09-28

- 仓库：https://github.com/betacatsling/ZCode
- 分支：`cursor/mac-live-recovery-gated-3d50`
- 被测提交：`fc3222818595b9c751e04ce1b57005e16f034c12`
- 环境：macOS 27.0（26A428），Node 24.14.0，pnpm 10.33.2。
- 测试过程中未修改源代码；本报告作为独立文档提交。

## 结果

| 检查                                                  | 结果                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| 分支新鲜度                                            | 与远端指定分支同步；单分支克隆未取得 origin/main，因此未比较 main 距离 |
| 锁定版本依赖安装                                      | 通过                                                                   |
| 内部依赖构建 `pnpm --filter @zcode/adapters... build` | 通过                                                                   |
| `pnpm typecheck`                                      | 补齐内部包构建后通过，退出码 0                                         |
| `pnpm lint`                                           | 失败：3 errors，84 warnings                                            |
| 新增测试文件单独 lint                                 | 通过，0 errors / 0 warnings                                            |
| 相关自动测试                                          | 分批及排障重测后，共 28 个不同用例通过、3 个跳过；并非全仓库测试       |
| 真实 Electron + launchd + Provider 恢复               | 首轮未执行；后续实机结果见本文开头                                     |

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

## 首轮自动测试的实机验收限制

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
