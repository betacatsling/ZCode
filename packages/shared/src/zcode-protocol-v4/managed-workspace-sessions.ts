import { z } from "zod";
import { workspaceSessionOwnerLocatorSchema } from "../agent-host/workspace-session.js";

const stableId = z.string().trim().min(1).max(256);

/** Internal owner query; paths are target-derived by Host and are used only for exact isolation. */
export const v4ManagedWorkspaceSessionsParamsSchema = z.strictObject({
  targetId: stableId,
  workspaceId: stableId,
  worktreeGeneration: stableId,
  workspacePath: z.string().min(1).max(4096),
  workspaceIdentity: z.string().trim().min(1).max(2048),
});
export type V4ManagedWorkspaceSessionsParams = z.infer<
  typeof v4ManagedWorkspaceSessionsParamsSchema
>;

export const v4ManagedWorkspaceSessionsResultSchema = z.strictObject({
  sessions: z.array(workspaceSessionOwnerLocatorSchema).max(10_000),
});
export type V4ManagedWorkspaceSessionsResult = z.infer<
  typeof v4ManagedWorkspaceSessionsResultSchema
>;

export const v4ManagedWorkspaceSessionLookupParamsSchema = z.strictObject({
  targetId: stableId,
  sessionId: stableId,
});
export type V4ManagedWorkspaceSessionLookupParams = z.infer<
  typeof v4ManagedWorkspaceSessionLookupParamsSchema
>;

export const v4ManagedWorkspaceSessionLookupResultSchema = z.strictObject({
  owner: z
    .strictObject({
      sessionId: stableId,
      association: z
        .object({
          targetId: stableId,
          workspaceId: stableId,
          worktreeGeneration: stableId,
          requestId: z.string().trim().min(1).max(256),
          requestFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .strict()
        .nullable(),
      workspacePath: z.string().min(1).max(4096),
      workspaceIdentity: z.string().trim().min(1).max(2048).optional(),
      title: z.string().max(256),
    })
    .nullable(),
});
export type V4ManagedWorkspaceSessionLookupResult = z.infer<
  typeof v4ManagedWorkspaceSessionLookupResultSchema
>;
