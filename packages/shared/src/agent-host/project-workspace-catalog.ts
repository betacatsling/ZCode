import { z } from "zod";
import {
  sidebarAggregateSchema,
  sidebarFreshnessSchema,
  sidebarSessionRowSchema,
} from "./sidebar.js";
import { repositoryBindingSchema, worktreeWorkspaceSchema } from "./hierarchy.js";

const stableIdSchema = z.string().trim().min(1).max(256);
const timestampSchema = z.number().int().nonnegative();

/** Display data kept by the profile Catalog; it deliberately has no path or generation. */
export const projectCatalogWorkspacePresentationSchema = z.strictObject({
  worktree: z.strictObject({
    title: z.string().trim().min(1).max(256),
    head: worktreeWorkspaceSchema.shape.head,
    isMainWorktree: z.boolean(),
    lifecycle: worktreeWorkspaceSchema.shape.lifecycle,
  }),
  sessionSummary: z
    .strictObject({
      verifiedAt: timestampSchema,
      freshness: sidebarFreshnessSchema,
      sessions: z.array(sidebarSessionRowSchema).max(10_000),
      summary: sidebarAggregateSchema,
    })
    .optional(),
});
export type ProjectCatalogWorkspacePresentation = z.infer<
  typeof projectCatalogWorkspacePresentationSchema
>;

/** A Project-scoped reference. Null target/binding values are legacy, unverified IDs only. */
export const projectWorkspaceReferenceSchema = z
  .strictObject({
    projectId: stableIdSchema,
    targetId: stableIdSchema.nullable(),
    workspaceId: stableIdSchema,
    repositoryBindingId: stableIdSchema.nullable(),
    verification: z.enum(["verified", "needsVerification"]),
    lastVerifiedAt: timestampSchema.nullable(),
    targetFreshness: sidebarFreshnessSchema,
    presentation: projectCatalogWorkspacePresentationSchema.nullable(),
  })
  .superRefine((reference, context) => {
    if (reference.targetId === null) {
      if (
        reference.repositoryBindingId !== null ||
        reference.verification !== "needsVerification" ||
        reference.lastVerifiedAt !== null ||
        reference.targetFreshness !== "unknown" ||
        reference.presentation !== null
      ) {
        context.addIssue({
          code: "custom",
          path: ["targetId"],
          message: "unscoped-reference-needs-verification",
        });
      }
      return;
    }
    if (reference.repositoryBindingId === null) {
      context.addIssue({
        code: "custom",
        path: ["repositoryBindingId"],
        message: "scoped-reference-requires-binding",
      });
    }
    if (reference.lastVerifiedAt === null && reference.presentation !== null) {
      context.addIssue({
        code: "custom",
        path: ["presentation"],
        message: "presentation-requires-target-verification",
      });
    }
    if (reference.verification === "verified" && reference.presentation === null) {
      context.addIssue({
        code: "custom",
        path: ["presentation"],
        message: "verified-reference-requires-presentation",
      });
    }
  });
export type ProjectWorkspaceReference = z.infer<typeof projectWorkspaceReferenceSchema>;

export const projectRepositoryReferenceSchema = z.strictObject({
  projectId: stableIdSchema,
  targetId: stableIdSchema,
  repositoryBindingId: stableIdSchema,
  lastVerifiedAt: timestampSchema,
  targetFreshness: sidebarFreshnessSchema,
});
export type ProjectRepositoryReference = z.infer<typeof projectRepositoryReferenceSchema>;

/** Optional display-only target label; it never identifies or routes an attachment. */
export const projectCatalogTargetPresentationSchema = z.strictObject({
  kind: z.enum(["local", "ssh", "wsl", "docker", "unknown"]),
  displayName: z.string().trim().min(1).max(256).optional(),
});
export type ProjectCatalogTargetPresentation = z.infer<
  typeof projectCatalogTargetPresentationSchema
>;

export const projectCatalogTargetFreshnessSchema = z.strictObject({
  targetId: stableIdSchema,
  freshness: sidebarFreshnessSchema,
  lastVerifiedAt: timestampSchema.nullable(),
  freshnessUpdatedAt: timestampSchema.nullable(),
  presentation: projectCatalogTargetPresentationSchema.optional(),
});
export type ProjectCatalogTargetFreshness = z.infer<typeof projectCatalogTargetFreshnessSchema>;

