import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";

const stableId = z.string().trim().min(1).max(256);
const managedWorkspaceAssociationSchema = z.strictObject({
  workspaceId: stableId,
  worktreeGeneration: stableId,
});

export const sessionMigrationSourceSchema = z.strictObject({
  sourceKey: z.string().min(1).max(2048),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  commandKey: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SessionMigrationSource = z.infer<typeof sessionMigrationSourceSchema>;

export const sessionHierarchyRecordSchema = z
  .strictObject({
    hierarchySessionId: stableId,
    nativeSessionId: stableId,
    ownerKind: z.enum(["native-v4", "agent-host"]).default("native-v4"),
    targetId: stableId,
    projectId: stableId.optional(),
    workspaceId: stableId.optional(),
    harnessId: stableId.optional(),
    workspacePath: z.string().min(1).max(4096),
    workspaceIdentity: z.string().max(2048).optional(),
    cwdRelativeToWorktree: z.string().min(1).max(4096).optional(),
    title: z.string().max(256).optional(),
    /** Present only when the owner persisted the stable workspace association itself. */
    ownerAssociation: managedWorkspaceAssociationSchema.optional(),
    /** Original persisted association for a read-only history row. */
    ownerHistoryAssociation: managedWorkspaceAssociationSchema.optional(),
    modelSelection: modelSelectionSchema.optional(),
    status: z.enum(["linked", "pending-verification"]),
    pendingReason: z
      .enum([
        "nonGit",
        "missing",
        "target-unavailable",
        "workspace-not-adopted",
        "unknown-harness",
        "cwd-unverified",
        "locator-incomplete",
        "workspace-archived",
        "workspace-removed",
        "needs-verification",
        "stale-generation",
        "identity-mismatch",
        "owner-state-unknown",
      ])
      .optional(),
  })
  .superRefine((record, context) => {
    if (record.status === "linked") {
      for (const field of [
        "projectId",
        "workspaceId",
        "harnessId",
        "cwdRelativeToWorktree",
      ] as const) {
        if (!record[field])
          context.addIssue({
            code: "custom",
            path: [field],
            message: "linked record requires this field",
          });
      }
      if (record.pendingReason)
        context.addIssue({
          code: "custom",
          path: ["pendingReason"],
          message: "linked record cannot be pending",
        });
      if (record.ownerAssociation && record.workspaceId !== record.ownerAssociation.workspaceId) {
        context.addIssue({
          code: "custom",
          path: ["ownerAssociation", "workspaceId"],
          message: "owner association must match linked workspace",
        });
      }
      if (
        record.ownerHistoryAssociation &&
        record.workspaceId !== record.ownerHistoryAssociation.workspaceId
      ) {
        context.addIssue({
          code: "custom",
          path: ["ownerHistoryAssociation", "workspaceId"],
          message: "history association must match the original workspace",
        });
      }
      if (record.ownerHistoryAssociation) {
        context.addIssue({
          code: "custom",
          path: ["ownerHistoryAssociation"],
          message: "linked record cannot carry a history-only association",
        });
      }
    } else if (!record.pendingReason) {
      context.addIssue({
        code: "custom",
        path: ["pendingReason"],
        message: "pending record requires a reason",
      });
    } else if (record.ownerAssociation) {
      context.addIssue({
        code: "custom",
        path: ["ownerAssociation"],
        message: "pending history cannot claim a current owner association",
      });
    }
  });
export type SessionHierarchyRecord = z.infer<typeof sessionHierarchyRecordSchema>;

export const sessionHierarchyFileSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    source: sessionMigrationSourceSchema,
    records: z.array(sessionHierarchyRecordSchema),
  })
  .superRefine((file, context) => {
    const ids = new Set<string>();
    const locators = new Set<string>();
    for (const [index, record] of file.records.entries()) {
      if (ids.has(record.hierarchySessionId))
        context.addIssue({
          code: "custom",
          path: ["records", index, "hierarchySessionId"],
          message: "duplicate hierarchy ID",
        });
      ids.add(record.hierarchySessionId);
      const locator = `${record.ownerKind}\0${record.targetId}\0${record.workspaceIdentity?.trim() || record.workspacePath}\0${record.nativeSessionId}`;
      if (locators.has(locator))
        context.addIssue({
          code: "custom",
          path: ["records", index],
          message: "duplicate source locator",
        });
      locators.add(locator);
    }
  });
export type SessionHierarchyFile = z.infer<typeof sessionHierarchyFileSchema>;

export const sessionHierarchyRollbackRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  appliedRevision: z.string().regex(/^[0-9a-f]{64}$/),
  previous: sessionHierarchyFileSchema.nullable(),
});
export type SessionHierarchyRollbackRecord = z.infer<typeof sessionHierarchyRollbackRecordSchema>;
