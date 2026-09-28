import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { SqliteSessionStore } from "@zcode/adapters/storage";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_ENTRY_WORKSPACE_GENERATION,
  type ProjectId,
  type SessionId,
  type WorkspaceId,
} from "@zcode/contracts";
import {
  managedWorkspaceSessionAssociationSchema,
  workspaceSessionModelBindingSchema,
  type AgentCommand,
  type AgentEvent,
  type BackendBinding,
  type ExecutionTarget,
  type HarnessCapabilities,
  type ModelSelection,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import { managedNativeWorkspaceSessionId } from "@zcode/shared/node";
import type { HarnessAdapter } from "../../src/agent-host/harnessRegistry.js";
import {
  AgentHostTargetService,
  type NativeWorkspaceSessionOwnerPort,
} from "../../src/agent-host/targetService.js";
import {
  createFileWorktreeService,
  createNodeWorkspaceAdmissionController,
  type IWorktreeService,
} from "../../src/worktree/index.js";

export const targetId = "target-session-create";
export const catalog = {
  fingerprint: "fake-pi-catalog",
  validateSelection: () => ({ ok: true as const }),
};

const execFile = promisify(execFileCallback);

export class NoCostPi implements HarnessAdapter {
  readonly id = "pi";
  readonly version = "fake-pi-1";
  readonly hostManagedRoute = "mock" as const;
  modelCalls = 0;
  creates = 0;
  attaches = 0;

  async probe(target: ExecutionTarget) {
    return target.available
      ? { support: "supported" as const }
      : { support: "unsupported" as const, reason: "target unavailable" };
  }
  async capabilities(_target: ExecutionTarget): Promise<HarnessCapabilities> {
    const yes = { support: "supported" as const };
    return {
      text: yes,
      tools: yes,
      approvals: yes,
      cancelTurn: yes,
      resumeExecution: yes,
      history: yes,
      images: { support: "unsupported", reason: "fixture" },
      modelSwitch: { support: "unsupported", reason: "fixture" },
    };
  }
  async hostManagedSupport(target: ExecutionTarget, _selection: ModelSelection) {
    return this.probe(target);
  }
  async harnessManagedSupport(target: ExecutionTarget, _nativeModelId?: string) {
    return this.probe(target);
  }
  async create(spec: SessionSpec): Promise<BackendBinding> {
    this.creates += 1;
    return {
      hostSessionId: spec.hostSessionId,
      backendSessionId: `fake-pi:${spec.hostSessionId}`,
      backendVersion: this.version,
      runtimeEpoch: randomUUID(),
    };
  }
  async attach(_spec: SessionSpec, _binding: BackendBinding): Promise<void> {
    this.attaches += 1;
  }
  async send(_command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    this.modelCalls += 1;
  }
  async cancelTurn(_command: Extract<AgentCommand, { type: "cancelTurn" }>): Promise<void> {}
  async resolveInteraction(
    _command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): Promise<void> {}
  async terminate(_hostSessionId: string): Promise<void> {}
  subscribe(_hostSessionId: string, _listener: (event: AgentEvent) => void): () => void {
    return () => undefined;
  }
}

export function createSqliteNativeOwner(dbPath: string): {
  port: NativeWorkspaceSessionOwnerPort;
  close(): void;
  failNextCreateAfterCommit(): void;
} {
  const store = new SqliteSessionStore({ dbPath });
  let failAfterCommit = false;

  async function lookup(sessionId: string) {
    const session = await store.getSession(sessionId as SessionId);
    if (!session) return null;
    const entries = await store.sessionEntries({ sessionID: session.id });
    const generationEntry =
      entries.find((entry) => entry.id === `${sessionId}:workspace-generation`) ??
      entries.find((entry) => entry.id === "workspace-generation");
    const data = generationEntry?.data as { managedWorkspaceSession?: unknown } | undefined;
    const association = data?.managedWorkspaceSession
      ? managedWorkspaceSessionAssociationSchema.parse(data.managedWorkspaceSession)
      : null;
    return {
      session,
      entries,
      association,
      locator: {
        sessionId,
        association,
        workspacePath: session.directory,
        workspaceIdentity: session.workspaceID ? String(session.workspaceID) : session.directory,
        title: session.title.slice(0, 256),
      },
    };
  }

  const port: NativeWorkspaceSessionOwnerPort = {
    async lookup({ sessionId }) {
      return (await lookup(sessionId))?.locator ?? null;
    },
    async create({ association, workspacePath, workspaceIdentity, selection, title }) {
      const sessionId = managedNativeWorkspaceSessionId(
        association.targetId,
        association.requestId,
      );
      const existing = await lookup(sessionId);
      if (existing?.association) {
        if (existing.association.requestFingerprint !== association.requestFingerprint) {
          throw new Error("workspace-session-idempotency-conflict");
        }
        if (title && existing.session.title !== title) {
          await store.updateSession({ id: sessionId as SessionId, title });
        }
        return { sessionId, reused: true };
      }
      if (
        existing &&
        (existing.session.directory !== workspacePath ||
          (existing.session.workspaceID ? String(existing.session.workspaceID) : workspacePath) !==
            workspaceIdentity)
      ) {
        throw new Error("workspace-session-idempotency-conflict");
      }
      const lostInitialTitle = failAfterCommit && Boolean(title);
      if (!existing) {
        await store.createSession({
          id: sessionId as SessionId,
          projectID: "workspace-session-test" as ProjectId,
          ...(workspaceIdentity === workspacePath
            ? {}
            : { workspaceID: workspaceIdentity as WorkspaceId }),
          slug: `managed-${association.requestId.slice(0, 16)}`,
          directory: workspacePath,
          title: lostInitialTitle ? "New Agent" : (title ?? "New Agent"),
          version: "native-owner-test",
        });
      }
      const now = Date.now();
      await store.saveSessionEntry({
        id: `${sessionId}:workspace-generation`,
        sessionID: sessionId as SessionId,
        type: SESSION_ENTRY_WORKSPACE_GENERATION,
        touchSession: false,
        time: { created: now, updated: now },
        data: {
          worktreeGeneration: association.worktreeGeneration,
          managedWorkspaceSession: association,
        },
      });
      await store.saveSessionEntry({
        id: `${sessionId}:runtime-model-selection`,
        sessionID: sessionId as SessionId,
        type: SESSION_ENTRY_MODEL_SELECTION,
        touchSession: false,
        time: { created: now, updated: now },
        data: selection,
      });
      if (failAfterCommit) {
        failAfterCommit = false;
        throw new Error("simulated-owner-response-loss");
      }
      return { sessionId, reused: Boolean(existing) };
    },
    async list(input) {
      const localWorkspace = input.workspaceIdentity === input.workspacePath;
      const sessions = await store.listSessions({
        directory: input.workspacePath,
        workspaceID: localWorkspace ? null : (input.workspaceIdentity as WorkspaceId),
        includeArchived: true,
        limit: 10_001,
        taskTypes: ["interactive"],
      });
      if (sessions.length > 10_000) throw new Error("native-owner-index-incomplete");
      const result: {
        sessionId: string;
        title?: string;
        modelBinding?: { kind: "native-selection"; selection: ModelSelection };
      }[] = [];
      for (const session of sessions) {
        const record = await lookup(String(session.id));
        if (
          !record?.association ||
          record.association.targetId !== input.targetId ||
          record.association.workspaceId !== input.workspaceId ||
          record.association.worktreeGeneration !== input.worktreeGeneration
        ) {
          continue;
        }
        const selection = record.entries
          .filter((entry) => entry.type === SESSION_ENTRY_MODEL_SELECTION)
          .at(-1)?.data as ModelSelection | undefined;
        const modelBinding = selection
          ? workspaceSessionModelBindingSchema.parse({ kind: "native-selection", selection })
          : undefined;
        result.push({
          sessionId: String(session.id),
          title: session.title,
          ...(modelBinding ? { modelBinding } : {}),
        });
      }
      return result;
    },
  };
  return {
    port,
    close: () => store.close(),
    failNextCreateAfterCommit: () => {
      failAfterCommit = true;
    },
  };
}

export async function git(cwd: string | undefined, args: readonly string[]): Promise<void> {
  await execFile("git", cwd ? ["-C", cwd, ...args] : [...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
}

export async function createLinkedWorktreeFixture(root: string) {
  const repo = join(root, "repo");
  const linked = join(root, "linked-worktree");
  await git(undefined, ["init", "-q", repo]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Workspace Session Test"]);
  await writeFile(join(repo, "README.md"), "fixture only\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-qm", "initial"]);
  await git(repo, ["worktree", "add", "-q", "-b", "session-test", linked]);
  const admission = createNodeWorkspaceAdmissionController({
    root: join(root, "admission"),
    targetId: () => targetId,
  });
  const worktrees = createFileWorktreeService({
    filePath: join(root, "worktrees.json"),
    admissionRoot: join(root, "admission"),
    admissionController: admission,
    targetId: () => targetId,
  });
  const discovery = await worktrees.discover(linked);
  if (discovery.kind !== "git") throw new Error("linked worktree discovery failed");
  const candidate = discovery.candidates.find((item) => item.worktreePath === linked);
  if (!candidate) throw new Error("linked worktree candidate missing");
  const adopted = await worktrees.adopt("project-session-test", candidate);
  const target = {
    id: targetId,
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  return { repo, linked, target, admission, worktrees, workspace: adopted.workspace };
}

export function createAgentHostTarget(input: {
  root: string;
  target: ExecutionTarget;
  registry: HarnessRegistry;
  worktrees: IWorktreeService;
  admission: ReturnType<typeof createNodeWorkspaceAdmissionController>;
  nativeOwner?: NativeWorkspaceSessionOwnerPort;
}): AgentHostTargetService {
  return new AgentHostTargetService({
    root: input.root,
    target: input.target,
    catalog,
    registry: input.registry,
    worktrees: input.worktrees,
    ...(input.nativeOwner ? { nativeOwner: input.nativeOwner } : {}),
    authorizeWorktree: async (spec, realPath) => {
      const current = (await input.worktrees.read()).workspaces.find(
        (item) => item.id === spec.execution.workspaceId,
      );
      return Boolean(
        current &&
        current.worktreePath === realPath &&
        spec.execution.worktreeGeneration === current.worktreeGeneration &&
        spec.execution.workspaceIdentity ===
          (current.workspaceIdentity?.trim() || current.worktreePath) &&
        current.lifecycle === "active" &&
        current.verification === "verified",
      );
    },
    withWorkspaceAdmission: async (spec, operation) => {
      const current = (await input.worktrees.read()).workspaces.find(
        (item) => item.id === spec.execution.workspaceId,
      );
      if (!current || current.worktreeGeneration !== spec.execution.worktreeGeneration) {
        throw new Error("stale-or-unavailable-workspace-generation");
      }
      return input.admission.withWorkspace(
        {
          targetId,
          workspaceId: current.id,
          workspaceIdentity: current.workspaceIdentity,
          workspacePath: current.worktreePath,
          expectedGeneration: current.worktreeGeneration,
        },
        operation,
      );
    },
    checkAdmissionFence: async (request) => {
      const current = (await input.worktrees.read()).workspaces.find(
        (item) => item.id === request.id,
      );
      if (!current || current.worktreeGeneration !== request.worktreeGeneration) {
        throw new Error("stale-or-unavailable-workspace-generation");
      }
      const fence = await input.admission.readFence(current);
      if (
        !fence ||
        fence.targetId !== targetId ||
        fence.workspaceId !== current.id ||
        fence.worktreePath !== current.worktreePath ||
        fence.worktreeGeneration !== current.worktreeGeneration ||
        fence.lifecycle !== "active"
      ) {
        throw new Error(`workspace-admission-${fence?.lifecycle ?? "unregistered"}`);
      }
    },
  });
}
