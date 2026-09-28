# Project Catalog target references and offline presentation

The profile-local Project Catalog owns Project metadata and navigation
preferences. It also keeps a display-only cache of target-scoped workspace
references so the project tree survives target disconnection and profile-owner
restart. The target `IWorktreeService` remains authoritative for repository
bindings, paths, identities, generations, lifecycle, and verification.

## Owners and event order

```text
existing target connection/service collection
  └─ target IWorktreeService.getAvailability() + read()
       └─ caller validates target scope and builds a strict snapshot
            └─ profile IProjectCatalogService.ingestTargetSnapshot()
                 └─ locked read → validate → update only target refs → atomic replace

profile IProjectCatalogService.readWorkspaceCatalog(target connection states)
  └─ persisted display cache + current connection state → aggregate read model
```

The Catalog owns Project name/icon/default/pin/order, target-scoped navigation
references, and the last verified presentation. It does not own execution
paths, worktree generations, repository binding facts, session queues, runtime
activity, or attachment routing. A cached row is display evidence only. After
reconnect, the target service must re-check availability, workspace identity,
filesystem evidence, and generation before any execution or attachment path
uses a workspace.

Window-only expanded/selected state remains in the window store. The Catalog
does not introduce a target registry: callers obtain local, connected, and
offline target states from the existing connection/service collection and
pass those states into the aggregate read.

## Persistence and migration

`project-catalog.json` is written as strict `schemaVersion: 2`:

```ts
interface ProjectCatalogFile {
  schemaVersion: 2;
  projects: ProjectCatalogProject[];
  targets: ProjectCatalogTargetFreshness[]; // includes freshnessUpdatedAt
}

interface ProjectCatalogProject extends Project {
  // Compatibility references without a proven target. They need verification.
  workspaceIds: string[];
  repositoryReferences: ProjectRepositoryReference[];
  workspaceReferences: ProjectWorkspaceReference[];
  pinned: boolean;
  sortOrder: number;
}
```

References are unique by `(targetId, workspaceId)`. Each scoped reference also
records its Project and `repositoryBindingId`; snapshot validation proves that
the target's workspace points to that binding and that both belong to the same
Project. Identical paths or Git origins on different targets never merge.
Paths, generations, common-directory paths, remote session IDs, credentials,
and origin URLs are not persisted in the Catalog.

The cached presentation contains only a worktree title, head summary, main
worktree flag, lifecycle, and optionally verified sidebar session rows/counts.
It is derived from strict target Worktree records and Host summaries. Each
workspace records its last verification time and freshness. Target connection
state may overlay the aggregate read as `live`, `stale`, `offline`, or
`unknown`, without mutating or clearing the last presentation. Offline or
failed refreshes preserve session activity as last observed; they never turn a
running row into idle. A successful refresh without a complete session summary
updates target-owned display facts while retaining the prior summary and its
own verification time.

Each `sessionSummaries` entry means that workspace's Host summary read completed
and may replace its rows, including with an explicit empty result. An omitted
entry means the summary source did not complete and therefore retains the last
known rows; the input field itself is required by the strict snapshot schema.
A Worktree-only refresh marks a retained summary `stale` while preserving its
verification time, activity, approvals, outcome, and counts. Target freshness
and Host-summary freshness are independent; reconnecting or refreshing
Worktree metadata alone cannot mark an old running summary live.

Valid schemaVersion 1 files migrate in memory to v2. Each old `workspaceId`
becomes an unscoped `needsVerification` reference with no target, binding,
timestamp, or presentation; the old default remains unscoped. No host is
guessed. A read does not rewrite bytes; the next successful mutation writes
v2. Unknown future versions and invalid files fail closed and remain byte for
byte unchanged. Updates hold the existing file lock across read, migration,
validation, mutation, and atomic replacement, so concurrent updates for two
targets cannot lose one another's references.

`readWorkspaceCatalog` returns a separate strict `ProjectCatalogReadModel`
schemaVersion 1. It combines all stored Project/reference/presentation data
with current target connection state while exposing no execution path or
generation. The versioned persistence envelope remains schemaVersion 2.

## API and failure semantics

- `read()` returns the strict persisted catalog, migrating v1 in memory.
- `ingestTargetSnapshot(snapshot)` accepts a strict snapshot built from one
  target's `IWorktreeService.getAvailability()` and `read()`. It updates only
  that target's references and freshness. It never deletes another target's
  references or changes any Project default. Repeated identical observations
  are idempotent; older timestamps and conflicting snapshots at the same
  observation time are rejected.
- `markTargetFreshness(targetId, state, observedAt)` records a failed or
  disconnected target while preserving all last verified presentation and
  timestamps. Its observation time is compared with the target's last status
  and successful snapshot, so a late failure cannot overwrite a newer refresh.
- `readWorkspaceCatalog(targetStates)` returns all cached references merged
  with current target connection states. Missing target facts are
  `unknown`/`needsVerification`; a newly connected target with an old cache is
  `stale` until target ingestion succeeds.
- `setWorkspaceRefs` remains a compatibility API for unscoped legacy IDs. It
  cannot add, remove, or replace target-scoped references. A separate
  `setDefaultWorkspaceRef` selects a target-scoped Project default. The legacy
  setter never assigns a target to an ID; when the caller repeats the existing
  explicitly scoped default unchanged, it preserves that already-proven scope.
  The `workspaceIds` compatibility list remains targetless; a current target
  Worktree read must prove `(targetId, workspaceId, repositoryBindingId,
projectId)` before display or action. A new multi-target UI uses
  `readWorkspaceCatalog` and `workspaceReferences` instead.
- `createProject` can create a Project with zero workspace references and no
  default. Project creation and target binding adoption are separate owner
  writes; callers retain the successful half and retry the failed half.

All public requests and results have strict runtime schemas. Aggregate/cache
results are display-only and do not grant target write or execution
capability. Do not persist a `remoteSessionId` as target identity; use the
stable target ID returned by the existing target service. Any workspace
identity association continues to use the existing remote identity builder
and parser and the local fallback
`workspaceIdentity?.trim() || workspacePath`.

`observedAt` orders display snapshots and failed refresh updates only. It never
grants execution. Callers serialize each target's `IWorktreeService` read and
Catalog ingest in order; the target still revalidates identity and generation
at the existing admission boundary.

## Acceptance

Tests cover target A and B referencing the same path without merging, default
preservation, concurrent different-target updates, failed refresh and restart
presentation retention, v1 migration without target guessing, future-version
byte preservation, and the absence of execution path/generation from cached
read results. A cache must not admit an old session after a same-path rebuild;
the target's existing generation and admission checks remain authoritative.
