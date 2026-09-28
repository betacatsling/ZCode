import { isRemoteWorkspaceIdentity, type ZCodeTaskMeta } from "@zcode/shared";
import type { LegacySessionLocator, SessionIndexPort } from "../contract.js";

export interface PersistedTaskMetaReader {
  listTaskMetas(params: {}): Promise<readonly ZCodeTaskMeta[]>;
}

/** Project durable task-index facts; only proven local rows receive target/zcode/cwd defaults. */
export function createTaskIndexSessionSource(
  repo: PersistedTaskMetaReader,
  targetId?: string,
): SessionIndexPort {
  return {
    async listPersistedSessionLocators(): Promise<readonly LegacySessionLocator[]> {
      return (await repo.listTaskMetas({})).map((meta) => {
        const workspaceIdentity = meta.workspaceIdentity?.trim();
        const remote = workspaceIdentity ? isRemoteWorkspaceIdentity(workspaceIdentity) : false;
        const imported = meta.migrationSource === "claudeCode";
        return {
          sourceKey: `${meta.workspaceIdentity ?? meta.workspacePath}:${meta.taskId}`,
          nativeSessionId: meta.taskId,
          ownerKind: "native-v4" as const,
          ...(targetId && !remote ? { targetId } : {}),
          workspacePath: meta.workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(targetId && !remote && !imported ? { cwd: meta.workspacePath } : {}),
          ...(targetId && !remote && !imported ? { harnessId: "zcode" } : {}),
          ...(meta.model ? { legacyModelId: meta.model } : {}),
        };
      });
    },
  };
}
