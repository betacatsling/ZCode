# 多 Harness 重构暂停检查点

更新时间：2026-09-28。用户明确要求暂停工作并提交可恢复检查点。本次只记录状态和验证结果；没有继续实现、修复产品、重跑真实模型验收或启动其他重构。此检查点是明确的 WIP，完整计划尚未完成，不得据此勾选 P0–P6 或整体验收通过。

## 恢复入口

先读根计划 [ZCode 多 Harness 重构计划 v0.3](../../ZCode_Multi_Harness_Refactor_Plan_v0.3_Orca_Hierarchy.md)，再读本目录的 [总契约](./CONTRACT.md)、[验收门槛](./ACCEPTANCE.md)、[实现现状](./IMPLEMENTATION.md)、[Live 环境边界](./LIVE-ENVIRONMENT.md) 和 [Live 认证记录](./LIVE-CERTIFICATION.md)。UI 恢复时还要读 [Agent creation history spec](../specs/agent-creation-harness-history.md)。按具体恢复切片再看 [Runtime Host](./RUNTIME-HOST.md)、[会话迁移](./SESSION-MIGRATION.md)、[Workspace Admission](./WORKSPACE-ADMISSION.md)、[Project Catalog](./PROJECT-CATALOG.md)、[Worktree](./WORKTREE.md)、[侧栏](./PROJECT-SIDEBAR.md)、[Codex](./CODEX-HARNESS-ADAPTER.md)、[Claude](./CLAUDE-CODE.md) 与 [Responses Gateway](./MODEL-GATEWAY-RESPONSES.md)。共享契约和模块 contract/example 是实现的接口依据；不要把旧报告中的局部通过扩展成当前全树或真实 Provider 通过。

本次开始时 `main` 位于 `438c25720b7c922b7902b4c5de182b5804720bb8`，相对 `origin/main` ahead 2。三个执行 CLI 已由 root 精确 SIGINT，terminal 均确认 exit 1：persistent-target（PID 110493 / session 3022）、claude-messages（PID 2913662 / session 26166）、agent-creation-ui（PID 404543 / session 30300）。它们没有重启；暂停检查未发现仍运行的对应测试进程，也未清理或终止其他用户进程。

## 三个中断切片

### Persistent target / P4

Desktop 窗口 Host 正在改为附着既有持久 Supervisor/Core，SSH 持久连接与安装打包仍在 WIP。当前源码复核确认一个未解决的信任边界：[Core HTTP](../../packages/zcode-server-cli/src/server-core/http.ts) 将 `POST /api/rpc-host-capability` 直接接到 `capabilities.issue()`；该 Core 标记 `authRequired: false`，虽拒绝非 loopback 监听，但能访问 loopback/SSH tunnel 端口的客户端可自行取得一次性 Host ticket。WebSocket 会消费 ticket，但 loopback 和 `expectedTargetId` 本身不构成认证。不得把此路径描述为可信 Host attachment，恢复时先审查私有 bootstrap/control 通道和端到端授权，再决定产品修复。`packages/server/src/http.ts` 是另一条服务入口，需分别核实其配置 token middleware，不能将两者混为一谈。

生产打包缺依赖/隔离 bundle 验证未完成。native 丢失 cwd 时完整 transcript 恢复和 cold owner 行为未完成。既有 Supervisor 生命周期用例以 MockCore 驱动，不能当作真实生产 GUI 退出认证。SSH 失败还需要区分执行环境限制和真实不可达，不能将未到认证阶段的超时归因于凭据。

### Claude Messages / P5

Messages decoder/encoder 和局部 HTTP 用例曾通过；真实 pinned Claude Code 2.1.263 → Host → Gateway → FakeModel 集成未通过。去掉错误的空 `--mcp-config` 后，最后一次运行失败原因已从日志确认：CLI 报 `unrecognized_model`，model 为 `zcode-host`、query source 为 SDK；FakeModel 收到 0 个 user prompt，Host turn outcome 为 failed。因此这不是 Provider 兼容通过，也没有证据表明请求到达 FakeModel。

当前实现要求 Model 的第一个 `start` event 提供精确 input/output usage，并将顶层 `system` 映射到新增 `systemInstructions`。恢复时按 pinned CLI 的真实 payload/usage 语义审查这两个约束，覆盖普通 OpenAI-compatible Model 可能只在 finish 报 usage 的情况；未知 usage 不可估算或伪造，通用 Gateway 不应因测试方便而被缩成仅适配 Anthropic 上游。FakeModel/decoder 测试不能代替真实 CLI 回归。

