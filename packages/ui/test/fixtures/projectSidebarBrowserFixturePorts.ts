import type { AgentHostSessionSummary } from "@zcode/shared/agent-host";
import type {
  CreateWorkspaceRequest,
  WorktreeCandidate,
  WorktreeCreateResult,
} from "@zcode/services/worktree";
import { createProjectCatalogService } from "../../../services/src/project-catalog/app/projectCatalogService.js";
import type { SidebarBrowserFixtureState } from "./projectSidebarBrowserFixtureData.js";
import { createProjectSidebarAgentHostBrowserClient } from "./projectSidebarAgentHostBrowserClient.js";
import { createProjectSidebarBrowserServiceAccessor } from "./projectSidebarBrowserFixtureSessionServices.js";
import {
  currentCatalog,
  emptyMigration,
  evidence,
  makeBinding,
  makeCandidate,
  makeDirectory,
  makeWorkspace,
  PROFILE_CATALOG_KEY,
  REPOSITORY_COMMON_DIR,
  TARGET_ID,
} from "./projectSidebarBrowserFixtureData.js";

export function createServicePorts(state: SidebarBrowserFixtureState, hostGeneration = "v1") {
  const projectCatalogCore = createProjectCatalogService({
    persistence: {
      async read() {
        state.counters.catalogReads += 1;
        const snapshot = structuredClone(currentCatalog(state));
        if (!state.holdNextCatalogRead) return snapshot;
        state.holdNextCatalogRead = false;
        return new Promise<unknown>((resolve) => {
          state.heldCatalogReads.push(() => resolve(snapshot));
        });
      },
      async update(mutator) {
        const previous = structuredClone(currentCatalog(state));
        const next = mutator(previous);
        const changedExistingReferences = previous.projects.some((project) => {
          const updated = next.projects.find((candidate) => candidate.id === project.id);
          if (!updated) return false;
          const oldReferences = JSON.stringify([
            project.repositoryReferences,
            project.workspaceReferences,
          ]);
          const newReferences = JSON.stringify([
            updated.repositoryReferences,
            updated.workspaceReferences,
          ]);
          return (
            oldReferences !== newReferences &&
            (project.repositoryReferences.length > 0 || project.workspaceReferences.length > 0)
          );
        });
        if (changedExistingReferences) {
          if (state.failNextWorkspaceRefWrites > 0) {
            state.failNextWorkspaceRefWrites -= 1;
            throw new Error("fixture-catalog-reference-write-failed");
          }
        }
        state.catalogs.set(PROFILE_CATALOG_KEY, structuredClone(next));
        return next;
      },
    },
  });
  const projectCatalogService = {
    ...projectCatalogCore,
    async createProject(input: Parameters<typeof projectCatalogCore.createProject>[0]) {
      state.counters.createProjectCalls += 1;
      state.counters.createProjectIds.push(input.id);
      state.firstProjectId = input.id;
      if (state.failNextProjectCreates > 0) {
        state.failNextProjectCreates -= 1;
        throw new Error("fixture-project-create-failed");
      }
      return projectCatalogCore.createProject(input);
    },
    async setWorkspaceRefs(
      id: string,
      workspaceIds: readonly string[],
      defaultWorkspaceId?: string | null,
    ) {
      state.counters.workspaceRefWrites += 1;
      return projectCatalogCore.setWorkspaceRefs(id, workspaceIds, defaultWorkspaceId);
    },
  };

  const worktreeService = {
    async getAvailability() {
      state.counters.availabilityReads += 1;
      return {
        targetId: TARGET_ID,
        available: !state.targetOffline,
        writable: !state.targetOffline,
      };
    },
    async read() {
      state.counters.worktreeReads += 1;
      return structuredClone(state.worktrees);
    },
    async discover(inputPath: string) {
      state.counters.discoveryCalls += 1;
      const path = inputPath.includes("bare")
        ? "/fixture/repo/linked/bare-discovered"
        : inputPath === "/fixture/repo/linked"
          ? inputPath
          : "/fixture/repo/linked";
      const candidates = [
        makeCandidate("/fixture/repo", { main: true, branch: "main" }),
        makeCandidate(path, { branch: inputPath.includes("bare") ? "feature/bare" : "feature/ui" }),
        ...[...state.createIntents.values()]
          .filter((intent) => !intent.registered)
          .map((intent) => structuredClone(intent.candidate)),
      ];
      const uniqueCandidates = candidates.filter(
        (candidate, index) =>
          candidates.findIndex((item) => item.worktreePath === candidate.worktreePath) === index,
      );
      return {
        kind: inputPath.includes("bare") ? ("bare" as const) : ("git" as const),
        targetId: TARGET_ID,
        inputPath,
        repositoryCommonDir: REPOSITORY_COMMON_DIR,
        commonDirEvidence: evidence(REPOSITORY_COMMON_DIR),
        candidates: uniqueCandidates,
      };
    },
    async adopt(projectId: string, candidate: WorktreeCandidate, title?: string) {
      state.counters.adoptionCalls += 1;
      let binding = state.worktrees.bindings.find(
        (item) =>
          item.executionTargetId === candidate.targetId &&
          item.gitCommonDir === candidate.repositoryCommonDir,
      );
      if (binding && binding.projectId !== projectId) {
        throw new Error("fixture-binding-owned-by-another-project");
      }
      if (!binding) {
        binding = makeBinding(projectId, `binding-${projectId}`, candidate.repositoryCommonDir);
        state.worktrees.bindings.push(binding);
      }
      let workspace = state.worktrees.workspaces.find(
        (item) => item.projectId === projectId && item.worktreePath === candidate.worktreePath,
      );
      if (!workspace) {
        workspace = makeWorkspace({
          id: `workspace-${candidate.worktreePath.split("/").filter(Boolean).join("-")}`,
          projectId,
          bindingId: binding.id,
          title: title ?? (candidate.isMainWorktree ? "Main checkout" : "Feature UI"),
          path: candidate.worktreePath,
          main: candidate.isMainWorktree,
          branch: candidate.head.kind === "branch" ? candidate.head.ref : undefined,
          detached: candidate.head.kind === "detached" ? candidate.head.oid : undefined,
        });
        state.worktrees.workspaces.push(workspace);
      }
      return { binding: structuredClone(binding), workspace: structuredClone(workspace) };
    },
    async createWorkspace(request: CreateWorkspaceRequest): Promise<WorktreeCreateResult> {
      state.counters.createWorkspaceCalls.push(structuredClone(request));
      let intent = state.createIntents.get(request.requestId);
      if (intent) {
        if (JSON.stringify(intent.request) !== JSON.stringify(request)) {
          throw new Error("request-id-reused-with-different-request");
        }
        if (!intent.registered) {
          throw new Error("workspace-path-already-registered-requires-adopt");
        }
        return {
          status: "already-present",
          binding: structuredClone(intent.binding),
          workspace: structuredClone(intent.workspace),
          requestId: request.requestId,
        };
      }
      if (
        state.worktrees.workspaces.some(
          (workspace) => workspace.worktreePath === request.worktreePath,
        )
      ) {
        throw new Error("worktree-path-occupied");
      }
      if (
        [...state.createIntents.values()].some(
          (existing) =>
            existing.request.worktreePath === request.worktreePath && !existing.registered,
        )
      ) {
        throw new Error("workspace-path-already-registered-requires-adopt");
      }
      if (!intent) {
        const path = request.worktreePath;
        const binding = state.worktrees.bindings.find(
          (item) => item.id === request.repositoryBindingId,
        );
        if (!binding) throw new Error("fixture-repository-binding-not-found");
        const candidate = makeCandidate(path, {
          branch: request.mode === "new-branch" ? request.newBranch : request.existingBranch,
          repositoryCommonDir: binding.gitCommonDir,
        });
        const workspace = makeWorkspace({
          id: `workspace-created-${request.requestId}`,
          projectId: request.projectId,
          bindingId: binding.id,
          title: request.title,
          path,
          branch: candidate.head.kind === "branch" ? candidate.head.ref : "fixture-branch",
        });
        intent = {
          request: structuredClone(request),
          candidate,
          workspace,
          binding,
          registered: false,
        };
        state.createIntents.set(request.requestId, intent);
        if (state.failNextCreateCandidateMissing) {
          state.failNextCreateCandidateMissing = false;
          return {
            status: "unregistered",
            requestId: request.requestId,
            candidate: null,
            error: "created-worktree-discovery-failed",
          };
        }
        if (state.failFirstCreateRegistration) {
          state.failFirstCreateRegistration = false;
          return {
            status: "unregistered",
            requestId: request.requestId,
            candidate: structuredClone(candidate),
            error: "fixture-worktree-registration-failed",
          };
        }
      }
      if (!intent.registered) {
        state.worktrees.workspaces.push(structuredClone(intent.workspace));
        state.worktrees.creationReceipts.push({
          schemaVersion: 1,
          request: structuredClone(request),
          workspaceId: intent.workspace.id,
        });
        intent.registered = true;
      }
      return {
        status: "created",
        binding: structuredClone(intent.binding),
        workspace: structuredClone(intent.workspace),
        requestId: request.requestId,
      };
    },
    async updateWorkspace() {
      throw new Error("fixture-update-workspace-not-implemented");
    },
    async revalidate() {
      throw new Error("fixture-revalidate-not-implemented");
    },
  };

  const sessionHierarchyService = {
    async read() {
      state.counters.hierarchyReads += 1;
      if (state.currentScope !== "/fixture/repo") return emptyMigration();
      return structuredClone(state.migration);
    },
    async preview() {
      return structuredClone(state.migration);
    },
    async apply() {
      throw new Error("fixture-migration-apply-not-implemented");
    },
    async rollback() {
      throw new Error("fixture-migration-rollback-not-implemented");
    },
  };

  const agentHostService = {
    ...createProjectSidebarAgentHostBrowserClient(),
    onEvent(listener: (event: { spec: AgentHostSessionSummary["spec"]; event: unknown }) => void) {
      state.eventListeners.add(listener);
      return { dispose: () => state.eventListeners.delete(listener) };
    },
    async getDirectory() {
      state.counters.directoryReads += 1;
      if (state.unavailableDirectory) throw new Error("fixture-host-directory-unsupported");
      return makeDirectory();
    },
    async listSessionSummaries(workspaceIdentity: string, worktreePath: string) {
      const key = `${workspaceIdentity}\0${worktreePath}`;
      state.counters.summaryReadsByWorkspace[key] =
        (state.counters.summaryReadsByWorkspace[key] ?? 0) + 1;
      return state.summaries
        .filter(
          (summary) =>
            summary.spec.execution.workspaceIdentity === workspaceIdentity &&
            summary.spec.execution.worktreePath === worktreePath,
        )
        .map((summary) => ({
          ...structuredClone(summary),
          ...(hostGeneration === "v2" && summary.spec.hostSessionId === "pi-review"
            ? { title: "Host generation two title" }
            : {}),
        }));
    },
  };

  const zcodeTaskService = {
    async listTasks(params: { workspacePath: string; workspaceIdentity?: string }) {
      state.counters.taskListReads += 1;
      return structuredClone(state.tasks).filter(
        (task) =>
          task.workspacePath === params.workspacePath &&
          (!params.workspaceIdentity || task.workspaceIdentity === params.workspaceIdentity),
      );
    },
  };

  return createProjectSidebarBrowserServiceAccessor(state, {
    projectCatalogService,
    worktreeService,
    sessionHierarchyService,
    agentHostService,
    zcodeTaskService,
  });
}
