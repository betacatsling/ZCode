import { createHash } from "node:crypto";
import { join } from "node:path";
import { readNativeCatalogReferences } from "../project-workspaces/projectCatalog.js";
import type { NativeRuntimeFactsPort } from "./nativeProductionBridge.js";
import { NativeCreateJournal } from "./nativeCreateJournal.js";

/** Pure read-only inspection; only completed mapping + actual source + Catalog reference is a certificate. */
export function createNativeCreateInspection(
  journal: NativeCreateJournal,
  configRoot: string,
): NonNullable<NativeRuntimeFactsPort["inspect"]> {
  return async (commandId) => {
    const entryId = createHash("sha256").update(commandId).digest("hex");
    let state: Awaited<ReturnType<typeof journal.read>>;
    try {
      state = await journal.read(commandId);
    } catch {
      // 中文：坏映射/源库不能升级成当前 owner；仅报告脱敏单项诊断，不修盘或启动 CLI。
      return { status: "unavailable", diagnostic: { entryId, reason: "uncertified-mapping" } };
    }
    if (!state) return { status: "unknown" };
    if (!state.mapping) return { status: "pending" };
    const { intent, mapping } = state;
    const refs = await readNativeCatalogReferences(
      join(configRoot, "workspace-hierarchy", "profile", "catalog.json"),
    );
    const referenced = refs.some(
      (ref) =>
        ref.commandId === intent.commandId &&
        ref.originalSessionId === mapping.originalSessionId &&
        ref.targetId === intent.targetId &&
        ref.projectId === intent.projectId &&
        ref.workspaceId === intent.workspaceId &&
        ref.repositoryBindingId === intent.repositoryBindingId &&
        ref.worktreeGeneration === intent.worktreeGeneration &&
        ref.workspaceIdentity === intent.workspaceIdentity &&
        ref.workspacePath === intent.workspacePath &&
        ref.remoteSessionId === intent.remoteSessionId,
    );
    if (!referenced)
      return { status: "unavailable", diagnostic: { entryId, reason: "unreferenced-completion" } };
    return {
      status: "completed",
      originalSessionId: mapping.originalSessionId,
      intent: {
        targetId: intent.targetId,
        projectId: intent.projectId,
        workspaceId: intent.workspaceId,
        repositoryBindingId: intent.repositoryBindingId,
        worktreeGeneration: intent.worktreeGeneration,
        workspaceIdentity: intent.workspaceIdentity,
        workspacePath: intent.workspacePath,
      },
    };
  };
}
