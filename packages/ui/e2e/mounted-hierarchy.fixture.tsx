import * as React from "react";
import { createRoot } from "react-dom/client";
import type { SidebarSnapshot } from "@zcode/shared/project-workspaces";
import type {
  MountedHierarchyServices,
  MountedSessionOwner,
} from "../src/hooks/useMountedProjectSidebar.js";
import { MountedProjectSidebar } from "../src/project-sidebar/MountedProjectSidebar.js";
import "@zcode/ui/styles.css";

let projects = ["empty", "active"].map((id, sortOrder) => ({
  schemaVersion: 1 as const,
  id,
  name: `Project ${id}`,
  sortOrder,
}));
let bindings = projects.map((p) => ({
  schemaVersion: 1 as const,
  id: `binding-${p.id}`,
  projectId: p.id,
  executionTargetId: p.id,
  gitCommonDir: "/same/.git",
}));
const workspaces = projects.map((p) => ({
  schemaVersion: 1 as const,
  id: `ws-${p.id}`,
  projectId: p.id,
  repositoryBindingId: `binding-${p.id}`,
  title: `Workspace ${p.id}`,
  sortOrder: p.sortOrder,
  hidden: false,
  workspaceIdentity: `target:${p.id}`,
  worktreePath: "/same",
  worktreeGeneration: `gen-${p.id}`,
  isMainWorktree: p.id === "empty",
  head: { kind: "branch" as const, ref: "main", oid: null },
  origin: "adopted" as const,
  lifecycle: "active" as const,
}));
let sessions: SidebarSnapshot["sessions"] = [
  {
    session: {
      schemaVersion: 1,
      id: "tree-alias",
      projectId: "active",
      workspaceId: "ws-active",
      title: "Native original ID",
      harnessId: "zcode",
      sortOrder: 0,
      archived: false,
    },
    activity: "waiting",
    freshness: "live",
    unread: false,
    updatedAt: Date.now(),
  },
];
let offline = false;
let rejectCreate = true;
let rejectRemove = true;
let optionsOffline = false;
let wrongOptionsGeneration = false;
let revision = 1;
let pendingOldRefresh: ((error: Error) => void) | undefined;
let holdNextRefresh = false;
function snapshot(): SidebarSnapshot {
  return {
    schemaVersion: 1,
    revision,
    projects,
    bindings,
    workspaces,
    sessions,
    workspaceSummaries: workspaces.map((w) => ({
      workspaceId: w.id,
      freshness: "live",
      totalAgents: sessions.filter((s) => s.session.workspaceId === w.id).length,
      waiting: sessions.filter((s) => s.session.workspaceId === w.id && s.activity === "waiting")
        .length,
      running: 0,
      errors: 0,
      unreadCompleted: 0,
    })),
    projectSummaries: projects.map((p) => ({
      projectId: p.id,
      totalAgents: sessions.filter((s) => s.session.projectId === p.id).length,
      waiting: sessions.filter((s) => s.session.projectId === p.id && s.activity === "waiting")
        .length,
      running: 0,
      errors: 0,
      unreadCompleted: 0,
      attentionSessionIds: sessions
        .filter((s) => s.session.projectId === p.id && s.activity === "waiting")
        .map((s) => s.session.id),
    })),
  };
}
const events: string[] = [];
let refresh: () => void = () => {};
const services: MountedHierarchyServices = {
  projectCatalogService: {
    sidebarSnapshot: async () => {
      if (holdNextRefresh) {
        holdNextRefresh = false;
        return new Promise<SidebarSnapshot>((_resolve, reject) => {
          pendingOldRefresh = reject;
        });
      }
      if (offline) throw new Error("offline");
      return snapshot();
    },
    importProject: async (input) => {
      if (input.targetId !== "active") throw new Error("Unknown target");
      events.push(`import:${input.targetId}:${input.repositoryPath}`);
      projects = [
        ...projects,
        { schemaVersion: 1, id: input.id, name: input.name, sortOrder: projects.length },
      ];
      bindings = [
        ...bindings,
        {
          schemaVersion: 1,
          id: input.bindingId,
          projectId: input.id,
          executionTargetId: input.targetId,
          gitCommonDir: `${input.repositoryPath}/.git`,
        },
      ];
      refresh();
      return projects.at(-1)!;
    },
    discover: async () => [],
    adopt: async () => {
      throw new Error("No target worktree");
    },
    create: async () => {
      throw new Error("No target worktree");
    },
    remove: async (input) => {
      events.push(`remove:${input.workspaceId}:${input.expectedGeneration}`);
      refresh();
      if (rejectRemove) throw new Error("Target removal rejected: dirty worktree");
      return workspaces.find((w) => w.id === input.workspaceId)!;
    },
    updateWorkspace: async (id, update) => {
      events.push(`workspace:${id}:${JSON.stringify(update)}`);
      refresh();
      return { ...workspaces.find((w) => w.id === id)!, ...update };
    },
  },
  workspaceHierarchyService: {
    resolveOwner: async ({ targetId, workspaceId, sessionId }) => {
      events.push(`resolve:${targetId}:${workspaceId}:${sessionId}`);
      refresh();
      if (sessionId !== "tree-alias" || targetId !== "active") return undefined;
      return {
        kind: "native",
        originalSessionId: "original-native-id",
        historyOnly: false,
        scope: {
          targetId,
          workspaceId,
          workspacePath: "/same",
          workspaceIdentity: "target:active",
        },
      };
    },
    listHarnesses: async (workspaceId) => [
      {
        manifest: { schemaVersion: 1, id: "pi", name: "Pi", adapterVersion: "1" },
        availability: "supported",
      },
      {
        manifest: { schemaVersion: 1, id: "codex", name: "Codex", adapterVersion: "1" },
        availability: workspaceId === "ws-empty" ? "supported" : "unsupported",
        reason: workspaceId === "ws-empty" ? undefined : "Approval capability unverified",
      },
    ],
    listCreateOptions: async (workspaceId) => {
      if (workspaceId === "ws-active" && optionsOffline) {
        events.push("options:ws-active:offline");
        throw new Error("Model catalog offline");
      }
      return {
        workspaceId,
        worktreeGeneration:
          wrongOptionsGeneration && workspaceId === "ws-active"
            ? "stale-generation"
            : `gen-${workspaceId.slice(3)}`,
        options:
          workspaceId === "ws-active"
            ? [
                {
                  harnessId: "pi",
                  label: "Provider A / Model B / high",
                  binding: {
                    kind: "host-managed",
                    selection: {
                      providerId: "provider-a",
                      modelId: "model-b",
                      options: { reasoningLevel: "high" },
                    },
                  },
                },
              ]
            : [
                {
                  harnessId: "pi",
                  label: "Other target only",
                  binding: {
                    kind: "host-managed",
                    selection: { providerId: "provider-c", modelId: "model-d" },
                  },
                },
                {
                  harnessId: "codex",
                  label: "Codex target choice",
                  binding: {
                    kind: "host-managed",
                    selection: { providerId: "provider-c", modelId: "model-d" },
                  },
                },
              ],
      };
    },
    previewRemoval: async ({ workspaceId, expectedGeneration }) => {
      events.push(`preview:${workspaceId}:${expectedGeneration}`);
      return {
        workspaceId,
        generation: expectedGeneration,
        git: {
          worktree: {
            path: "/same",
            kind: "linked",
            head: null,
            branch: null,
            detached: false,
            locked: null,
            prunable: null,
          },
          isMain: false,
          dirty: false,
          untracked: false,
          submodules: false,
          locked: false,
          gitLocks: false,
          prunable: false,
        },
        activity: { running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false },
        unknown: false,
        safe: true,
      };
    },
    createAgent: async (input) => {
      events.push(
        `create:${input.workspaceId}:${input.commandId}:${JSON.stringify(input.modelBinding)}`,
      );
      refresh();
      if (rejectCreate) throw new Error("Host rejected creation");
      const owner: MountedSessionOwner = {
        kind: "external",
        scope: {
          targetId: "active",
          workspaceId: input.workspaceId,
          workspacePath: "/same",
          workspaceIdentity: "target:active",
        },
        historyOnly: false,
        spec: {
          schemaVersion: 2,
          hostSessionId: "new-external",
          projectId: "active",
          workspaceId: input.workspaceId,
          execution: {
            targetId: "active",
            workspaceIdentity: "target:active",
            worktreePath: "/same",
            worktreeGeneration: "gen-active",
            cwdRelativeToWorktree: ".",
          },
          harness: { id: input.harnessId, adapterVersion: "1" },
          modelBinding: input.modelBinding,
        },
      };
      return { owner };
    },
    asset: async () => undefined,
  },
};
function Fixture() {
  const [tick, setTick] = React.useState(0);
  refresh = () => setTick((n) => n + 1);
  return (
    <main className="min-h-screen bg-background text-foreground text-ui-base">
      <MountedProjectSidebar
        key="mounted"
        locale="en"
        services={services}
        onNavigate={(owner) => {
          events.push(
            `open:${owner.kind === "native" ? owner.originalSessionId : owner.spec.hostSessionId}:${owner.scope.workspaceIdentity}`,
          );
          refresh();
        }}
      />
      <button
        type="button"
        onClick={() => {
          offline = !offline;
          window.dispatchEvent(new Event("focus"));
          refresh();
        }}
      >
        Toggle offline
      </button>
      <button
        type="button"
        onClick={() => {
          holdNextRefresh = true;
          window.dispatchEvent(new Event("focus"));
        }}
      >
        Hold old refresh
      </button>
      <button type="button" onClick={() => window.dispatchEvent(new Event("focus"))}>
        Refresh now
      </button>
      <button
        type="button"
        onClick={() => {
          pendingOldRefresh?.(new Error("old offline"));
          pendingOldRefresh = undefined;
        }}
      >
        Reject old refresh
      </button>
      <output data-testid="mounted-events">{events.join("|")}</output>
      <button
        type="button"
        onClick={() => {
          rejectCreate = false;
          refresh();
        }}
      >
        Allow create
      </button>
      <button
        type="button"
        onClick={() => {
          rejectRemove = false;
          refresh();
        }}
      >
        Allow removal
      </button>
      <button
        type="button"
        onClick={() => {
          optionsOffline = true;
          window.dispatchEvent(new Event("focus"));
        }}
      >
        Disable active options
      </button>
      <button
        type="button"
        onClick={() => {
          wrongOptionsGeneration = !wrongOptionsGeneration;
          window.dispatchEvent(new Event("focus"));
        }}
      >
        Toggle stale options generation
      </button>
      <button
        type="button"
        onClick={() => {
          optionsOffline = false;
          window.dispatchEvent(new Event("focus"));
        }}
      >
        Restore active options
      </button>
      <span data-testid="tick">{tick}</span>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
