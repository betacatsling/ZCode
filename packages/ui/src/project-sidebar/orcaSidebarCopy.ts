export interface OrcaSidebarCopy {
  navLabel: string;
  agents: (count: number) => string;
  hiddenDiscovered: (count: number) => string;
  manage: string;
  more: string;
  addWorkspace: string;
  addAgent: string;
  collapse: string;
  expand: string;
  mainCheckout: string;
  defaultWorkspace: string;
  detachedHead: (oid: string) => string;
  match: (matched: number, total: number) => string;
  pending: (count: number) => string;
  running: (count: number) => string;
  model: (label: string) => string;
  updated: (time: string) => string;
  status: Record<"pending" | "error" | "unknown" | "running" | "unread" | "idle", string>;
  freshness: Record<"live" | "stale" | "offline" | "unknown", string>;
  cancel: string;
  createWorkspace: string;
  createAgent: string;
  sharedHint: string;
  target: string;
  workspaceName: string;
  baseRef: string;
  branch: string;
  directory: string;
  newBranch: string;
  existingBranch: string;
  adopt: string;
  chooseHarness: string;
  chooseModel: string;
  hostManaged: string;
  harnessManaged: string;
  requested: (label: string) => string;
  effective: (label: string) => string;
  mismatch: string;
  support: Record<"supported" | "unsupported" | "experimental" | "unknown", string>;
  sessionTitle: string;
}

export function formatSidebarRelativeTime(updatedAt: number, now: number, locale: string): string {
  const deltaSeconds = Math.round((updatedAt - now) / 1000);
  const absolute = Math.abs(deltaSeconds);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (absolute < 60) return formatter.format(deltaSeconds, "second");
  if (absolute < 3600) return formatter.format(Math.round(deltaSeconds / 60), "minute");
  if (absolute < 86_400) return formatter.format(Math.round(deltaSeconds / 3600), "hour");
  return formatter.format(Math.round(deltaSeconds / 86_400), "day");
}

export function orcaSidebarCopy(locale: string): OrcaSidebarCopy {
  if (locale.toLowerCase().startsWith("zh")) {
    return {
      navLabel: "项目工作区",
      agents: (count) => `${count} 个 Agent`,
      hiddenDiscovered: (count) => `已隐藏 ${count} 个发现的工作区`,
      manage: "管理",
      more: "更多",
      addWorkspace: "添加工作区",
      addAgent: "新建 Agent",
      collapse: "折叠",
      expand: "展开",
      mainCheckout: "主检出",
      defaultWorkspace: "默认",
      detachedHead: (oid) => `分离 HEAD ${oid.slice(0, 8)}`,
      match: (matched, total) => `匹配 ${matched} / 总 ${total}`,
      pending: (count) => `待处理 ${count}`,
      running: (count) => `运行中 ${count}`,
      model: (label) => `模型：${label}`,
      updated: (time) => `更新于${time}`,
      status: {
        pending: "需要处理",
        error: "失败",
        unknown: "状态未知",
        running: "运行中",
        unread: "最近一轮已完成",
        idle: "空闲",
      },
      freshness: { live: "在线", stale: "状态过期", offline: "离线", unknown: "未知" },
      cancel: "取消",
      createWorkspace: "添加工作区",
      createAgent: "创建 Agent",
      sharedHint: "此工作区中的 Agent 会共享文件改动。新增 Agent 不会另建 Git worktree。",
      target: "目标",
      workspaceName: "工作区名称",
      baseRef: "基准 ref",
      branch: "分支",
      directory: "目录",
      newBranch: "创建新分支",
      existingBranch: "使用已有分支",
      adopt: "接管",
      chooseHarness: "选择 Harness",
      chooseModel: "选择模型",
      hostManaged: "宿主模型",
      harnessManaged: "Harness 模型",
      requested: (label) => `请求：${label}`,
      effective: (label) => `生效：${label}`,
      mismatch: "请求的模型与实际生效模型不一致",
      support: {
        supported: "此目标支持",
        unsupported: "此目标不支持",
        experimental: "此目标上的实验性支持",
        unknown: "无法核实支持状态",
      },
      sessionTitle: "会话标题（可选）",
    };
  }
  return {
    navLabel: "Project workspaces",
    agents: (count) => `${count} agents`,
    hiddenDiscovered: (count) => `${count} discovered workspaces hidden`,
    manage: "Manage",
    more: "More",
    addWorkspace: "Add workspace",
    addAgent: "New Agent",
    collapse: "Collapse",
    expand: "Expand",
    mainCheckout: "Main checkout",
    defaultWorkspace: "Default",
    detachedHead: (oid) => `Detached HEAD ${oid.slice(0, 8)}`,
    match: (matched, total) => `Matching ${matched} / ${total}`,
    pending: (count) => `Pending ${count}`,
    running: (count) => `Running ${count}`,
    model: (label) => `Model: ${label}`,
    updated: (time) => `Updated ${time}`,
    status: {
      pending: "Needs attention",
      error: "Failed",
      unknown: "Unknown",
      running: "Running",
      unread: "Latest turn completed",
      idle: "Idle",
    },
    freshness: { live: "Live", stale: "Stale", offline: "Offline", unknown: "Unknown" },
    cancel: "Cancel",
    createWorkspace: "Add workspace",
    createAgent: "Create Agent",
    sharedHint:
      "Agents in this workspace share file changes. New Agent does not create a worktree.",
    target: "Target",
    workspaceName: "Workspace name",
    baseRef: "Base ref",
    branch: "Branch",
    directory: "Directory",
    newBranch: "Create a branch",
    existingBranch: "Use an existing branch",
    adopt: "Adopt",
    chooseHarness: "Choose Harness",
    chooseModel: "Choose model",
    hostManaged: "Host model",
    harnessManaged: "Harness model",
    requested: (label) => `Requested: ${label}`,
    effective: (label) => `Effective: ${label}`,
    mismatch: "The requested model does not match the effective model",
    support: {
      supported: "Supported on this target",
      unsupported: "Unsupported on this target",
      experimental: "Experimental on this target",
      unknown: "Support could not be verified",
    },
    sessionTitle: "Session title (optional)",
  };
}
