import { z } from "zod";
import {
  agentHostSessionMetadataSchema,
  assertUniqueHostSessionIds,
  resolveSessionHarness,
  sessionSpecSchema,
  type AgentHostSessionMetadata,
} from "@zcode/shared/agent-host";
import { HarnessRegistry, type HarnessAdapter } from "./harnessRegistry.js";

const hostSessionIdSchema = sessionSpecSchema.shape.hostSessionId;

export type SessionRoute =
  | { kind: "native" }
  | {
      kind: "external";
      hostSessionId: string;
      harness: HarnessAdapter;
      metadata: AgentHostSessionMetadata;
    };

const legacySessionRecordSchema = z
  .object({
    sessionId: hostSessionIdSchema.optional(),
    taskId: hostSessionIdSchema.optional(),
    workspaceId: z.string().trim().min(1).max(256).optional(),
    workspacePath: z.string().min(1).max(4096).optional(),
    workspaceIdentity: z.string().max(4096).optional(),
    provider: z.string().trim().min(1).max(128).optional(),
    migrationSource: z.string().trim().min(1).max(128).optional(),
    harnessId: z.string().trim().min(1).max(128).optional(),
    agentHost: agentHostSessionMetadataSchema.optional(),
  })
  .strict();
type LegacySessionRecord = z.infer<typeof legacySessionRecordSchema>;

export type LegacySessionRead =
  | {
      kind: "native";
      hostSessionId: string;
      harnessId: "zcode";
      provider?: "glm";
      workspaceId?: string;
    }
  | {
      kind: "external";
      hostSessionId: string;
      harnessId: string;
      provider?: string;
      workspaceId?: string;
    }
  | {
      kind: "unresolved";
      reason: "unknown-backend" | "imported-history";
      hostSessionId: string;
      provider?: string;
      harnessId?: string;
      migrationSource?: string;
      workspaceId?: string;
    };

/**
 * Session commands from `createWorktreeService` (PR #5). This branch does not
 * vendor Project Catalog or worktree lifecycle; callers inject that service or a test double.
 * `id` is the existing host session id.
 */
export interface WorkspaceSessionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly harnessId: string;
  readonly title: string;
}

/** Mirrors the worktree service ExecutionLocation. Paths stay owned by that service. */
export interface WorkspaceExecutionLocation {
  readonly executionTargetId: string;
  readonly workspaceId: string;
  readonly worktreePath: string;
  readonly worktreeGeneration: string;
  readonly workspaceKey: string;
  readonly cwdRelativeToWorktree: string | null;
  readonly admissible: boolean;
  readonly reason?: string;
}

export interface WorkspaceSessionOwnership {
  listSessions(workspaceId: string): Promise<readonly WorkspaceSessionRecord[]>;
  readExecution(sessionId: string): Promise<WorkspaceExecutionLocation>;
  createAgentSession(input: {
    workspaceId: string;
    harnessId: string;
    title: string;
    cwdRelativeToWorktree?: string;
  }): Promise<{ session: WorkspaceSessionRecord; execution: WorkspaceExecutionLocation }>;
}

export interface WorkspaceSessionAdmission {
  readonly kind: "native" | "external";
  readonly session: WorkspaceSessionRecord;
  readonly execution: WorkspaceExecutionLocation;
  readonly harness?: HarnessAdapter;
}

/** Facade decision only. Native V4 is forwarded unchanged; this must not acquire a second owner. */
export class SessionRouter {
  constructor(
    readonly registry: HarnessRegistry,
    readonly policy: { allowExternalAdmission: boolean; enabledHarnesses?: ReadonlySet<string> },
    readonly workspaces?: WorkspaceSessionOwnership,
  ) {}

  /**
   * Asks the worktree service to attach another host session to an adopted workspace.
   * Discovery, worktree creation and removal stay on that service.
   */
  async openWorkspaceSession(input: {
    workspaceId: string;
    harnessId: string;
    title: string;
    cwdRelativeToWorktree?: string;
  }): Promise<WorkspaceSessionAdmission> {
    const harnessId = input.harnessId.trim();
    if (harnessId !== "zcode") this.assertCanCreate(harnessId);
    const workspaces = this.#workspaces();
    const created = await workspaces.createAgentSession({ ...input, harnessId });
    assertWorkspaceExecution(created.execution);
    if (harnessId === "zcode") {
      return { kind: "native", session: created.session, execution: created.execution };
    }
    return {
      kind: "external",
      session: created.session,
      execution: created.execution,
      harness: this.registry.require(harnessId),
    };
  }

  /** Legacy identity is classified here; workspace binding is read from the worktree service. */
  async locateLegacySession(
    value: unknown,
  ): Promise<{ read: LegacySessionRead; execution?: WorkspaceExecutionLocation }> {
    const read = readLegacyZCodeSession(value);
    if (read.kind === "unresolved") return { read };
    const execution = await this.#workspaces().readExecution(read.hostSessionId);
    assertWorkspaceExecution(execution);
    return { read, execution };
  }

  async listWorkspaceSessions(
    workspaceId: string,
  ): Promise<
    ReadonlyMap<
      string,
      readonly { hostSessionId: string; workspaceId: string; harnessId: string }[]
    >
  > {
    const sessions = await this.#workspaces().listSessions(workspaceId);
    return indexHostSessions(
      sessions.map((session) => ({
        hostSessionId: session.id,
        workspaceId: session.workspaceId,
        harnessId: session.harnessId,
      })),
    );
  }

