# Agent Host 验收入口

更新：2026-09-29。总体阶段与完成标准见 [项目交付计划](../PROJECT-DELIVERY-PLAN.md)。本表是证据索引，不将旧日志、模拟场景或静态缺席检查标成整个项目通过。

| 验证对象                          | 已有证据入口                                                                            | 当前证据限制                                                          | 交付门槛                                 |
| --------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------- |
| 构建、模块边界与版本              | package scripts、architecture policy、各 PR 的验证日志                                  | 历史通过不代表当前 tip；根 typecheck 不覆盖全部 CLI/发行链            | M1 干净构建、质量门禁、产物同 SHA        |
| Project/Worktree/SessionHierarchy | `packages/services/test/`、`src/project-workspaces/` 对应测试与模块契约                 | 局部 SQLite/Git/fixture 不代表 UI 和远端组合                          | M4 数据、迁移、UI 与目标归属联测         |
| 原生和外部 Host 的命令/审批/恢复  | AgentHost、CommandJournal、runtimeLifecycle 和 workspace admission 测试                 | MockCore/FakeModel/本机 TCP 不能证明真实 GUI 或 SSH 场景              | M2+M4 进程级、真实任务与无重复副作用证据 |
| Pi/原生的真实模型                 | [LIVE-CERTIFICATION](LIVE-CERTIFICATION.md)                                             | 保留历史成功、失败、guard 停止和未知调用记录；并非当前冻结候选全通过  | M4 八组合矩阵                            |
| Codex / Claude                    | adapter specs、模型 Gateway 测试、[IMPLEMENTATION](IMPLEMENTATION.md)                   | FakeModel/experimental 与真实模型认证分开；Claude 共享 owner 尚待接线 | M5 分别认证控制面与模型面                |
| ACP 与长尾 Agent                  | adapter 和 SessionHost fake-transport tests、[安装诊断草稿](SECOND-ACP-INSTALL-DIAG.md) | 大量确定性组合不是第二生产 Agent 的 live 证明                         | M6 默认接线、兼容和真实运行              |
| 产品登录移除                      | `scripts/verify-product-login-removed.mjs`、P2/P4 与 UI/CLI 契约测试                    | 源码检查和镜像 removed-command 形态检查不是运行时 E2E                 | M3 全入口、旧数据、第三方认证和网络行为  |
| 发布和长期运行                    | #16 演练、旧 release/worker 记录、归档 load 分支                                        | fixture 回滚不等于安装包回滚；短测试不等于 soak                       | M7 冻结候选的发布与性能矩阵              |

## 记录规则

每份验收结果必须带完整源码 SHA、实际平台、harness/Provider/模型（如适用）、工具版本、运行入口和 pass/fail/blocked/skipped。产物运行另带产物 hash，并注明是否有临时打包修正。

当前原始证据有部分保存在过去执行环境的 `/tmp`，不可假设在任何新机器上仍可访问。发布前必须提炼可复核的脱敏证据入库，保留失败和未执行范围。

本次整理前的完整阶段台账可在标签 `archive/2026-09-29/integration-before-consolidation` 的本文件历史版本查看。项目整体仍未完成。
