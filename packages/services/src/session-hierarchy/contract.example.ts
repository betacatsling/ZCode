import type { SessionHierarchyFile } from "@zcode/shared/agent-host/session-hierarchy";

export const sessionHierarchyContractExample: SessionHierarchyFile = {
  schemaVersion: 1,
  source: {
    sourceKey: "current-owner-facts:target-local",
    fingerprint: "0".repeat(64),
    commandKey: "1".repeat(64),
  },
  records: [
    {
      hierarchySessionId: "4dd194ef-91bb-5a1d-8ea4-599cc5d6241d",
      nativeSessionId: "sess_managed_workspace_example",
      ownerKind: "native-v4",
      targetId: "target-local",
      projectId: "project-1",
      workspaceId: "workspace-42",
      harnessId: "zcode",
      workspacePath: "/repo",
      cwdRelativeToWorktree: ".",
      title: "New Agent",
      ownerAssociation: {
        workspaceId: "workspace-42",
        worktreeGeneration: "generation-7",
      },
      status: "linked",
    },
    {
      hierarchySessionId: "c0b39130-5ce2-5dd4-bf2b-a58ff43054b9",
      nativeSessionId: "sess_prior_generation_example",
      ownerKind: "agent-host",
      targetId: "target-local",
      projectId: "project-1",
      workspaceId: "workspace-42",
      harnessId: "pi",
      workspacePath: "/repo/old-worktree",
      cwdRelativeToWorktree: ".",
      ownerHistoryAssociation: {
        workspaceId: "workspace-42",
        worktreeGeneration: "generation-6",
      },
      status: "pending-verification",
      pendingReason: "stale-generation",
    },
  ],
};