  #workspaces(): WorkspaceSessionOwnership {
    if (!this.workspaces) throw new Error("workspace-ownership-unavailable");
    return this.workspaces;
  }

  resolve(
    session: { sessionId: string; agentHost?: AgentHostSessionMetadata },
    targetId: string,
  ): SessionRoute {
    if (!session.agentHost) return { kind: "native" };
    const metadata = agentHostSessionMetadataSchema.parse(session.agentHost);
    if (metadata.hostSessionId !== session.sessionId) throw new Error("session identity mismatch");
    if (metadata.targetId !== targetId) throw new Error("session target identity mismatch");
    // 旧 sidecar 写 harness=zcode 仍是原生 owner。拒绝会挡住历史读取，改写成外部会话又会造出第二份可写状态。
    if (metadata.harnessId === "zcode") return { kind: "native" };
    return {
      kind: "external",
      metadata,
      hostSessionId: metadata.hostSessionId,
      harness: this.registry.require(metadata.harnessId),
    };
  }

  assertCanCreate(harnessId: string): HarnessAdapter {
    if (harnessId === "zcode") throw new Error("native sessions must use the existing V4 route");
    if (
      !this.policy.allowExternalAdmission ||
      (this.policy.enabledHarnesses && !this.policy.enabledHarnesses.has(harnessId))
    ) {
      throw new Error(`external harness disabled: ${harnessId}`);
    }
    return this.registry.require(harnessId);
  }
}

/** Rejects a worktree-service location that is not admissible. Does not create or delete a worktree. */
export function assertWorkspaceExecution(
  execution: WorkspaceExecutionLocation,
  expected?: {
    readonly targetId?: string;
    readonly workspaceId?: string;
    readonly worktreePath?: string;
    readonly worktreeGeneration?: string;
  },
): void {
  if (!execution.admissible) throw new Error(execution.reason ?? "workspace-not-admissible");
  if (
    (expected?.targetId !== undefined && expected.targetId !== execution.executionTargetId) ||
    (expected?.workspaceId !== undefined && expected.workspaceId !== execution.workspaceId) ||
    (expected?.worktreePath !== undefined && expected.worktreePath !== execution.worktreePath) ||
    (expected?.worktreeGeneration !== undefined &&
      expected.worktreeGeneration !== execution.worktreeGeneration)
  ) {
    throw new Error("session target identity mismatch");
  }
}

/** Known native history becomes harness=zcode. Missing provider is not filled in as glm. */
export function readLegacyZCodeSession(value: unknown): LegacySessionRead {
  const record = legacySessionRecordSchema.parse(value);
  const hostSessionId = recordSessionId(record);
  if (record.agentHost && record.agentHost.hostSessionId !== hostSessionId) {
    throw new Error("session identity mismatch");
  }
  const workspaceId = record.workspaceId;
  if (record.migrationSource) {
    return {
      kind: "unresolved",
      reason: "imported-history",
      hostSessionId,
      migrationSource: record.migrationSource,
      ...(record.provider ? { provider: record.provider } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    };
  }
  if (record.agentHost) {
    const harnessId = resolveSessionHarness(record.agentHost);
    if (harnessId === "zcode") return nativeRead(record, hostSessionId);
    return externalRead(record, hostSessionId, harnessId);
  }
  if (record.harnessId === "glm") {
    return {
      kind: "unresolved",
      reason: "unknown-backend",
      hostSessionId,
      harnessId: record.harnessId,
      ...(record.provider ? { provider: record.provider } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    };
  }
  if (record.harnessId && record.harnessId !== "zcode") {
    return externalRead(record, hostSessionId, record.harnessId);
  }
  if (record.provider && record.provider !== "glm") {
    return {
      kind: "unresolved",
      reason: "unknown-backend",
      hostSessionId,
      provider: record.provider,
      ...(workspaceId ? { workspaceId } : {}),
    };
  }
  return nativeRead(record, hostSessionId);
}

/** Admission identity stays hostSessionId. workspace + harness is only a grouping key. */
export function indexHostSessions<
  T extends {
    readonly hostSessionId: string;
    readonly workspaceId: string;
    readonly harnessId: string;
  },
>(sessions: readonly T[]): ReadonlyMap<string, readonly T[]> {
  assertUniqueHostSessionIds(sessions);
  const grouped = new Map<string, T[]>();
  for (const session of sessions) {
    const key = `${session.workspaceId}\0${session.harnessId}`;
    const current = grouped.get(key);
    if (current) current.push(session);
    else grouped.set(key, [session]);
  }
  return grouped;
}

function recordSessionId(record: LegacySessionRecord): string {
  if (record.sessionId && record.taskId && record.sessionId !== record.taskId) {
    throw new Error("session identity mismatch");
  }
  const id = record.sessionId ?? record.taskId;
  if (!id) throw new Error("session identity mismatch");
  return hostSessionIdSchema.parse(id);
}

function nativeRead(record: LegacySessionRecord, hostSessionId: string): LegacySessionRead {
  return {
    kind: "native",
    hostSessionId,
    harnessId: "zcode",
    ...(record.provider === "glm" ? { provider: "glm" as const } : {}),
    ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
  };
}

function externalRead(
  record: LegacySessionRecord,
  hostSessionId: string,
  harnessId: string,
): LegacySessionRead {
  return {
    kind: "external",
    hostSessionId,
    harnessId,
    ...(record.provider ? { provider: record.provider } : {}),
    ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
  };
}
