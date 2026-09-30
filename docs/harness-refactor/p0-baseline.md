# P0 基线证据（2026-09-28）

本次只记录当前检出的行为与检查结果。没有修改 `packages/**` 或 `apps/**`，没有移动任何产品目录，没有读取或写入日常会话与凭据。

计划对照：`ZCode_Multi_Harness_Refactor_Plan_v0.3_Orca_Hierarchy.md` 第 6 节 P0、第 11 节、第 12.6 节、附录 A。许可清单见 [codexhost-license-inventory.md](./codexhost-license-inventory.md)。脱敏样本见 [fixtures/](./fixtures/)。

## 1. 源码与工具链

| 项                    | 记录                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 本次检出              | `30e8d0a76a73d74bc8647526c04cd94b9b44cf71`（`main`，与 `origin/main` 同步，ahead 0 / behind 0）                                                                                                                                |
| 计划附录引用的 commit | `328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f` 仍在对象库中。下文链路按本次 HEAD 源码核对，两份 commit 不混称同一基线                                                                                                              |
| 产品版本              | 根 `package.json` `3.14.3`，许可 `Apache-2.0`                                                                                                                                                                                  |
| CLI 包版本            | `apps/zcode-cli` `0.16.9`                                                                                                                                                                                                      |
| `mise.toml`           | Node `24.14.0`，pnpm `10.33.2`。本机 `mise` 不在 PATH                                                                                                                                                                          |
| 默认 shell Node       | `/exec-daemon/node` `v22.14.0`。nvm 默认是 `v22.22.2`                                                                                                                                                                          |
| 本次检查使用的 Node   | nvm 安装并显式放到 PATH 前面的 `v24.14.0`（`/home/ubuntu/.nvm/versions/node/v24.14.0`）                                                                                                                                        |
| pnpm                  | `10.33.2`（corepack 按根 `packageManager` 激活）                                                                                                                                                                               |
| TypeScript            | 声明 `^6.0.2`，安装结果 `6.0.2`                                                                                                                                                                                                |
| oxlint                | 声明 `^1.57.0`，安装结果 `1.60.0`                                                                                                                                                                                              |
| Electron              | `packages/desktop` 精确依赖 `41.0.3`；`./node_modules/.bin/electron --version` 输出 `v41.0.3`                                                                                                                                  |
| Git                   | `git version 2.43.0`（`/usr/bin/git`）。`git worktree list --porcelain -z` 退出码 0，输出为 NUL 分隔，机器可解析                                                                                                               |
| OpenSSH 客户端        | `OpenSSH_9.6p1 Ubuntu-3ubuntu13.16`。本次没有发起 SSH 连接                                                                                                                                                                     |
| 操作系统              | Ubuntu 24.04.4，Linux `6.12.94+`，x86_64                                                                                                                                                                                       |
| React                 | 根 pnpm override `19.2.7`                                                                                                                                                                                                      |
| 模型适配声明          | `apps/zcode-cli/packages/adapters`：`ai` `6.0.193`，`@ai-sdk/anthropic` `3.0.81`，`@ai-sdk/openai` `^3.0.58`，`@ai-sdk/openai-compatible` `^2.0.58`；根补丁固定 `@ai-sdk/openai-compatible@2.0.60`、`@ai-sdk/anthropic@3.0.81` |
| zod                   | `4.6.5`（adapters 与 services 声明）                                                                                                                                                                                           |
| Pi SDK                | `@earendil-works/pi-ai` 与 `@earendil-works/pi-coding-agent` 均为 `0.87.1`（`packages/services`）                                                                                                                              |
| ssh2                  | `packages/desktop` 声明 `^1.16.0`。安装日志：optional crypto binding 编译成功                                                                                                                                                  |

`node scripts/check-workspace-freshness.mjs`：基线新鲜，相对 `origin/main` ahead 0 / behind 0。

