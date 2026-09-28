import {
  projectCatalogTargetConnectionSchema,
  type ProjectCatalogTargetConnection,
  type SidebarFreshness,
} from "@zcode/shared/agent-host";
import { z } from "zod";
import {
  createProjectInputSchema,
  projectCatalogFileSchema,
  projectCatalogProjectSchema,
  setDefaultWorkspaceRefInputSchema,
  setWorkspaceRefsRequestSchema,
  updateProjectPatchSchema,
  type CreateProjectInput,
  type IProjectCatalogService,
  type ProjectCatalogFile,
  type ProjectCatalogPersistence,
  type ProjectCatalogProject,
  type ProjectCatalogReadModel,
  type UpdateProjectPatch,
  projectCatalogReadModelSchema,
} from "../contract.js";
import {
  emptyProjectCatalogFile,
  createProjectRecord,
  parseProjectCatalog,
  sameProjectRecord,
} from "../domain/catalogState.js";
import { createTargetSnapshotMutations } from "./targetSnapshotMutations.js";

interface MutationResult<T> {
  state: ProjectCatalogFile;
  result: T;
}

export interface ProjectCatalogServiceDependencies {
  persistence: ProjectCatalogPersistence;
}

const stableIdSchema = z.string().trim().min(1).max(256);
const targetConnectionListSchema = z
  .array(projectCatalogTargetConnectionSchema)
  .max(10_000)
  .superRefine((connections, context) => {
    const seen = new Set<string>();
    for (const [index, connection] of connections.entries()) {
      if (seen.has(connection.targetId)) {
        context.addIssue({
          code: "custom",
          path: [index, "targetId"],
          message: `duplicate-target-connection:${connection.targetId}`,
        });
      }
      seen.add(connection.targetId);
    }
  });

function effectiveFreshness(
  cached: SidebarFreshness,
  connected?: ProjectCatalogTargetConnection["state"],
): SidebarFreshness {
  if (connected === "offline") return "offline";
  if (connected === "unknown") return "unknown";
  if (connected === "connected") return cached === "live" ? "live" : "stale";
  return cached === "offline" || cached === "stale" ? cached : "unknown";
}

function applyConnectionState(
  state: ProjectCatalogFile,
  connections: readonly ProjectCatalogTargetConnection[],
): ProjectCatalogReadModel {
  const connectionByTarget = new Map(connections.map((item) => [item.targetId, item.state]));
  const targetsById = new Map(state.targets.map((item) => [item.targetId, item]));
  const targetIds = new Set([...targetsById.keys(), ...connectionByTarget.keys()]);
  const targets = [...targetIds].map((targetId) => {
    const cached = targetsById.get(targetId);
    const connection = connectionByTarget.get(targetId);
    return {
      targetId,
      freshness: cached
        ? effectiveFreshness(cached.freshness, connection)
        : connection === "offline"
          ? "offline"
          : connection === "connected"
            ? "stale"
            : "unknown",
      lastVerifiedAt: cached?.lastVerifiedAt ?? null,
      freshnessUpdatedAt: cached?.freshnessUpdatedAt ?? null,
      ...(cached?.presentation ? { presentation: cached.presentation } : {}),
    };
  });
  const projects = state.projects.map((project) => ({
    ...project,
    repositoryReferences: project.repositoryReferences.map((reference) => ({
      ...reference,
      targetFreshness: effectiveFreshness(
        reference.targetFreshness,
        connectionByTarget.get(reference.targetId),
      ),
    })),
    workspaceReferences: project.workspaceReferences.map((reference) => {
      if (reference.targetId === null) return reference;
      const targetFreshness = effectiveFreshness(
        reference.targetFreshness,
        connectionByTarget.get(reference.targetId),
      );
      const summary = reference.presentation?.sessionSummary;
      if (!summary) return { ...reference, targetFreshness };
      const summaryFreshness = targetFreshness === "live" ? summary.freshness : targetFreshness;
      if (summaryFreshness === summary.freshness) return { ...reference, targetFreshness };
      return {
        ...reference,
        targetFreshness,
        presentation: {
          ...reference.presentation!,
          sessionSummary: {
            ...summary,
            freshness: summaryFreshness,
            sessions: summary.sessions.map((session) => ({
              ...session,
              freshness: summaryFreshness,
            })),
          },
        },
      };
    }),
  }));
  return projectCatalogReadModelSchema.parse({ schemaVersion: 1, projects, targets });
}