### Agent creation UI

当前 UI 已包含真正持久化 owner session、HarnessPicker/Badge/Header、静态 Host asset 以及按 target 打开的旧历史记录路径。源码中 `ProjectSidebarMount` 已把 `targetId` 传给 `openHistoryRecord`，此前“泛化回调可能打开错误 target”的担忧看起来已有针对性处理，但完整交互/E2E 尚未验收。当前树的 `pnpm typecheck` 还在 `packages/ui/src/hooks/useProjectWorkspaceSidebar.tsx:188` 报语法错误，必须在恢复实现时处理。

Host 当前 `harnessAssets.ts` 仍生成手绘 ZCode Z 形 SVG，而 UI 已有 `icon-glm-for-light/dark.png` 原资产；恢复时核对是否改用现有品牌资产。Pi mark 现在附有 v0.87.1 上游文件与 MIT license 说明（见 `packages/services/src/agent-host/assets/README.md`），视觉/来源仍应按文档复核。asset 读取不应启动 Runtime，缓存应随 Host attachment generation 更新。多 target 历史入口和 owner-specific 路由仍需浏览器场景证明。

## 其他实现证据及未决审阅项

已完成过有界本地验证的部分包括层级协议、ProjectCatalog V2 多 target 缓存与裸仓库、Worktree discover/adopt/create/remove 和共享 admission fence、session hierarchy 迁移并保留 history owner、native 空会话持久化与 Pi 独立创建、外部 V4 bridge 和可见 React UI/分页/并发审批、每 turn 冻结 Model BindingPlan，以及 Responses Gateway 与固定 Codex 0.157.1 structured app-server 适配。它们证明的是对应的局部实现/fixture；FakeModel、loopback 和本地夹具不等于真实 Provider、Desktop、SSH 或任意工具 sandbox 验收。

恢复时也要复核 Catalog/UI 的 target freshness 边界：先前审阅指出，仅刷新 Worktree metadata、缺少本次 `sessionSummaries` 时，旧 summary 可能被标为 live；失败/缺字段的 snapshot 不能伪造 idle/none、清空已知 running/approval，`observedAt` 也不能作为执行授权。还需验证 target A 的新快照不会被旧/重复/冲突快照覆盖，以及相同 `workspaceId` 的多 target 并发隔离；未知 legacy ID 不得绑定到第一个返回的 target。详见临时记录 `/tmp/zcode-gpt6-catalog-targets-review-notes.txt`。`workspaceIds` legacy 字段与新聚合 Catalog API 的 UI 接缝也尚未整体验收。

Codex 当前代码已把精确 FakeModel fixture 组合单独限定为 control-path admission；没有该精确证据的 Provider/model 组合返回 experimental，不能据此声称真实 Codex/Provider 已认证。仍需验证 CLI 启停无响应时的有界诊断、审批并发 winner、grant 到期后的拒绝/恢复、sandbox 与实际工具阻止证据、长会话续绑，以及 Responses 并行工具语义。`probeCodexModelGateway.mjs` 还被审阅指出硬编码开发者本机 PATH；恢复时改为显式 executable/安装发现并保留环境 allowlist，不复制个人认证状态。相关旧审阅意见保存在 `/tmp/zcode-gpt6-codex-adapter-review-notes.txt`。

## 真实环境验收状态

- 用户已授权使用 SSH Mac、StepFun 和 AxonHub DeepSeek；预算从最初 50 元放宽为少用即可，无需重复申请授权。恢复后优先减少 StepFun 用量、少用 Axon。此文档不保存凭据、主机地址或真实用户数据。
- 最近 Mac SSH 共 7 次配置探测，6 次 timeout、1 次 refused；2026-09-28T00:26:40Z 曾做 full-access 复核。是否可连接 Mac 的确认仍待用户答复，本次暂停不重试。此前探测处于受限执行环境，不能据此认定 SSH 永久不可达。
- 最近 native StepFun A 的首轮 required read/write/fixed-check/terminal 均出现且缺项为空；额外 Bash 因 command-mismatch 被 fixture 策略拒绝，未 follow-up，因此整组失败。该组计数为 5 logical attempts / 6 fetches（5 HTTP、1 unknown）；异常后没有做最终物理 nonce/hash/output 检查。Axon B 和 deny C 未跑。累计账面是至少 153 logical attempts，另有 2 次旧探测的计数未知；不是精确费用统计。
- 后续仍需完成 native/Pi × StepFun/Axon × local/SSH 八种组合、真实 GUI 退出/SSH 断线/审批/副作用幂等/目标认证、旧 session 迁移恢复、Codex 真实组合及 sandbox 限制、Claude 适配、P6 通用 ACP 与第二个同协议 Agent、升级回滚/安装诊断、50 worktree / 10 session / 100k events / 8h soak 与性能，以及打包/license 和逐项总验收。真实付费与远端检查在本次暂停范围外。

