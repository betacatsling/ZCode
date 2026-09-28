import { z } from "zod";
import { repositoryBindingSchema, worktreeWorkspaceSchema } from "@zcode/shared/agent-host";
import type { IWorktreeRemovalService } from "./removalContract.js";
import type { IWorktreeBareRepositoryAdoptionService } from "./bareRepositoryAdoptionContract.js";

const stableIdSchema = z.string().trim().min(1).max(256);
const filesystemNumberSchema = z.number().int().nonnegative().nullable();

export const filesystemEvidenceSchema = z.strictObject({
  canonicalPath: z.string().min(1).max(4096),
  device: filesystemNumberSchema,
  inode: filesystemNumberSchema,
  birthtimeMs: z.number().nonnegative().nullable(),
});
export type FilesystemEvidence = z.infer<typeof filesystemEvidenceSchema>;

export const repositoryBindingRecordSchema = repositoryBindingSchema.extend({
  commonDirEvidence: filesystemEvidenceSchema,
});
export type RepositoryBindingRecord = z.infer<typeof repositoryBindingRecordSchema>;

export const worktreeWorkspaceRecordSchema = worktreeWorkspaceSchema.extend({
  filesystemEvidence: filesystemEvidenceSchema,
});
export type WorktreeWorkspaceRecord = z.infer<typeof worktreeWorkspaceRecordSchema>;

export const worktreeCreationReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  request: z.unknown(),
  workspaceId: stableIdSchema,
});
export type WorktreeCreationReceipt = z.infer<typeof worktreeCreationReceiptSchema>;

export const worktreeCatalogFileSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    bindings: z.array(repositoryBindingRecordSchema).max(10_000),
    workspaces: z.array(worktreeWorkspaceRecordSchema).max(50_000),
    creationReceipts: z.array(worktreeCreationReceiptSchema).max(50_000).default([]),
  })
  .superRefine((file, context) => {
    const bindingIds = new Set<string>();
    const workspaceIds = new Set<string>();
    const bindings = new Map<string, RepositoryBindingRecord>();
    for (const [index, binding] of file.bindings.entries()) {
      if (bindingIds.has(binding.id)) {
        context.addIssue({
          code: "custom",
          path: ["bindings", index, "id"],
          message: `duplicate-binding-id:${binding.id}`,
        });
      }
      bindingIds.add(binding.id);
      if (binding.commonDirEvidence.canonicalPath !== binding.gitCommonDir) {
        context.addIssue({
          code: "custom",
          path: ["bindings", index, "commonDirEvidence", "canonicalPath"],
          message: "binding evidence path must equal gitCommonDir",
        });
      }
      bindings.set(binding.id, binding);
    }
    for (const [index, workspace] of file.workspaces.entries()) {
      if (workspaceIds.has(workspace.id)) {
        context.addIssue({
          code: "custom",
          path: ["workspaces", index, "id"],
          message: `duplicate-workspace-id:${workspace.id}`,
        });
      }
      workspaceIds.add(workspace.id);
      if (workspace.filesystemEvidence.canonicalPath !== workspace.worktreePath) {
        context.addIssue({
          code: "custom",
          path: ["workspaces", index, "filesystemEvidence", "canonicalPath"],
          message: "workspace evidence path must equal worktreePath",
        });
      }
      const binding = bindings.get(workspace.repositoryBindingId);
      if (!binding || binding.projectId !== workspace.projectId) {
        context.addIssue({
          code: "custom",
          path: ["workspaces", index, "repositoryBindingId"],
          message: `invalid-workspace-binding:${workspace.repositoryBindingId}`,
        });
      }
    }
  });
export type WorktreeCatalogFile = z.infer<typeof worktreeCatalogFileSchema>;

const worktreeHeadSchema = worktreeWorkspaceSchema.shape.head;

export const worktreeCandidateSchema = z.strictObject({
  targetId: stableIdSchema,
  repositoryCommonDir: z.string().min(1).max(4096),
  commonDirEvidence: filesystemEvidenceSchema,
  worktreePath: z.string().min(1).max(4096),
  filesystemEvidence: filesystemEvidenceSchema,
  isMainWorktree: z.boolean(),
  locked: z.boolean().default(false),
  head: worktreeHeadSchema,
});
export type WorktreeCandidate = z.infer<typeof worktreeCandidateSchema>;

export interface GitExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface WorktreeGitExecPort {
  run(args: readonly string[]): Promise<GitExecResult>;
}

export interface WorktreeFilesystemPort {
  realpath(path: string): Promise<string>;
  identity(path: string): Promise<FilesystemEvidence>;
}

export interface WorktreePersistence {
  read(): Promise<unknown | null>;
  update(mutator: (current: unknown | null) => WorktreeCatalogFile): Promise<WorktreeCatalogFile>;
}

