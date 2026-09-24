import * as React from "react";
import { createRoot } from "react-dom/client";
import type { SidebarSnapshot } from "@zcode/shared/project-workspaces";
import type { HarnessCatalogEntry } from "@zcode/shared/agent-host";
import { ProjectSidebar } from "../src/project-sidebar/ProjectSidebar.js";
import "@zcode/ui/styles.css";

const projects = ["one", "two"].map((id, sortOrder) => ({
  schemaVersion: 1 as const,
  id,
  name: `Project ${id}`,
  sortOrder,
  defaultWorkspaceId: id === "one" ? "main" : undefined,
}));
const bindings = projects.map((p) => ({
  schemaVersion: 1 as const,
  id: `binding-${p.id}`,
  projectId: p.id,
  executionTargetId: p.id === "one" ? "local" : "server1",
  gitCommonDir: `/repos/${p.id}/.git`,
}));
const workspaces = [
  {
    id: "main",
    projectId: "one",
    isMainWorktree: true,
    head: { kind: "branch" as const, ref: "develop", oid: null },
    hidden: false,
  },
  {
    id: "linked",
    projectId: "one",
    isMainWorktree: false,
    head: { kind: "branch" as const, ref: "feature/test", oid: null },
    hidden: false,
  },
  {
    id: "secret",
    projectId: "one",
    isMainWorktree: false,
    head: { kind: "detached" as const, oid: "1234567890" },
    hidden: true,
  },
  {
    id: "remote",
    projectId: "two",
    isMainWorktree: true,
    head: { kind: "branch" as const, ref: "main", oid: null },
    hidden: false,
  },
  ...Array.from({ length: 50 }, (_, n) => ({
    id: `bulk-${n}`,
    projectId: "two",
    isMainWorktree: false,
    head: { kind: "branch" as const, ref: `feature/${n}`, oid: null },
    hidden: false,
  })),
].map((w, sortOrder) => ({
  schemaVersion: 1 as const,
  ...w,
  repositoryBindingId: `binding-${w.projectId}`,
  title: w.id,
  sortOrder,
  workspaceIdentity: w.id,
  worktreePath: `/repos/${w.id}`,
  worktreeGeneration: "generation",
  origin: "adopted" as const,
  lifecycle: "active" as const,
}));
const sessions = [
  {
    id: "s1",
    workspaceId: "linked",
    harnessId: "pi",
    activity: "idle" as const,
    model: "Provider A/model1",
  },
  {
    id: "s2",
    workspaceId: "linked",
    harnessId: "pi",
    activity: "running" as const,
    model: "Provider B/model2",
  },
  {
    id: "s3",
    workspaceId: "secret",
    harnessId: "unknown",
    activity: "waiting" as const,
    model: "none",
  },
].map((s, sortOrder) => ({
  session: {
    schemaVersion: 1 as const,
    id: s.id,
    projectId: "one",
    workspaceId: s.workspaceId,
    harnessId: s.harnessId,
    title: `Session ${s.id}`,
    sortOrder,
    archived: false,
  },
  updatedAt: 1000,
  activity: s.activity,
  freshness: "live" as const,
  unread: false,
  model: s.model,
}));
const catalog: HarnessCatalogEntry[] = [
  {
    manifest: {
      schemaVersion: 1,
      id: "pi",
      name: "Pi",
      adapterVersion: "1",
      icon: { light: "trusted:missing" },
    },
    availability: "supported",
  },
  {
    manifest: { schemaVersion: 1, id: "other", name: "Other", adapterVersion: "1" },
    availability: "unsupported",
    reason: "Not installed",
  },
];
function makeSnapshot(tick: number): SidebarSnapshot {
  return {
    schemaVersion: 1,
    projects,
    bindings,
    workspaces,
    sessions,
    workspaceSummaries: workspaces.map((w) => ({
      workspaceId: w.id,
      freshness: tick % 2 ? "stale" : "live",
      totalAgents: sessions.filter((s) => s.session.workspaceId === w.id).length,
      waiting: w.id === "secret" ? 1 : 0,
      running: w.id === "linked" ? 1 : 0,
      errors: 0,
      unreadCompleted: 0,
    })),
    projectSummaries: projects.map((p) => ({
      projectId: p.id,
      totalAgents: p.id === "one" ? 3 : 0,
      waiting: p.id === "one" ? 1 : 0,
      running: p.id === "one" ? 1 : 0,
      errors: 0,
      unreadCompleted: 0,
      attentionSessionIds: p.id === "one" ? ["s3"] : [],
    })),
  };
}
function Fixture() {
  const [tick, setTick] = React.useState(0);
  const [events, setEvents] = React.useState<string[]>([]);
  const record = (value: string) => setEvents((previous) => [...previous, value]);
  return (
    <main className="bg-background text-foreground min-h-screen p-2 text-ui-base">
      <ProjectSidebar
        snapshot={makeSnapshot(tick)}
        catalog={catalog}
        locale="en"
        modelOptions={[
          { harnessId: "pi", label: "Native model", binding: { kind: "harness-managed" } },
        ]}
        targetLabels={{ local: "Local Mac", server1: "server1" }}
        modelLabels={{
          s1: "Provider A/model1",
          s2: tick % 2 ? "Provider C/model3" : "Provider B/model2",
        }}
        resolveIconAsset={() => "https://invalid.example.test/logo.svg"}
        discovery={{
          "binding-one": [
            { path: "/repos/candidate", label: "candidate", head: "branch candidate" },
          ],
        }}
        actions={{
          onSelectSession: (id) => record(`select:${id}`),
          onOpenAttention: (id) => record(`attention:${id}`),
          onCreateAgent: async (value) => record(`agent:${value.workspaceId}:${value.harnessId}`),
          onDiscover: async (id) => record(`discover:${id}`),
          onAdopt: async (bindingId, path) => record(`adopt:${bindingId}:${path}`),
          onCreateWorkspace: async (value) => record(`create:${value.repositoryBindingId}`),
          onHideWorkspace: async (id) => record(`hide:${id}`),
          onArchiveWorkspace: async (id) => record(`archive:${id}`),
          onRemoveWorkspace: async (id) => record(`remove:${id}`),
        }}
      />
      <button type="button" data-testid="background-update" onClick={() => setTick((n) => n + 1)}>
        Background update
      </button>
      <output data-testid="events">{events.join("|")}</output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