独立数据目录：`$HOME/.zcode`、`$HOME/.zcode-dev-home`、`$HOME/.zcode-multi-harness-dev` 在检查开始时都不存在。桌面进程没有启动，因此没有创建 `ZCODE_DATA_BASE_DIR`。Git 能力样本写在 `/tmp/zcode-p0-git-samples`。`packages/services/test/worktree.test.ts` 使用系统临时目录并自行清理。

## 2. 原生 UI → V4 → runtime → model

当前原生会话的所有者是每个 workspace 一条的 CLI runtime。Renderer 持有传输与投影，Host 负责进程、可信连接位和 workspace 准入戳。

```text
窗口 WorkspaceTab
  workspaceConnectionRegistry
    ConversationTransport（packages/ui/src/v4/transport.ts）
      createAgentConversationTransport
        IZCodeAgentService.sendConversationCommandV4
          Host：Account Config 屏障、去掉调用方 workspaceAdmissionGeneration、
                按当前 Worktree 代际重戳、desktop-continuous 才保留本地 TTFT
          stdio RPC：V4 command
            ZCodeAgentProcessManager（按 workspaceKey 一进程）
              CLI CommandInbox 串行 admission
                createSession → createSessionRecord
                sendText / firstInput → startPromptTurn
                  Core admission
                    ApiProviderModelRuntime.modelFactory
                      Registry 校验 selection
                      AiSdkModelAdapter.createModel
                        Model.generateText / streamText
        下行 conversation topic frame
          ConversationProjectionStore
            snapshot 整帧替换；delta 必须序号连续；断档重订阅
```

命令形状以 `packages/shared/src/zcode-protocol-v4/command.ts` 为准，本次对照过 `createSession`、`sendText`、`stop`、`resolveInteraction`。脱敏形状在 `fixtures/v4-command-shape.json`，那是 schema 摘录，不是一次真实回合。

进程启动顺序在 `resolveDefaultZCodeAgentCommand`：环境变量覆盖，然后 monorepo 源码/dist，然后桌面 Electron Node 跑打包的 `zcode.cjs`，然后已部署的 native binary。远端 SSH/WSL 没有 Electron，会跳过 Electron Node 这条。子进程 `cwd` 使用 `workspacePath`。

模型工厂在 `apps/zcode-cli/packages/bootstrap/src/app/provider-registry-model-runtime.ts`。统一 `Model` 接口在 `apps/zcode-cli/packages/adapters/src/model/model.ts`，流式消费在 `apps/zcode-cli/packages/core/src/runtime/methods/model.ts`。Agent provider 枚举仍只有 `glm`（`packages/shared/src/providers.ts`）。`normalizeAgentProviderToZCodeAgent` 固定返回该值。`renderProviderCliIcon` 忽略入参并返回 GLM 图标。

`packages/services/src/node.ts` 里 `allowNewSessions` 读取 `ZCODE_MULTI_HARNESS_ENABLED === "1"`。持久 SSH 启动命令会带上这个变量（`packages/server/src/remote/connect.ts`）。该开关只表示新的外部会话准入，原生 V4 CommandInbox 仍由 CLI 持有。

## 3. SSH 链路

```text
Desktop window Host setupRemoteConnection
  createRemoteBackend(target.kind=ssh)
    读取 privateKeyPath 指向的密钥文件（本次未调用）
    SSHBackend：detect / upload / exec / exists / readFile / openLocalPortForward
  connectRemote
    detect() → platform + arch
    具备 openLocalPortForward 时走 connectPersistentSSH：
      远端打印 ZCODE_DATA_BASE_DIR 或 $HOME
      有版本化 runtime 包则上传到 <data>/.zcode/server/releases 并安装
      否则要求已有 <data>/.zcode/server/bin/zcode
      执行 serve --daemon --json，并设置
        ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1
        ZCODE_MULTI_HARNESS_ENABLED=1
      解析 127.0.0.1 端口
      SSH direct-tcpip 转到本机，再连常驻 Server
    没有 openLocalPortForward 时（WSL、Docker，以及不提供该能力的调用方）：
      deployServer → exec 前台 zcode-server → stdio handshake → ChannelClient
  onDidDisconnect / stream close 上报给 Host
  远端 workspace 上的 Agent 仍由该目标上的 ZCodeAgentProcessManager 按 workspaceKey 启动
```

