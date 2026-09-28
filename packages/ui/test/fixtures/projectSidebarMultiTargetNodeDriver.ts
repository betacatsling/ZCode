/* oxlint-disable eslint(max-lines) -- This isolated driver owns real temporary Git, Worktree, and file Catalog services for browser acceptance. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentHostSessionSummary, SessionHierarchyFile } from "@zcode/shared/agent-host";
import { buildRemoteWorkspaceIdentity } from "@zcode/shared";
import { createFileProjectCatalogRepository } from "../../../services/src/project-catalog/adapters/fileProjectCatalogRepository.js";
import { createProjectCatalogService } from "../../../services/src/project-catalog/app/projectCatalogService.js";
import { createFileWorktreeService } from "../../../services/src/worktree/index.js";
import type { IWorktreeService } from "../../../services/src/worktree/contract.js";
import type {
  CreateWorkspaceRequest,
  WorktreeCandidate,
} from "../../../services/src/worktree/contract.js";
import {
  createSessionRecord,
  makeDirectory,
  makeMigration,
  makeSummary,
} from "./projectSidebarBrowserFixtureData.js";

const port = Number(process.env.PROJECT_SIDEBAR_DRIVER_PORT ?? 43172);
const serviceDataRoot = process.env.PROJECT_SIDEBAR_REAL_DATA_DIR ?? tmpdir();
await mkdir(serviceDataRoot, { recursive: true });
const root = await mkdtemp(join(serviceDataRoot, "real-services-"));
const repoPath = join(root, "shared repo with spaces");
const barePath = join(root, "bare repo with commit.git");
const emptyBarePath = join(root, "empty bare repo.git");
const projectCatalogPath = join(root, "profile-project-catalog.json");
const execFileAsync = promisify(execFile);
const counters = {
  catalogReads: 0,
  catalogIngests: 0,
  worktreeReadsByTarget: {} as Record<string, number>,
  createRequestsByTarget: {} as Record<string, CreateWorkspaceRequest[]>,
  adoptionPathsByTarget: {} as Record<string, string[]>,
  gitVersion: "",
};
const offlineTargets = new Set<string>();
const unsupportedTargets = new Set<string>();
let failNextCatalogWrite = false;
interface HeldRead {
  holdId: string;
  targetId: string;
  started: boolean;
  released: boolean;
  waiters: Array<() => void>;
  releaseWaiters: Array<() => void>;
}
const queuedHolds = new Map<string, HeldRead[]>();
const activeHolds = new Map<string, HeldRead>();
let nextHoldId = 0;
const migrations = new Map<string, SessionHierarchyFile>();
const summaries = new Map<string, AgentHostSessionSummary[]>();
const targetIds = ["target-alpha", "target-beta", "target-gamma", "target-delta"] as const;

async function git(cwd: string | undefined, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", cwd ? ["-C", cwd, ...args] : args, {
    encoding: "utf8",
  });
  return result.stdout;
}

await mkdir(repoPath, { recursive: true });
await git(undefined, "init", "-q", "-b", "main", repoPath);
await git(repoPath, "config", "user.email", "project-sidebar@test.invalid");
await git(repoPath, "config", "user.name", "Project Sidebar Fixture");
await writeFile(join(repoPath, "README.md"), "temp Git repository for sidebar acceptance\n");
await git(repoPath, "add", "README.md");
await git(repoPath, "commit", "-q", "-m", "initial commit");
await git(undefined, "clone", "-q", "--bare", repoPath, barePath);
await git(undefined, "init", "-q", "--bare", emptyBarePath);
counters.gitVersion = (await git(undefined, "--version")).trim();

const fileCatalogRepository = createFileProjectCatalogRepository(projectCatalogPath);
const catalog = createProjectCatalogService({
  persistence: {
    async read() {
      counters.catalogReads += 1;
      return fileCatalogRepository.read();
    },
    async update(mutator) {
      const result = await fileCatalogRepository.update((current) => {
        if (failNextCatalogWrite) {
          failNextCatalogWrite = false;
          throw new Error("fixture-catalog-reference-write-failed");
        }
        return mutator(current);
      });
      counters.catalogIngests += 1;
      return result;
    },
  },
});

function createTargetWorktreeService(targetId: string, fileName: string): IWorktreeService {
  let id = 0;
  return createFileWorktreeService({
    filePath: join(root, fileName),
    targetId: () => targetId,
    idFactory: () => `shared-worktree-id-${++id}`,
  });
}

const worktrees = new Map<string, IWorktreeService>([
  [targetIds[0], createTargetWorktreeService(targetIds[0], "target-alpha-worktrees.json")],
  [targetIds[1], createTargetWorktreeService(targetIds[1], "target-beta-worktrees.json")],
  [targetIds[2], createTargetWorktreeService(targetIds[2], "target-gamma-worktrees.json")],
]);

interface ReadBody extends Record<string, unknown> {
  targetId?: string;
}

async function body(request: IncomingMessage): Promise<ReadBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const source = Buffer.concat(chunks).toString("utf8");
  return source ? (JSON.parse(source) as ReadBody) : {};
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function summaryKey(targetId: string, workspaceIdentity: string, worktreePath: string): string {
  return JSON.stringify([targetId, workspaceIdentity.trim() || worktreePath, worktreePath]);
}

function directoryFor(targetId: string) {
  return { ...makeDirectory(), targetId };
}

async function seedSessions(projectId: string, sessionId: string): Promise<void> {
  for (const targetId of targetIds.slice(0, 2)) {
    const worktreeFile = await worktrees.get(targetId)!.read();
    const workspace = worktreeFile.workspaces.find(
      (item) => item.projectId === projectId && item.worktreePath === repoPath,
    );
    if (!workspace) throw new Error(`missing-workspace:${targetId}`);
    const record = {
      ...createSessionRecord({
        hierarchySessionId: sessionId,
        projectId,
        workspaceId: workspace.id,
        workspacePath: workspace.worktreePath,
        harnessId: "pi",
        ownerKind: "agent-host",
      }),
      targetId,
      workspaceIdentity: buildRemoteWorkspaceIdentity(workspace.worktreePath, {
        kind: "docker",
        container: `sidebar-${targetId}`,
      }),
    };
    const pendingNonGitRecord = {
      hierarchySessionId: `legacy-non-git-${targetId}`,
      nativeSessionId: `legacy-non-git-${targetId}`,
      ownerKind: "native-v4" as const,
      targetId,
      workspacePath: join(root, `old non-git workspace ${targetId}`),
      status: "pending-verification" as const,
      pendingReason: "nonGit" as const,
    };
    migrations.set(targetId, makeMigration([record, pendingNonGitRecord]));
    const summary = makeSummary({
      sessionId,
      workspacePath: workspace.worktreePath,
      title: targetId === targetIds[0] ? "Alpha cached session" : "Beta cached session",
      status: "running",
      updatedAt: Date.now(),
    });
    summaries.set(
      summaryKey(
        targetId,
        workspace.workspaceIdentity?.trim() || workspace.worktreePath,
        workspace.worktreePath,
      ),
      [
        {
          ...summary,
          spec: {
            ...summary.spec,
            execution: {
              ...summary.spec.execution,
              targetId,
              workspaceIdentity: record.workspaceIdentity,
              workspaceId: workspace.id,
              worktreeGeneration: workspace.worktreeGeneration,
            },
          },
        },
      ],
    );
  }
}

function buildSummaryList(
  targetId: string,
  workspaceIdentity: string,
  worktreePath: string,
): AgentHostSessionSummary[] {
  return summaries.get(summaryKey(targetId, workspaceIdentity, worktreePath)) ?? [];
}

async function callWorktree(targetId: string, method: string, args: ReadBody): Promise<unknown> {
  const worktree = worktrees.get(targetId);
  if (!worktree) throw new Error(`unknown-target:${targetId}`);
  if (method === "getAvailability") {
    const availability = await worktree.getAvailability();
    return offlineTargets.has(targetId)
      ? { ...availability, available: false, writable: false, reason: "fixture-offline" }
      : availability;
  }
  if (method === "read") {
    counters.worktreeReadsByTarget[targetId] = (counters.worktreeReadsByTarget[targetId] ?? 0) + 1;
    const snapshot = await worktree.read();
    const hold = queuedHolds.get(targetId)?.shift();
    if (hold) {
      activeHolds.set(hold.holdId, hold);
      hold.started = true;
      for (const waiter of hold.waiters.splice(0)) waiter();
      await new Promise<void>((resolve) => hold.releaseWaiters.push(resolve));
    }
    return snapshot;
  }
  if (method === "discover") return worktree.discover(String(args.inputPath ?? ""));
  if (method === "adopt") {
    const candidate = args.candidate as WorktreeCandidate;
    const paths = counters.adoptionPathsByTarget[targetId] ?? [];
    paths.push(candidate.worktreePath);
    counters.adoptionPathsByTarget[targetId] = paths;
    return worktree.adopt(
      String(args.projectId ?? ""),
      candidate,
      typeof args.title === "string" ? args.title : undefined,
    );
  }
  if (method === "adoptBareRepository") {
    return worktree.adoptBareRepository(
      String(args.projectId ?? ""),
      args.request as Parameters<IWorktreeService["adoptBareRepository"]>[1],
    );
  }
  if (method === "createWorkspace") {
    const createRequest = args.request as CreateWorkspaceRequest;
    const requests = counters.createRequestsByTarget[targetId] ?? [];
    requests.push(structuredClone(createRequest));
    counters.createRequestsByTarget[targetId] = requests;
    return worktree.createWorkspace(createRequest);
  }
  if (method === "updateWorkspace") {
    return worktree.updateWorkspace(
      args.request as Parameters<IWorktreeService["updateWorkspace"]>[0],
    );
  }
  if (method === "revalidate") {
    return worktree.revalidate(
      String(args.workspaceId ?? ""),
      args.options as Parameters<IWorktreeService["revalidate"]>[1],
    );
  }
  throw new Error(`unsupported-worktree-method:${method}`);
}

async function callCatalog(method: string, args: ReadBody): Promise<unknown> {
  if (method === "read" || method === "readWorkspaceCatalog") {
    return method === "read"
      ? catalog.read()
      : catalog.readWorkspaceCatalog(
          args.targetConnections as Parameters<typeof catalog.readWorkspaceCatalog>[0],
        );
  }
  if (method === "createProject") {
    return catalog.createProject(args.input as Parameters<typeof catalog.createProject>[0]);
  }
  if (method === "updateProject") {
    return catalog.updateProject(
      String(args.id ?? ""),
      args.patch as Parameters<typeof catalog.updateProject>[1],
    );
  }
  if (method === "setWorkspaceRefs") {
    return catalog.setWorkspaceRefs(
      String(args.id ?? ""),
      args.workspaceIds as readonly string[],
      args.defaultWorkspaceId as string | null | undefined,
    );
  }
  if (method === "setDefaultWorkspaceRef") {
    return catalog.setDefaultWorkspaceRef(
      String(args.id ?? ""),
      args.reference as Parameters<typeof catalog.setDefaultWorkspaceRef>[1],
    );
  }
  if (method === "ingestTargetSnapshot") {
    return catalog.ingestTargetSnapshot(
      args.snapshot as Parameters<typeof catalog.ingestTargetSnapshot>[0],
    );
  }
  if (method === "markTargetFreshness") {
    return catalog.markTargetFreshness(
      String(args.targetId ?? ""),
      args.freshness as Parameters<typeof catalog.markTargetFreshness>[1],
      Number(args.observedAt ?? Date.now()),
    );
  }
  throw new Error(`unsupported-catalog-method:${method}`);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (request.method === "GET" && url.pathname === "/__project-sidebar/health") {
    json(response, 200, {
      ready: true,
      targetIds,
      repoPath,
      barePath,
      emptyBarePath,
      root,
      gitVersion: counters.gitVersion,
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/__project-sidebar/state") {
    json(response, 200, {
      counters,
      offlineTargets: [...offlineTargets],
      failNextCatalogWrite,
      heldReads: [...[...queuedHolds.values()].flat(), ...activeHolds.values()].map(
        ({ holdId, targetId, started, released }) => ({ holdId, targetId, started, released }),
      ),
      catalog: await catalog.read(),
      worktrees: Object.fromEntries(
        await Promise.all(
          [...worktrees.entries()].map(async ([targetId, service]) => [
            targetId,
            await service.read(),
          ]),
        ),
      ),
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__project-sidebar/control/offline") {
    const payload = await body(request);
    const targetId = String(payload.targetId ?? "");
    if (payload.offline) offlineTargets.add(targetId);
    else offlineTargets.delete(targetId);
    json(response, 200, { targetId, offline: offlineTargets.has(targetId) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__project-sidebar/control/unsupported-host") {
    const payload = await body(request);
    const targetId = String(payload.targetId ?? "");
    if (payload.unsupported) unsupportedTargets.add(targetId);
    else unsupportedTargets.delete(targetId);
    json(response, 200, { targetId, unsupported: unsupportedTargets.has(targetId) });
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/__project-sidebar/control/fail-next-catalog-write"
  ) {
    failNextCatalogWrite = true;
    json(response, 200, { accepted: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__project-sidebar/control/seed-sessions") {
    const payload = await body(request);
    await seedSessions(
      String(payload.projectId ?? ""),
      String(payload.sessionId ?? "same-session"),
    );
    json(response, 200, { seeded: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__project-sidebar/control/hold-next-read") {
    const payload = await body(request);
    const targetId = String(payload.targetId ?? "");
    const hold: HeldRead = {
      holdId: `hold-${++nextHoldId}`,
      targetId,
      started: false,
      released: false,
      waiters: [],
      releaseWaiters: [],
    };
    queuedHolds.set(targetId, [...(queuedHolds.get(targetId) ?? []), hold]);
    json(response, 200, { accepted: true, holdId: hold.holdId });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__project-sidebar/control/release-read") {
    const payload = await body(request);
    const hold = activeHolds.get(String(payload.holdId ?? ""));
    if (hold) {
      hold.released = true;
      for (const release of hold.releaseWaiters.splice(0)) release();
    }
    json(response, 200, { released: Boolean(hold) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__project-sidebar/control/rename") {
    const payload = await body(request);
    const service = worktrees.get(String(payload.targetId ?? ""));
    if (!service) throw new Error("unknown-target");
    const result = await service.updateWorkspace({
      operation: "rename",
      workspaceId: String(payload.workspaceId ?? ""),
      title: String(payload.title ?? ""),
    });
    json(response, 200, result);
    return;
  }
  if (request.method === "POST" && url.pathname.startsWith("/__project-sidebar/rpc/catalog/")) {
    const method = url.pathname.slice("/__project-sidebar/rpc/catalog/".length);
    try {
      json(response, 200, await callCatalog(method, await body(request)));
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (request.method === "POST" && url.pathname.startsWith("/__project-sidebar/rpc/worktree/")) {
    const method = url.pathname.slice("/__project-sidebar/rpc/worktree/".length);
    try {
      const payload = await body(request);
      json(response, 200, await callWorktree(String(payload.targetId ?? ""), method, payload));
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/__project-sidebar/rpc/hierarchy/")) {
    const targetId = url.pathname.slice("/__project-sidebar/rpc/hierarchy/".length);
    json(response, 200, migrations.get(targetId) ?? makeMigration());
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/__project-sidebar/rpc/directory/")) {
    const targetId = url.pathname.slice("/__project-sidebar/rpc/directory/".length);
    if (unsupportedTargets.has(targetId)) {
      json(response, 501, { error: "unsupported-old-host-directory" });
      return;
    }
    json(response, 200, directoryFor(targetId));
    return;
  }
  if (request.method === "POST" && url.pathname === "/__project-sidebar/rpc/summaries") {
    const payload = await body(request);
    json(
      response,
      200,
      buildSummaryList(
        String(payload.targetId ?? ""),
        String(payload.workspaceIdentity ?? ""),
        String(payload.worktreePath ?? ""),
      ),
    );
    return;
  }
  json(response, 404, { error: "not-found" });
});

server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => {
  server.close();
  void (async () => {
    await Promise.allSettled([...worktrees.values()].map((service) => service.read()));
  })();
});
