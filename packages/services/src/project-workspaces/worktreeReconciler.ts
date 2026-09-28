import { createServiceLogger } from "../logger/serviceLogger.js";
import type { WorktreeWorkspace } from "./planTypes.js";
import { discoverRepository, sameEvidence } from "./discovery.js";
import type { FilesystemIdentity, ProjectWorkspaceDeps } from "./ports.js";
import type { CatalogSnapshot } from "./snapshot.js";

const logger = createServiceLogger("project-workspaces");

export interface ScanCandidate {
  worktreePath: string;
  head: WorktreeWorkspace["head"];
  evidence: FilesystemIdentity;
}

export type ScanOutcome =
  | { status: "ok"; candidates: readonly ScanCandidate[] }
  | { status: "failed"; reason: "timeout" | "permission" | "disconnected" | "error" | "upgrade-required" };

export interface ReconcileReport {
  freshness: "live" | "stale" | "offline" | "unknown";
  updatedIds: string[];
  missingIds: string[];
  needsVerificationIds: string[];
  /** null 表示这次扫描不能证明候选数量，调用方不得把它显示成 0。 */
  unadoptedCount: number | null;
}

function freshnessFor(reason: Exclude<ScanOutcome, { status: "ok" }>["reason"]): ReconcileReport["freshness"] {
  return reason === "disconnected" ? "offline" : "stale";
}

export function createWorktreeReconciler(deps: ProjectWorkspaceDeps) {
  async function reconcile(input: { gitCommonDir: string; outcome: ScanOutcome }): Promise<ReconcileReport> {
      return deps.store.update<ReconcileReport>((snapshot) => {
        const binding = snapshot.bindings.find(
          (item) =>
            item.executionTargetId === deps.executionTargetId &&
            item.gitCommonDir === input.gitCommonDir,
        );
        if (input.outcome.status === "failed") {
          logger.warn(undefined, "worktree-scan-failed", { reason: input.outcome.reason });
          const freshness = freshnessFor(input.outcome.reason);
          return {
            snapshot: {
              ...snapshot,
              freshnessByTargetId: {
                ...snapshot.freshnessByTargetId,
                [deps.executionTargetId]: freshness,
              },
            },
            result: {
              freshness,
              updatedIds: [],
              missingIds: [],
              needsVerificationIds: [],
              unadoptedCount: null,
            },
          };
        }
        if (!binding) {
          return {
            snapshot: {
              ...snapshot,
              freshnessByTargetId: { ...snapshot.freshnessByTargetId, [deps.executionTargetId]: "live" },
            },
            result: {
              freshness: "live" as const,
              updatedIds: [],
              missingIds: [],
              needsVerificationIds: [],
              unadoptedCount: input.outcome.candidates.length,
            },
          };
        }
        const applied = applyScan(snapshot, binding.id, input.outcome.candidates);
        return {
          snapshot: {
            ...applied.snapshot,
            freshnessByTargetId: { ...applied.snapshot.freshnessByTargetId, [deps.executionTargetId]: "live" },
            unadoptedCountByBindingId: {
              ...applied.snapshot.unadoptedCountByBindingId,
              [binding.id]: applied.unadoptedCount,
            },
          },
          result: { ...applied.report, freshness: "live" as const, unadoptedCount: applied.unadoptedCount },
        };
      });
  }

  async function refresh(inputPath: string): Promise<ReconcileReport> {
      const report = await discoverRepository(deps, inputPath);
      if (report.kind === "scan-failed" || report.kind === "upgrade-required") {
        return reconcile({
          gitCommonDir: "",
          outcome: {
            status: "failed",
            reason: report.kind === "upgrade-required" ? "upgrade-required" : report.reason,
          },
        });
      }
      if (report.kind === "folder") {
        return {
          freshness: "unknown",
          updatedIds: [],
          missingIds: [],
          needsVerificationIds: [],
          unadoptedCount: null,
        };
      }
      return reconcile({
        gitCommonDir: report.gitCommonDir,
        outcome: {
          status: "ok",
          candidates: report.candidates.map((candidate) => ({
            worktreePath: candidate.worktreePath,
            head: candidate.head,
            evidence: candidate.evidence,
          })),
        },
      });
  }

  return { reconcile, refresh };
}

function applyScan(
  snapshot: CatalogSnapshot,
  bindingId: string,
  candidates: readonly ScanCandidate[],
): {
  snapshot: CatalogSnapshot;
  report: Omit<ReconcileReport, "freshness" | "unadoptedCount">;
  unadoptedCount: number;
} {
  const updatedIds: string[] = [];
  const missingIds: string[] = [];
  const needsVerificationIds: string[] = [];
  const matched = new Set<string>();
  let workspaces = snapshot.workspaces;
  let verification = { ...snapshot.verificationByWorkspaceId };
  for (const workspace of snapshot.workspaces.filter((item) => item.repositoryBindingId === bindingId)) {
    const evidence = snapshot.evidenceByWorkspaceId[workspace.id];
    const same = evidence
      ? candidates.find((candidate) => sameEvidence(evidence, candidate.evidence))
      : undefined;
    if (same) {
      matched.add(same.worktreePath);
      // 已移除的历史不能因为同一路径上又出现目录就改回可执行位置。
      if (workspace.lifecycle === "removed") {
        verification = { ...verification, [workspace.id]: "needsVerification" };
        needsVerificationIds.push(workspace.id);
        continue;
      }
      const next: WorktreeWorkspace = {
        ...workspace,
        worktreePath: same.worktreePath,
        head: same.head,
        lifecycle: workspace.lifecycle === "missing" ? "active" : workspace.lifecycle,
      };
      verification = { ...verification, [workspace.id]: "verified" };
      updatedIds.push(workspace.id);
      workspaces = workspaces.map((item) => (item.id === workspace.id ? next : item));
      continue;
    }
    const samePath = candidates.find((candidate) => candidate.worktreePath === workspace.worktreePath);
    if (samePath) {
      matched.add(samePath.worktreePath);
      verification = { ...verification, [workspace.id]: "needsVerification" };
      needsVerificationIds.push(workspace.id);
      continue;
    }
    if (workspace.lifecycle === "removed") continue;
    const missing: WorktreeWorkspace = { ...workspace, lifecycle: "missing" };
    workspaces = workspaces.map((item) => (item.id === workspace.id ? missing : item));
    verification = { ...verification, [workspace.id]: "needsVerification" };
    missingIds.push(workspace.id);
  }
  const unadoptedCount = candidates.filter((candidate) => !matched.has(candidate.worktreePath)).length;
  return {
    snapshot: { ...snapshot, workspaces, verificationByWorkspaceId: verification },
    report: { updatedIds, missingIds, needsVerificationIds },
    unadoptedCount,
  };
}