export function createProjectCatalogService(
  dependencies: ProjectCatalogServiceDependencies,
): IProjectCatalogService {
  let writeQueue: Promise<unknown> = Promise.resolve();
  const enqueueWrite = <T>(task: () => Promise<T>): Promise<T> => {
    const queued = writeQueue.then(task, task) as Promise<T>;
    writeQueue = queued.catch(() => undefined);
    return queued;
  };

  async function read(): Promise<ProjectCatalogFile> {
    await writeQueue;
    const raw = await dependencies.persistence.read();
    return raw === null ? emptyProjectCatalogFile() : parseProjectCatalog(raw);
  }

  async function mutate<T>(
    mutator: (current: ProjectCatalogFile) => MutationResult<T>,
  ): Promise<T> {
    return enqueueWrite(async () => {
      let result!: T;
      await dependencies.persistence.update((raw) => {
        const current = raw === null ? emptyProjectCatalogFile() : parseProjectCatalog(raw);
        const mutation = mutator(current);
        result = mutation.result;
        return parseProjectCatalog(mutation.state);
      });
      return result;
    });
  }

  function requireProject(state: ProjectCatalogFile, id: string): ProjectCatalogProject {
    const project = state.projects.find((candidate) => candidate.id === id.trim());
    if (!project) throw new Error(`unknown-project:${id.trim()}`);
    return project;
  }

  function replaceProject(
    state: ProjectCatalogFile,
    project: ProjectCatalogProject,
  ): ProjectCatalogFile {
    return projectCatalogFileSchema.parse({
      ...state,
      projects: state.projects.map((candidate) =>
        candidate.id === project.id ? project : candidate,
      ),
    });
  }

  async function readWorkspaceCatalog(
    targetConnections: readonly ProjectCatalogTargetConnection[] = [],
  ): Promise<ProjectCatalogReadModel> {
    const connections = targetConnectionListSchema.parse(targetConnections);
    return applyConnectionState(await read(), connections);
  }

  const targetSnapshotMutations = createTargetSnapshotMutations(mutate);

  return {
    read,
    readWorkspaceCatalog,
    ...targetSnapshotMutations,

    async createProject(input: CreateProjectInput): Promise<ProjectCatalogProject> {
      const candidate = createProjectRecord(createProjectInputSchema.parse(input));
      return mutate((current) => {
        const existing = current.projects.find((project) => project.id === candidate.id);
        if (existing) {
          if (sameProjectRecord(existing, candidate)) return { state: current, result: existing };
          throw new Error(`duplicate-project-id:${candidate.id}`);
        }
        const state = projectCatalogFileSchema.parse({
          ...current,
          projects: [...current.projects, candidate],
        });
        return { state, result: candidate };
      });
    },

    async updateProject(id: string, patch: UpdateProjectPatch): Promise<ProjectCatalogProject> {
      const normalizedId = stableIdSchema.parse(id);
      const checkedPatch = updateProjectPatchSchema.parse(patch);
      return mutate((current) => {
        const existing = requireProject(current, normalizedId);
        const next = projectCatalogProjectSchema.parse({
          ...existing,
          ...(checkedPatch.name === undefined ? {} : { name: checkedPatch.name }),
          ...(checkedPatch.iconAssetId === undefined
            ? {}
            : checkedPatch.iconAssetId === null
              ? { iconAssetId: undefined }
              : { iconAssetId: checkedPatch.iconAssetId }),
          ...(checkedPatch.pinned === undefined ? {} : { pinned: checkedPatch.pinned }),
          ...(checkedPatch.sortOrder === undefined ? {} : { sortOrder: checkedPatch.sortOrder }),
        });
        const state = sameProjectRecord(existing, next) ? current : replaceProject(current, next);
        return { state, result: next };
      });
    },

    async setWorkspaceRefs(id, workspaceIds, defaultWorkspaceId): Promise<ProjectCatalogProject> {
      const request = setWorkspaceRefsRequestSchema.parse({ id, workspaceIds, defaultWorkspaceId });
      return mutate((current) => {
        const existing = requireProject(current, request.id);
        const legacyReferences = request.workspaceIds.map((workspaceId) => ({
          projectId: existing.id,
          targetId: null,
          workspaceId,
          repositoryBindingId: null,
          verification: "needsVerification" as const,
          lastVerifiedAt: null,
          targetFreshness: "unknown" as const,
          presentation: null,
        }));
        const next = projectCatalogProjectSchema.parse({
          ...existing,
          workspaceIds: request.workspaceIds,
          workspaceReferences: [
            ...existing.workspaceReferences.filter((reference) => reference.targetId !== null),
            ...legacyReferences,
          ],
          ...(request.defaultWorkspaceId === undefined
            ? {}
            : request.defaultWorkspaceId === null
              ? { defaultWorkspaceId: undefined, defaultWorkspaceTargetId: undefined }
              : {
                  defaultWorkspaceId: request.defaultWorkspaceId,
                  defaultWorkspaceTargetId:
                    existing.defaultWorkspaceId === request.defaultWorkspaceId
                      ? existing.defaultWorkspaceTargetId
                      : undefined,
                }),
        });
        const state = sameProjectRecord(existing, next) ? current : replaceProject(current, next);
        return { state, result: next };
      });
    },

    async setDefaultWorkspaceRef(id, reference): Promise<ProjectCatalogProject> {
      const normalizedId = stableIdSchema.parse(id);
      const checkedReference = setDefaultWorkspaceRefInputSchema.parse(reference);
      return mutate((current) => {
        const existing = requireProject(current, normalizedId);
        if (
          checkedReference &&
          !existing.workspaceReferences.some(
            (item) =>
              item.targetId === checkedReference.targetId &&
              item.workspaceId === checkedReference.workspaceId,
          )
        ) {
          throw new Error("unknown-target-workspace-reference");
        }
        const next = projectCatalogProjectSchema.parse({
          ...existing,
          defaultWorkspaceId: checkedReference?.workspaceId,
          defaultWorkspaceTargetId: checkedReference?.targetId,
        });
        const state = sameProjectRecord(existing, next) ? current : replaceProject(current, next);
        return { state, result: next };
      });
    },
  };
}
