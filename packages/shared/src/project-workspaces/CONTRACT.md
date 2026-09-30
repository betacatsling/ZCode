# Project / RepositoryBinding / WorktreeWorkspace

来源：`ZCode_Multi_Harness_Refactor_Plan_v0.3_Orca_Hierarchy.md` 第 13.2 节。本目录只定义可序列化契约，不发现 Git、不创建 worktree、不拥有侧栏。

## 所有者

- `Project` 只保存项目名称、图标资源和默认工作区引用。
- `RepositoryBinding` 把一个 Project 绑到一个执行目标上的 Git common directory。路径是定位信息，不是永久身份。
- `WorktreeWorkspace` 记录目标宿主已经承认的 worktree 代际、主检出标记、HEAD 展示事实和生命周期。
- 同一 `gitCommonDir` 在不同 `executionTargetId` 上不得合并。

## 不变量

- 稳定身份只用 `id` / `executionTargetId` / `worktreeGeneration`。项目名、标题、branch、绝对路径和临时连接 ID 都不能当永久身份。
- `isMainWorktree` 与 `defaultWorkspaceId` 分开。不能从 branch 名是否等于 `main` 推断主检出。
- `verification=needsVerification` 表示目录消失后又出现、且宿主无法证明仍是同一实例。此时不能复用旧会话身份。
- `schemaVersion` 是运行时版本。计划草案里的字段名保持不变；多出来的版本和校验字段只用于拒绝未来或残缺记录。

## 失败语义

- 缺字段、未知字段、空 ID、重复 ID、跨 Project 引用：解析失败。
- 本契约不访问文件系统，因此不能把解析成功当成目标机器上的 worktree 仍然存在。