export type WorktreeDiscoveryResult =
  | {
      kind: "nonGit";
      targetId: string;
      inputPath: string;
      reason: "not-git" | "missing-path";
    }
  | {
      kind: "bare";
      targetId: string;
      inputPath: string;
      repositoryCommonDir: string;
      commonDirEvidence: FilesystemEvidence;
      candidates: readonly WorktreeCandidate[];
    }
  | {
      kind: "git";
      targetId: string;
      inputPath: string;
      repositoryCommonDir: string;
      commonDirEvidence: FilesystemEvidence;
      candidates: readonly WorktreeCandidate[];
    };

export interface WorktreeAdoption {
  binding: RepositoryBindingRecord;
  workspace: WorktreeWorkspaceRecord;
}

export const bareRepositoryAdoptionRequestSchema = z
  .strictObject({
    targetId: stableIdSchema,
    inputPath: z.string().min(1).max(4096),
    repositoryCommonDir: z.string().min(1).max(4096),
    commonDirEvidence: filesystemEvidenceSchema,
  })
  .superRefine((request, context) => {
    if (request.commonDirEvidence.canonicalPath !== request.repositoryCommonDir) {
      context.addIssue({
        code: "custom",
        path: ["commonDirEvidence", "canonicalPath"],
        message: "repository-common-dir-evidence-mismatch",
      });
    }
  });
export type { BareRepositoryAdoptionRequest } from "./bareRepositoryAdoptionContract.js";

const createWorkspaceIdSchema = z.string().trim().min(1).max(256);
const createWorkspaceRefSchema = z.string().trim().min(1).max(2048);

const createWorkspaceRequestBaseSchema = z.strictObject({
  requestId: createWorkspaceIdSchema,
  repositoryBindingId: createWorkspaceIdSchema,
  projectId: createWorkspaceIdSchema,
  worktreePath: z.string().min(1).max(4096),
  title: z.string().trim().min(1).max(256),
});

export const createWorkspaceRequestSchema = z.discriminatedUnion("mode", [
  createWorkspaceRequestBaseSchema.extend({
    mode: z.literal("new-branch"),
    baseRef: createWorkspaceRefSchema,
    newBranch: createWorkspaceRefSchema,
  }),
  createWorkspaceRequestBaseSchema.extend({
    mode: z.literal("existing-branch"),
    existingBranch: createWorkspaceRefSchema,
  }),
]);
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;

export type WorktreeCreateResult =
  | {
      status: "created" | "already-present";
      binding: RepositoryBindingRecord;
      workspace: WorktreeWorkspaceRecord;
      requestId: string;
    }
  | {
      status: "unregistered";
      requestId: string;
      candidate: WorktreeCandidate | null;
      error: string;
    };

export const updateWorkspaceRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("rename"),
    workspaceId: createWorkspaceIdSchema,
    title: z.string().trim().min(1).max(256),
  }),
  z.strictObject({
    operation: z.literal("archive"),
    workspaceId: createWorkspaceIdSchema,
  }),
  z.strictObject({
    operation: z.literal("unarchive"),
    workspaceId: createWorkspaceIdSchema,
  }),
]);
export type UpdateWorkspaceRequest = z.infer<typeof updateWorkspaceRequestSchema>;

export interface WorktreeRevalidation {
  status: "verified" | "needsVerification" | "missing";
  binding: RepositoryBindingRecord;
  workspace: WorktreeWorkspaceRecord;
}

export interface WorktreeAvailability {
  targetId: string;
  available: boolean;
  writable: boolean;
  reason?: string;
}

export const workspaceActivityObservationSchema = z.strictObject({
  complete: z.boolean(),
  state: z.enum(["idle", "busy", "unknown"]),
  ownerPresent: z.boolean().optional(),
  pendingCommandCount: z.number().int().nonnegative().optional(),
  pendingInputCount: z.number().int().nonnegative().optional(),
  pendingApprovalCount: z.number().int().nonnegative().optional(),
  activeTurnCount: z.number().int().nonnegative().optional(),
  reason: z.string().max(256).optional(),
});
export type WorkspaceActivityObservation = z.infer<typeof workspaceActivityObservationSchema>;

export interface IWorktreeService
  extends IWorktreeRemovalService, IWorktreeBareRepositoryAdoptionService {
  getAvailability(): Promise<WorktreeAvailability>;
  read(): Promise<WorktreeCatalogFile>;
  discover(inputPath: string): Promise<WorktreeDiscoveryResult>;
  adopt(projectId: string, candidate: WorktreeCandidate, title?: string): Promise<WorktreeAdoption>;
  createWorkspace(request: CreateWorkspaceRequest): Promise<WorktreeCreateResult>;
  updateWorkspace(request: UpdateWorkspaceRequest): Promise<WorktreeWorkspaceRecord>;
  revalidate(
    workspaceId: string,
    options?: { acceptRebuild?: boolean },
  ): Promise<WorktreeRevalidation>;
}
