# Orca 式三层侧栏

生产导航是 `WorkspaceShellLayout` 里的 `ProjectSidebarMount`。目录为空时保留原来的工作区/任务区域；后台刷新不调用 `focus()`，图标按 `harnessId` 而不是模型名选择。本文件描述的 Orca 展示树与生产侧栏共用 `@zcode/shared/agent-host` 实体，不另挂第二棵树。

## 行为

- 层级为 Project → Workspace → Agent Session。`RepositoryBinding` 只出现在快照归属里，不渲染成第四层。
- 会话行固定为：运行状态、注册目录中的 Harness 图标、标题、更新时间。模型只出现在次要说明里。
- 图标只按 `harnessId` 查调用方传入的目录。缺失、未安装或资源不安全时显示该 Harness 的名称和通用/首字母图标。
- `N agents` 统计快照里的会话行。折叠、隐藏和搜索过滤都不减少这个总数；搜索另显示“匹配 n / 总 N”。
- 工作区同时保留待处理数量和运行数量。连接新鲜度单独标记，断开连接不显示成最近一轮已成功。
- 主检出看 `isMainWorktree`，默认工作区看 `Project.defaultWorkspaceId`。分支名是否为 `main` 不决定徽标。

## 所有者

- 目录、工作区、会话和运行事实的唯一所有者是调用方传入的 `SidebarSnapshot`。本组件不写入 `tabStore`，不调用服务，不订阅桌面或手机链路。
- 展开、隐藏、固定、手动排序、选中会话、草稿和滚动位置的唯一所有者是 `sidebarViewStore`。只有用户动作对应的方法可以改这些字段。
- 展示组件是受控的：它渲染 `view`，并把点击交给回调。快照更新没有 effect，因此不会改选中项，也不会调用 `focus()`。

## 失败与迁移

- 不安全的 SVG、外部 URL 或无法解码的资源直接退回 fallback，不发网络请求，不执行资源。
- 实体类型来自 `@zcode/shared/agent-host`。侧栏节点上的活动、新鲜度和模型文案仍只属于展示，不在业务代码里手写远程身份格式。
- Orca 组件不从应用壳再挂一次。空目录时的旧工作区/任务区域由 `ProjectSidebarMountView` 保留。