`IRemoteBackend.exec()` 返回的是当前连接上的 stdio。持久 SSH 路径把生命周期放在远端 `serve --daemon`。两条路径都还没有在本环境做过断线后续跑实测。GUI 退出或 SSH 断开后任务是否继续，本次没有证据。

## 4. tab → workspace → session 与 cwd

```text
每个窗口一个 tab store（不跨窗口广播）
  WorkspaceTabState
    workspacePath          文件操作与 Agent cwd
    workspaceIdentity      可空；远程身份
    remoteSessionId        可空；当前连接实例
    remoteTarget           可空
  匹配 isSameWorkspaceTab
    路径必须相同
    调用方给了 workspaceIdentity → 再比 identity
    否则给了 remoteSessionId → 再比 remoteSessionId
    否则只匹配没有远程身份的本地 tab
  持久化 useTabPersistence
    没有 remoteSessionId 的本地 tab 写入 settings.lastWorkspaceSession

workspaceKey = workspaceIdentity.trim() 或 workspacePath
  task index：workspaceKey + taskId
  sessions index：一条 workspace 连接上的 sessionId → SessionSummary
  Agent 进程表：同一个 workspaceKey 一个进程

会话不存放在 tab 里。tab 是窗口里的工作区视图。
一个工作区的 sessions index 可以有多个 session。
```

侧栏 `projectSidebarViewStore` 保存展开、隐藏和当前选中，属于 UI view state。Project Catalog、Worktree 目录和 SessionHost manifest 是另外的所有者。原生任务内容仍在 CLI / task index。

Agent `cwd` 是 `workspacePath`。远程 identity 里的 path 段由 `parseRemoteWorkspaceIdentity` 还原为远端路径，供远端 CLI 做工作目录。Host、Main 和 UI 使用 `buildRemoteWorkspaceIdentity`，格式为 `remote:ssh:<host>:<port>:<username>:<posixPath>`。

## 5. 旧数据到三级实体的映射

本阶段不创建、不移动、不改写产品目录。下表是现有事实到计划中 Project / WorktreeWorkspace / AgentSession 的对应，供后续迁移使用。

| 现有事实        | 本次观察                                                                                                                                                                              | 映射                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 主检出          | `/tmp` 样本 `.git` 是目录；`rev-parse --git-common-dir` 为 `.git`；分类 `main-tree`                                                                                                   | 一个目标上的 RepositoryBinding，对应 WorktreeWorkspace `isMainWorktree=true`。tab 标签只是路径末段，不能当成 Project |
| linked worktree | `.git` 文件指向 `<main>/.git/worktrees/linked`；common dir 是主库 `.git`；分类 `linked-worktree`                                                                                      | 同一 RepositoryBinding 下的另一个 WorktreeWorkspace。cwd 是 worktree 根，不是主检出根                                |
| 非 Git          | `git rev-parse` 退出 128；发现结果 `nonGit` / `not-git`；分类 `not-repository`                                                                                                        | 没有 RepositoryBinding。记录保持待核实。发现逻辑不会为了分类去 `git init`                                            |
| 离线 SSH        | 客户端存在。本次没有目标、没有登录、没有上传                                                                                                                                          | 已保存的 `remote:ssh:` identity 不能在离线时改写成“全部停止”。本次也没有这样的持久记录                               |
| 同路径不同主机  | 身份样本里 `/opt/sample/app` 在 `host-a.example.invalid` 与 `host-b.example.invalid` 上的 key 不同。`worktree.test.ts` 有同路径、不同 target、不按 origin 合并的用例，24 项里该项通过 | 两个 WorktreeWorkspace，各自带 execution target。禁止只按 `workspacePath` 合并会话                                   |