执行偏好：GPT-6 Luna Max；root 只负责计划和验收。内置工具不识别该 model，但 Codex CLI 0.157.1 使用 `-m gpt-6-luna -c model_reasoning_effort=max` 曾成功。本次不热重载或改全局配置。

## 本次门禁结果

使用 Node v24.14.0、pnpm 10.33.2、指定 Git 2.45.4 路径执行。结果均按本次工作树记录，不做修复：

- `node scripts/check-workspace-freshness.mjs`：失败。首次临时 Git 找不到 `git-remote-https`；设置本机 helper 路径后重试，fetch 又因 helper/版本环境报 `rev-list`/`maintenance` 错误及远端对象不完整。不能记作基线通过；日志 `/tmp/zcode-refactor-checkpoint/freshness.log`。
- `pnpm typecheck`：exit 2；`useProjectWorkspaceSidebar.tsx:188` TS1005 `, expected`。
- `pnpm lint`：exit 1；汇总 84 warnings、5 errors。
- `pnpm architecture:check --changed`：exit 1；1 项 `max-file-lines`，`packages/services/src/model-gateway/app/gatewayApplication.ts` 为 474 行，策略上限 400。
- `git diff --check`：exit 0（检查当时已跟踪的源码 diff）。对完整 staged diff 执行 `git diff --cached --check` 为 exit 2，仅报告被要求一并提交的根计划第 3–6 行有尾随空格；为保留原计划内容，本次未改写该用户文件。检查日志 `/tmp/zcode-refactor-checkpoint/staged-diff-check.log`。

本次敏感项检查发现新测试文件中的 fixture/test 凭据形态字符串，以及 Pi Host provider `auth.apiKey` 字段中的固定 session-scoped sentinel（不是环境变量或真实 Provider 凭据）；production-source 中的 token-like 命中均为未修改旧行。私网/loopback URL 命中只在测试中，未发现变更候选中的私钥或内部服务地址。`.pi/` 内的 agent/task 数据完全排除；未暂存日志、截图、用户数据或构建产物。桌面 `resources/persistent-target/` 属打包产物并已由 `.gitignore` 排除。

## 临时证据

临时文件可能被清理；关键状态以本检查点和提交内容为准。

- 三个中断任务日志与意见：`/tmp/zcode-gpt6-persistent-target-run.log`、`/tmp/zcode-gpt6-persistent-target-review-notes.txt`、`/tmp/zcode-gpt6-claude-messages-run.log`、`/tmp/zcode-gpt6-claude-messages-review-notes.txt`、`/tmp/zcode-gpt6-agent-creation-ui-run.log`、`/tmp/zcode-gpt6-agent-creation-ui-review-notes.txt`。
- 局部结果：`/tmp/zcode-gpt6-turn-binding-result.txt`、`/tmp/zcode-gpt6-session-membership-review-result.txt`、`/tmp/zcode-gpt6-multitarget-ui-result.txt`、`/tmp/zcode-gpt6-external-ui-proof-result.txt`、`/tmp/zcode-gpt6-native-plan-validation-result.txt`。
- P4 生命周期审阅：`/tmp/zcode-gpt6-p4-lifecycle-audit/run.EXDLVT/REPORT.md`。
- 之前的 Catalog/Codex 审阅：`/tmp/zcode-gpt6-catalog-targets-review-notes.txt`、`/tmp/zcode-gpt6-codex-adapter-review-notes.txt`。
- 本次 freshness、typecheck、lint、architecture 和 diff-check 日志：`/tmp/zcode-refactor-checkpoint/`。
