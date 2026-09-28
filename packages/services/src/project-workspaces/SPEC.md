# Project Catalog 与 Worktree 服务

本目录实现计划第 13.2–13.4、13.6–13.7 节。类型以 `planTypes.ts` 为准，字段不扩展。合并共享契约 PR 后，改为从 shared 公开入口导入。

## 所有者

```text
命令 → CatalogStore.update → catalogState 转移 → 同一份快照
```

- `projectCatalog` 只写 Project 的名称、图标、默认工作区和“从应用移除”标记。
- `worktreeService` 只写 binding、workspace、session、删除准入栅栏和显式接管/新建。
- `worktreeReconciler` 只根据目标上的扫描结果更新位置、HEAD、代际核实和 freshness。
- `repositoryBindingResolver`、`sidebarIndexService` 不写状态。
- `legacyWorkspaceMigration` 只在一次 `update` 里提交元数据映射。

Git 目录、历史正文和 native session 正文都不是本目录的写入对象。

## 身份

工作区关联键是 `workspaceIdentity?.trim() || workspacePath`。路径不裁剪。比较时必须同时看 `executionTargetId`：目标不同，或身份键不同，即使绝对路径相同也不合并。`gitCommonDir` 只定位仓库实例，不能单独当永久 ID。branch 名不是 workspace id。

## 执行位置

新会话的执行目标、worktree 路径和代际从已接管工作区及其 binding 派生。调用参数里的目标、路径和代际一律忽略。新会话默认 cwd 是 worktree 根；显式子目录必须经 realpath 确认仍在该工作tree 内。恢复迁移来的子目录 cwd 时保持原相对路径。

同一工作区再创建会话只追加 `AgentSessionRecord`，不执行 `worktree add`，不切换 branch。隔离工作区是单独的 `createWorkspace`。

## 发现与扫描

`discover` 只读：`rev-parse` 与 `git worktree list --porcelain -z`。不 init、不 prune、不 add/remove、不跑 hook、不启动 Agent。缺少 `-z` 时要求升级，不按空白拆路径。扫描失败、超时、权限错误或断线只把该目标 freshness 标成 stale/offline，不把目录改成空，也不批量 missing/removed。

bare 仓库不制造主检出，也不能把 bare 目录当成可执行工作区。非 Git 目录标记为普通文件夹，不 `git init`。

## 删除

```text
预检（不写栅栏、不停止会话）
  → 不安全则拒绝
  → 冻结新会话准入
  → 仅在调用方明确确认时停止必要执行
  → 重检
  → git worktree remove（无 --force，不删 branch）
  → lifecycle=removed，保留会话历史
```

删除进行中 `createAgentSession` 拒绝。拒绝路径不先停止会话，也不删除目录。主检出不能走 linked worktree 删除。Git 成功但目录写入失败时返回未登记候选，不回删已创建的 worktree。

## 迁移

只读存储索引，不用当前打开的 tabs 定义项目是否存在。按目标 + `gitCommonDir` 分组；submodule 使用自己的 common dir。同一 worktree 的多个旧会话都保留 native session id、模型绑定和相对 cwd。离线、缺路径、未知 Harness、同路径重建进入待核实，不回退到本机或默认 Harness。事务可重入；失败不留下半份快照。

## 侧栏

摘要只消费会话活动，不读取 transcript，不启动 CLI。`N agents` 统计未归档顶层会话。折叠、隐藏不减少总数。已发现未接管和已接管但隐藏分开计数。隐藏工作区若有待审批，仍出现在项目 attention。连接 freshness 不改写轮次结果。
