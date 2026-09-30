# Claude Code harness adapter

计划来源：`ZCode_Multi_Harness_Refactor_Plan_v0.3_Orca_Hierarchy.md` 第 6 节 P5。本文件只声明 Host 侧能力诚实边界。不修改 Claude turn 生命周期，不把本 adapter 接到共享 `TargetModelGateway`。

## 所有者

- `claudeHarnessCapabilities()` 是唯一能力声明所有者。`ClaudeHarnessAdapter.capabilities()` 原样返回该对象。
- SessionHost 可以把字段拷进 `BindingPlan.capabilities`，但 **不得** 在 `probe` 或 `hostManagedSupport` 为 `supported` 时升级它们。
- 轮次、审批、原生 `session_id` 与 Messages 流仍由既有 runtime 拥有。本切片不改那些路径。

## 诚实能力

| Field             | `support`      | Reason must say                                                                                                                     |
| ----------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `text`            | `experimental` | pinned Claude Code CLI 2.1.263 and a loopback FakeModel only                                                                        |
| `tools`           | `experimental` | pinned Claude Code CLI 2.1.263 and a loopback FakeModel only                                                                        |
| `approvals`       | `experimental` | pinned Claude Code CLI 2.1.263 and a loopback FakeModel only                                                                        |
| `cancelTurn`      | `experimental` | pinned Claude Code CLI 2.1.263 and a loopback FakeModel only                                                                        |
| `history`         | `experimental` | pinned Claude Code CLI 2.1.263 and a loopback FakeModel only                                                                        |
| `resumeExecution` | `unsupported`  | cold attach / opaque native `session_id` resumes saved history only; Host `resumeExecution` never replays uncertain in-flight turns |
| `images`          | `unsupported`  | names the `images` surface (structured send is text only)                                                                           |
| `modelSwitch`     | `unsupported`  | names the `modelSwitch` surface (no in-turn model switch)                                                                           |

五个 `experimental` 字段共用一句：`Verified only through the pinned Claude Code CLI 2.1.263 and a loopback FakeModel.` 三个 `unsupported` 字段各自点名自己的表面，原因互不相同。

可选键 `detach`、`terminateSession`、`viewHistory`、`hostManagedModel` **省略**（`undefined`）。省略表示未广告，不是 `supported`。本切片不因为 FakeModel fixture 把 `hostManagedModel` 声明成 `experimental` 或 `supported`。

**probe `supported` ≠ 全能，也 ≠ 升级 capabilities。** CLI 版本探针通过只说明 pinned `2.1.263` 可执行文件回答了 `--version`。probe 的 `reason` 必须写明它不认证 `tools`、`approvals`、`history`、`resumeExecution`、`images`、`modelSwitch`。不得据此把上表字段抬成 `supported`，也不得当作真实 Provider 已认证。

**`hostManagedSupport` 的 FakeModel `supported` 不升级 capabilities。** 精确 fixture 只承认本地 Messages 控制面证据；`claudeHarnessCapabilities()` 仍是上表。fixture 不会补上被省略的 `hostManagedModel`，也不把 `experimental` / `unsupported` 改成 `supported`。没有 fixture 的选择保持 `experimental`，同样不升级能力表。

**cold attach / 原生 `session_id` ≠ Host `resumeExecution`。** `attach` 只按已保存的 opaque native id 接上会话并等待新的 Host 输入，不重放不确定的 in-flight turn。这不是 `resumeExecution`。

## 不在本声明里

- 不实现新工具，不改 pinned CLI 版本，不扩 Messages/Responses 协议。
- 不把 Claude 接到共享 `TargetModelGateway`。
- 不把 loopback FakeModel 写成 live Provider 认证。