`packages/services/src/git/repo/gitCliRepo.ts` 在 `.git` 缺失、权限失败或非常规布局时会把分类放成 `main-tree`。这是现有迁移过滤的 fail-open，和 `discovery.ts` 对 `rev-parse` 失败返回 `nonGit` 是两条路径。后续验收要分别引用，不能合成一个结果。

## 6. 检查结果

证据分成四列：源码存在、测试文件存在、本次测试已运行、真实环境通过。

| 对象                              | 源码存在                                                                                    | 测试文件存在                                         | 本次测试已运行                                                                                                       | 真实环境通过                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 原生 V4 命令与投影                | 是。transport、agent service、CommandInbox、projection store 均在 HEAD                      | 是。仓库内有 V4 / conversation 测试文件              | 否。没有按包入口跑完整 V4 套件                                                                                       | 否。没有新建、发送、工具、停止、审批、恢复                     |
| UI→Host→CLI→Model 链路            | 是。第 2 节所列文件                                                                         | 部分集成测试存在                                     | 否。没有端到端跑通                                                                                                   | 否。没有模型请求                                               |
| Git 分类与 worktree 目录          | 是。`git.ts`、`gitCliRepo.ts`、`discovery.ts`、`porcelain.ts`                               | 是。`packages/services/test/worktree.test.ts`        | 是。`pnpm exec tsx --test packages/services/test/worktree.test.ts`：24 pass / 0 fail，约 31.7s                       | 仅限本机临时目录。没有远端 Git，没有 50 个 worktree 的产品场景 |
| 同路径不同 target                 | 是。identity 与 worktree catalog                                                            | 含在上面的 worktree 测试中                           | 是，见该测试中 “same path on separate targets is isolated”                                                           | 否。没有两台主机                                               |
| 非 CLI ACP 退役（services）       | 是。`packages/services/test/nonCliAcpRetirement.test.ts`                                    | 是                                                   | 是。5 pass。日志里的 workspace 是 `/example/workspace`                                                               | 否                                                             |
| 非 CLI ACP 退役（UI）             | 文件在 `packages/ui/test/nonCliAcpRetirement.test.ts`                                       | 是                                                   | 未执行断言。`tsx --test` 加载失败：`Cannot find package '@/lib'`。这是本次命令没有带上 UI 路径别名，不能写成断言失败 | 否                                                             |
| SSH detect/upload/exec/持久 serve | 是。`ssh-backend.ts`、`connect.ts`、`packages/desktop/src/host/index.ts`                    | 存在 `ssh-backend.persistent.integration.test.ts` 等 | 否                                                                                                                   | 否。没有 SSH 登录、上传或远端命令                              |
| 桌面 Electron 会话                | 源码与 Electron `v41.0.3` 二进制存在                                                        | 存在桌面测试文件                                     | 否                                                                                                                   | 否。`pnpm dev:desktop:test` 未运行                             |
| CodexHost 参考树                  | 是。GitHub commit `d9fa7aa26474127bb80cbf086cd49503f7cc4ccf` 的 tree API 能列出计划中的文件 | 该 commit 的 tree 中有对应 `test/`                   | 否。没有克隆，也没有跑它的测试                                                                                       | 否                                                             |
| `@zcode/core` 构建                | 源码存在                                                                                    | 构建即类型检查                                       | `pnpm --filter @zcode/cli... build` 退出码 2                                                                         | 不适用。构建失败，没有运行产物                                 |

### 已运行命令

