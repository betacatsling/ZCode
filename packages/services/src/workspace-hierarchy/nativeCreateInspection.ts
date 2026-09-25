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
  return async (commandId, expected) => {
    // 中文：所有结果（含 pending/损坏源）必须先证实命令属于这个 Catalog workspace，
    // 否则拿到别人的 commandId 就能侧信道探测状态或哈希诊断。
    let intent: Awaited<ReturnType<typeof journal.readIntent>>;
    try {
      intent = await journal.readIntent(commandId);
    } catch {
      return { status: "unknown" };
    }
    if (
      !intent ||
      intent.workspaceId !== expected.workspaceId ||
      intent.targetId !== expected.targetId ||
      intent.workspaceIdentity !== expected.workspaceIdentity ||
      intent.workspacePath !== expected.workspacePath
    )
      return { status: "unknown" };
    const entryId = createHash("sha256").update(commandId).digest("hex");
    let state: Awaited<ReturnType<typeof journal.inspectCompleted>>;
    try {
      state = await journal.inspectCompleted(commandId);
    } catch {
      // 中文：跨 await 修改意图时不能让 foreign 损坏源通过上一版归属校验泄露状态。
      const latest = await journal.readIntent(commandId).catch(() => undefined);
      if (
        !latest ||
        latest.workspaceId !== expected.workspaceId ||
        latest.targetId !== expected.targetId ||
        latest.workspaceIdentity !== expected.workspaceIdentity ||
        latest.workspacePath !== expected.workspacePath
      )
        return { status: "unknown" };
      return { status: "unavailable", diagnostic: { entryId, reason: "uncertified-mapping" } };
    }
    if (
      !state ||
      state.intent.workspaceId !== expected.workspaceId ||
      state.intent.targetId !== expected.targetId ||
      state.intent.workspaceIdentity !== expected.workspaceIdentity ||
      state.intent.workspacePath !== expected.workspacePath
    )
      return { status: "unknown" };
    if (!state.originalSessionId) return { status: "pending" };
    const { originalSessionId } = state;
    if (!state.mapped)
      return {
        status: "completed-unindexed",
        originalSessionId,
        diagnostic: { entryId, reason: "unreferenced-completion" },
      };
    const refs = await readNativeCatalogReferences(
      join(configRoot, "workspace-hierarchy", "profile", "catalog.json"),
    );
    const referenced = refs.some(
      (ref) =>
        ref.commandId === intent.commandId &&
        ref.originalSessionId === originalSessionId &&
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
      return {
        status: "completed-unindexed",
        originalSessionId,
        diagnostic: { entryId, reason: "unreferenced-completion" },
      };
    return {
      status: "completed",
      originalSessionId,
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