/** Current connection information is a read-time overlay, never a routing capability. */
export const projectCatalogTargetConnectionSchema = z.strictObject({
  targetId: stableIdSchema,
  state: z.enum(["connected", "offline", "unknown"]),
});
export type ProjectCatalogTargetConnection = z.infer<typeof projectCatalogTargetConnectionSchema>;

const targetSnapshotBindingSchema = repositoryBindingSchema.pick({
  id: true,
  projectId: true,
  executionTargetId: true,
});

const targetSnapshotWorkspaceSchema = worktreeWorkspaceSchema.pick({
  id: true,
  projectId: true,
  repositoryBindingId: true,
  title: true,
  isMainWorktree: true,
  head: true,
  lifecycle: true,
  verification: true,
});

const targetWorkspaceSessionSummarySchema = z.strictObject({
  workspaceId: stableIdSchema,
  sessions: z.array(sidebarSessionRowSchema).max(10_000),
  summary: sidebarAggregateSchema,
});

/**
 * Minimal profile-cache input projected from an authoritative target service
 * read. Execution paths, generations, Git common paths, and connection IDs
 * intentionally do not cross this contract.
 */
export const projectCatalogTargetSnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    targetId: stableIdSchema,
    observedAt: timestampSchema,
    targetPresentation: projectCatalogTargetPresentationSchema.optional(),
    bindings: z.array(targetSnapshotBindingSchema).max(10_000),
    workspaces: z.array(targetSnapshotWorkspaceSchema).max(50_000),
    sessionSummaries: z.array(targetWorkspaceSessionSummarySchema).max(50_000),
  })
  .superRefine((snapshot, context) => {
    const bindings = new Map(snapshot.bindings.map((binding) => [binding.id, binding]));
    const workspaceIds = new Set<string>();
    const bindingIds = new Set<string>();
    for (const [index, binding] of snapshot.bindings.entries()) {
      if (bindingIds.has(binding.id)) {
        context.addIssue({
          code: "custom",
          path: ["bindings", index, "id"],
          message: `duplicate-binding-id:${binding.id}`,
        });
      }
      bindingIds.add(binding.id);
      if (binding.executionTargetId !== snapshot.targetId) {
        context.addIssue({
          code: "custom",
          path: ["bindings", index, "executionTargetId"],
          message: "snapshot-target-mismatch",
        });
      }
    }
    for (const [index, workspace] of snapshot.workspaces.entries()) {
      if (workspaceIds.has(workspace.id)) {
        context.addIssue({
          code: "custom",
          path: ["workspaces", index, "id"],
          message: `duplicate-workspace-id:${workspace.id}`,
        });
      }
      workspaceIds.add(workspace.id);
      if (bindings.get(workspace.repositoryBindingId)?.projectId !== workspace.projectId) {
        context.addIssue({
          code: "custom",
          path: ["workspaces", index, "repositoryBindingId"],
          message: "snapshot-workspace-binding-mismatch",
        });
      }
    }
    const summaryWorkspaceIds = new Set<string>();
    for (const [index, item] of snapshot.sessionSummaries.entries()) {
      if (summaryWorkspaceIds.has(item.workspaceId)) {
        context.addIssue({
          code: "custom",
          path: ["sessionSummaries", index, "workspaceId"],
          message: `duplicate-session-summary:${item.workspaceId}`,
        });
      }
      summaryWorkspaceIds.add(item.workspaceId);
      if (!workspaceIds.has(item.workspaceId)) {
        context.addIssue({
          code: "custom",
          path: ["sessionSummaries", index, "workspaceId"],
          message: "summary-workspace-not-in-target-snapshot",
        });
      }
      for (const [sessionIndex, session] of item.sessions.entries()) {
        if (session.workspaceId !== item.workspaceId) {
          context.addIssue({
            code: "custom",
            path: ["sessionSummaries", index, "sessions", sessionIndex, "workspaceId"],
            message: "session-summary-workspace-mismatch",
          });
        }
      }
    }
  });
export type ProjectCatalogTargetSnapshot = z.infer<typeof projectCatalogTargetSnapshotSchema>;
