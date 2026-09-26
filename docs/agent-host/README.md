# 多 Harness 改造：当前阅读入口

本目录以 [v0.3 产品计划](../../ZCode_Multi_Harness_Refactor_Plan_v0.3_Orca_Hierarchy.md) 为目标，不以文件数、Mock 通过数或旧阶段报告推断完成度。

## 先读这四份

1. [ACCEPTANCE.md](ACCEPTANCE.md)：**唯一当前状态表**，回答实现与计划之间的 gap。
2. [INTEGRATION-ASSEMBLY.md](INTEGRATION-ASSEMBLY.md)：整合基线、分支/未提交改动处置，哪些不能盲目合并。
3. [TASKS.md](TASKS.md)：可派给独立 Agent 的小任务、输入/输出/验收/依赖/文件边界。
4. [BASELINE.md](BASELINE.md)：本轮真正执行的检查与历史证据索引；“测试存在”不等于“本轮通过”。

远端开发与并行资源策略见 [REMOTE-EXECUTION.md](REMOTE-EXECUTION.md)。

## 有效规格（不是进度报告）

- 所有者与准入：[CONTRACT](CONTRACT.md)、[HIERARCHY](HIERARCHY.md)、[CATALOG](CATALOG.md)、[WORKTREE-SERVICE](WORKTREE-SERVICE.md)、[REGISTRY](REGISTRY.md)。
- UI/交互：[SIDEBAR-UI](SIDEBAR-UI.md)、[UI-SESSION-MOUNT](UI-SESSION-MOUNT.md)、[FACADE-UI](FACADE-UI.md)、[E2E](E2E.md)。
- Native：[CORE-JOIN](../native-create/CORE-JOIN.md)、[RECEIPT](../native-create/RECEIPT.md)、[LEGACY-SESSION-REGRESSION](../native-create/LEGACY-SESSION-REGRESSION.md)。
- Harness：[PI-MODEL-V2](PI-MODEL-V2.md)、[PI-WORKER](PI-WORKER.md)、[CODEX-ADAPTER](CODEX-ADAPTER.md)、[CLAUDE-ADAPTER](CLAUDE-ADAPTER.md)、[ACP-ADAPTER](ACP-ADAPTER.md)，及各自 transport 规格。
- Gateway：[GATEWAY-CORE](GATEWAY-CORE.md)、[GATEWAY-RESPONSES](GATEWAY-RESPONSES.md)、[GATEWAY-MESSAGES](GATEWAY-MESSAGES.md)。
- 生命周期：[RUNTIME-LIFETIME](RUNTIME-LIFETIME.md)、[DESKTOP-ATTACH](DESKTOP-ATTACH.md)、[LOAD-VALIDATION](LOAD-VALIDATION.md)。
- 真实模型：[LIVE-MATRIX-LOCAL](LIVE-MATRIX-LOCAL.md)、[LIVE-MATRIX-REMOTE](LIVE-MATRIX-REMOTE.md)、[LIVE-PI-V2](LIVE-PI-V2.md)。历史成功只适用于其记录的源码/模型/目标。
- 来源与许可：[third-party-source-map](third-party-source-map.md)、[CODEX-HOST-REFERENCE](CODEX-HOST-REFERENCE.md)。不得为清理文档而移除许可义务。

## 文档维护规则

- 产品要求 → 有效 spec → 当前状态表 → 不可变历史证据，四层分开。
- 修改行为前先更新对应 spec；进度只更新 ACCEPTANCE/BASELINE，不再向旧 handoff 追加相互矛盾的“当前状态”。
- 每项 PASS 必须带源码版本、命令、运行环境和证据位置。缺失日志写“历史报告，未独立复核”。
- 历史文件已移至 [archive](../archive/multi-harness/README.md)，包含 25 个原 `.tmp` 交接/审查/patch 文件及 10 份清理前文档快照。原字节及 SHA-256 保留；历史 patch 不是待自动执行指令。
- 新增 Agent 任务用 TASKS 的单一所有者/依赖规则。多个 Agent 只读可以共享候选树；并行写入必须独立 worktree，最后由单一集成人合并。