| 命令                                                                     | 结果                                                                                                                                                                                                                                                                          | 归类                                   |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `node scripts/check-workspace-freshness.mjs`                             | 新鲜，ahead 0 / behind 0                                                                                                                                                                                                                                                      | 通过                                   |
| `pnpm install --frozen-lockfile`（Node 24.14.0）                         | 退出码 0，22.2s。警告：`packages/desktop` 的 `zcode` bin 指向尚不存在的 `server-cli.js`；`@google/genai@2.21.0` 的构建脚本被忽略。ssh2 crypto、node-pty、electron postinstall 完成                                                                                            | 安装完成，带警告                       |
| `pnpm typecheck`（install 后、CLI 声明发出前）                           | 退出码 2。`@zcode/contracts`、`@zcode/adapters/model` 没有声明文件                                                                                                                                                                                                            | 环境前置缺失后的失败                   |
| `pnpm typecheck`（contracts/adapters 等已由失败的 CLI 构建发出声明之后） | 退出码 0                                                                                                                                                                                                                                                                      | 通过。依赖前面的部分构建产物           |
| `pnpm lint`                                                              | 退出码 1。3 个 error、84 个 warning。error 都是 `eslint(max-lines)`：`packages/server/src/remote/connect.ts`（538）、`packages/services/src/agent-adapters/claude/claudeHarnessAdapter.ts`（583）、`packages/ui/src/project-sidebar/ProjectSidebarAgentCreateForm.tsx`（459） | 基线失败。本次未改这些文件             |
| `pnpm architecture:check --changed`                                      | 退出码 0。violations 0，baseline 0，new 0                                                                                                                                                                                                                                     | 通过。当时工作区相对 HEAD 没有产品改动 |
| `pnpm --filter @zcode/cli... build`                                      | 退出码 2。`@zcode/core`：`ModelMessageRole` 含 `"developer"`，`message-history.ts` 的 `ModelInputMessage.role` 只有 `"system" \| "user" \| "assistant" \| "tool"`。失败位置：`context-history-entries.ts`、`target-completion-verification.ts`                                | 基线构建失败                           |
| worktree 测试                                                            | 24/24 通过                                                                                                                                                                                                                                                                    | 确定性测试通过                         |
| services `nonCliAcpRetirement`                                           | 5/5 通过                                                                                                                                                                                                                                                                      | 确定性测试通过                         |
| UI `nonCliAcpRetirement`                                                 | 文件加载失败，断言未跑                                                                                                                                                                                                                                                        | 本次运行方式不适用，未运行             |
| `/tmp` Git 样本                                                          | 主检出、linked worktree、非 Git、`porcelain -z` 均按第 5 节记录                                                                                                                                                                                                               | 本机 Git 能力通过                      |

### 未运行

| 项                                                       | 原因                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm bootstrap`                                         | 未运行。`pnpm install` 已完成依赖安装；bootstrap 还会准备桌面资源并 `build:bootstrap` |
| `pnpm bootstrap:with-remote`                             | 未运行。没有远程资源验收                                                              |
| `ZCODE_DATA_BASE_DIR=... pnpm dev:desktop:test`          | 未运行。没有桌面会话                                                                  |
| 原生新建、发送、工具调用、停止、审批、恢复               | 未运行。没有模型账号，也没有启动 Agent                                                |
| 至少一次 SSH 实际执行                                    | 环境缺失。有 ssh 客户端，没有授权目标，没有上传或执行                                 |
| 离线 SSH 重连后的会话状态                                | 未运行                                                                                |
| `pnpm fmt:check`、`pnpm knip`、CLI 自身 `typecheck` 脚本 | 未运行                                                                                |
| CodexHost 构建与测试                                     | 未运行                                                                                |
| 真实环境的模型路由、GUI 退出后续跑、SSH 断开后续跑       | 未通过，也未运行                                                                      |

上面任一未运行项都不能记成通过。`@zcode/core` 构建失败是源码类型不一致，归为基线失败。SSH 与桌面生命周期归为环境缺失或未运行。
