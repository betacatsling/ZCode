import type { SidebarSessionNode, SidebarWorkspaceNode } from "./planTypes.js";

/** 主提示顺序：待审批/问题 → 未确认错误 → 未知 → 运行中 → 未读完成 → 空闲。 */
export type SidebarAttention = "pending" | "error" | "unknown" | "running" | "unread" | "idle";

const ATTENTION_ORDER: readonly SidebarAttention[] = [
  "pending",
  "error",
  "unknown",
  "running",
  "unread",
  "idle",
];

export interface SidebarCounts {
  agentCount: number;
  pendingCount: number;
  runningCount: number;
  errorCount: number;
  unknownCount: number;
  unreadCount: number;
  attention: SidebarAttention;
}

function isRunningActivity(row: SidebarSessionNode): boolean {
  return (
    row.activity === "starting" ||
    row.activity === "running" ||
    row.activity === "waiting" ||
    row.activity === "cancelling"
  );
}

export function sessionAttention(row: SidebarSessionNode): SidebarAttention {
  if (row.pendingInteractionCount > 0) return "pending";
  if (row.recentOutcome === "failed") return "error";
  if (row.recentOutcome === "unknown") return "unknown";
  if (isRunningActivity(row)) return "running";
  if (row.unread) return "unread";
  return "idle";
}

function emptyCounts(): SidebarCounts {
  return {
    agentCount: 0,
    pendingCount: 0,
    runningCount: 0,
    errorCount: 0,
    unknownCount: 0,
    unreadCount: 0,
    attention: "idle",
  };
}

/** 计数覆盖传入的全部行。调用方不要先按折叠或搜索结果裁剪。 */
export function summarizeSessions(sessions: readonly SidebarSessionNode[]): SidebarCounts {
  const counts = emptyCounts();
  counts.agentCount = sessions.length;
  let best = ATTENTION_ORDER.length - 1;
  for (const row of sessions) {
    const attention = sessionAttention(row);
    if (row.pendingInteractionCount > 0) counts.pendingCount += 1;
    else if (isRunningActivity(row)) counts.runningCount += 1;
    if (row.recentOutcome === "failed") counts.errorCount += 1;
    if (attention === "unknown") counts.unknownCount += 1;
    if (row.unread) counts.unreadCount += 1;
    const rank = ATTENTION_ORDER.indexOf(attention);
    if (rank >= 0 && rank < best) best = rank;
  }
  counts.attention = ATTENTION_ORDER[best] ?? "idle";
  return counts;
}

export function summarizeWorkspaces(workspaces: readonly SidebarWorkspaceNode[]): SidebarCounts {
  const counts = emptyCounts();
  let best = ATTENTION_ORDER.length - 1;
  for (const workspace of workspaces) {
    const summary = summarizeSessions(workspace.sessions);
    counts.agentCount += summary.agentCount;
    counts.pendingCount += summary.pendingCount;
    counts.runningCount += summary.runningCount;
    counts.errorCount += summary.errorCount;
    counts.unknownCount += summary.unknownCount;
    counts.unreadCount += summary.unreadCount;
    const rank = ATTENTION_ORDER.indexOf(summary.attention);
    if (rank >= 0 && rank < best) best = rank;
  }
  counts.attention = ATTENTION_ORDER[best] ?? "idle";
  return counts;
}

export function visibleSessions(
  sessions: readonly SidebarSessionNode[],
  query: string,
): { visible: readonly SidebarSessionNode[]; matched: number; total: number } {
  const total = sessions.length;
  const normalized = query.trim().toLowerCase();
  if (!normalized) return { visible: sessions, matched: total, total };
  const visible = sessions.filter((row) => row.session.title.toLowerCase().includes(normalized));
  return { visible, matched: visible.length, total };
}
