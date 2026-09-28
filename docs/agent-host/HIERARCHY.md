# Agent Host hierarchy contract (P1 slice)

This document defines the small, versioned hierarchy contract needed before a
Project sidebar or a target worktree service is wired. It is an implementation
specification for the pure schemas in
`packages/shared/src/agent-host/hierarchy.ts`; it does not claim that a catalog,
Git probe, persistence layer, or remote target already exists.

## Ownership and visible hierarchy

The Project Catalog is the single owner of Project metadata: stable project ID,
display name, icon reference, and the optional default workspace reference. The
target Runtime Host owns a `RepositoryBinding` and the target-observed
`WorktreeWorkspace` identity, path, generation, lifecycle, and verification
state. An `AgentSession` only points to its workspace. It does not carry a
project, repository binding, target, path, or generation that could become a
second source of truth.

```text
Project Catalog
  Project (metadata, defaultWorkspaceId)
       │ projectId
       ▼
Target Runtime Host
  RepositoryBinding (target, gitCommonDir)
       │ repositoryBindingId
       ▼
  WorktreeWorkspace (identity, path, generation, lifecycle, verification)
       │ workspaceId
       ▼
  AgentSession (harness, title, optional existing model binding)
```

`defaultWorkspaceId` is a Project navigation preference. When it identifies a
target-scoped reference, `defaultWorkspaceTargetId` supplies the target half of
that reference; an old unscoped default remains unresolved until verified.
The default is independent of `WorktreeWorkspace.isMainWorktree`: a linked
worktree can be the default, and a main checkout can remain visible without
being the default. A Project may have
both a main checkout and linked worktrees under the same binding. Two bindings
may have the same path when their target IDs differ; target identity keeps them
separate. Multiple sessions, including multiple sessions with the same Harness,
may point to one workspace.

The schema IDs are stable record IDs. Display names, branch names, absolute
paths, Git common-directory paths, and temporary connection/session IDs are
locators or presentation data and are not used as permanent identity. This
slice does not globally deduplicate paths.

## Schemas and validation

The following schemas are strict and carry `schemaVersion: 1`:

- `Project`: `id`, `name`, optional `iconAssetId`, and optional
  `defaultWorkspaceId`.
- `RepositoryBinding`: `id`, `projectId`, `executionTargetId`, and
  `gitCommonDir`.
- `WorktreeWorkspace`: `id`, `projectId`, `repositoryBindingId`, title,
  optional existing `workspaceIdentity`, `worktreePath`,
  `worktreeGeneration`, main-worktree flag, Git head summary, origin,
  lifecycle, and independent `verification` (`verified` or
  `needsVerification`). Verification is required; an absent value is not
  evidence that a workspace is safe to admit.
- `AgentSession`: `id`, `workspaceId`, `harnessId`, title, and an optional
  existing `ModelBindingRequest`. Runtime state, backend bindings, and native
  session IDs remain in their existing contracts.

`AgentSession.id` and `ExecutionSnapshot.sessionId` are this slice's hierarchy
identities. They are not `SessionSpec.hostSessionId`, backend IDs, or native
session IDs, and no one-to-one mapping is wired here. A later migration must
retain an explicit existing-session mapping and must not create a replacement
conversation merely to fill this field. New hierarchy sessions can be created
independently while that migration seam remains unconnected.

`parseHierarchySnapshot` validates record IDs, project and binding references,
that each workspace binding belongs to the same project, that every session's
workspace exists, and that a Project's default workspace belongs to that
Project. It rejects duplicate IDs within each record collection. This is
catalog projection validation; it does not establish that a path still exists
or that a Git common directory is real.

## Target-derived execution snapshot

`resolveSessionOwnership` trims a non-blank session ID using the stable ID
schema; blank input is rejected and an unknown normalized ID is rejected.

`deriveExecutionSnapshot` accepts a trusted Project, RepositoryBinding,
WorktreeWorkspace, and AgentSession association. It returns an independent
execution snapshot containing the project, binding, workspace, session and
Harness IDs plus:

```text
execution.targetId             ← RepositoryBinding.executionTargetId
execution.workspaceIdentity   ← trim(existing workspaceIdentity) || worktreePath
execution.worktreePath        ← WorktreeWorkspace.worktreePath
execution.worktreeGeneration  ← WorktreeWorkspace.worktreeGeneration
execution.cwdRelativeToWorktree
```

`execution.workspaceIdentity` is the resolved canonical workspace key in
SessionSpec V1. When the Worktree has no explicit identity, it equals
`worktreePath` byte-for-byte; the V1 parser preserves that value after it is
derived. Existing manifests whose historical parser trimmed a path fallback
remain unchanged and require verification if the stored key no longer matches
the original path.

The function rejects cross-project or cross-binding associations, sessions
whose workspace differs, inactive workspaces, and active workspaces marked
`needsVerification`. Target, workspace identity, and generation are therefore
derived from the trusted records; strict session parsing rejects an attempted
execution override. The returned model binding is parsed into a fresh value so
later mutation of the input object cannot change the snapshot.

The default cwd is standalone `.`; standalone `.` is accepted. An optional cwd
is otherwise checked only as POSIX-relative lexical notation: absolute paths,
drive prefixes, backslashes, NULs, empty segments, and embedded `.` or `..`
segments are rejected. This does not check realpath containment, symlinks,
permissions, or the target's current worktree generation. The target Host must
perform those checks immediately before any future admission. No remote
identity is synthesized here; a supplied identity is reused, and an empty
identity falls back to the documented local path rule.

```text
trusted Project + Binding + Workspace + Session
              │
              ├─ strict parse and ownership checks
              ├─ active + verified admission check
              └─ derive fresh execution snapshot
                    │
                    └─ target Host later revalidates Git/realpath/symlinks
```

## Compatibility and deferred integration

The existing `sessionSpecSchema` and `SessionSpec` remain version 1 and are
unchanged by this slice. The execution snapshot is a separate shared contract;
it is not silently substituted for the current wire/session writer and does
not introduce a v2 session schema without a consumer. Existing Agent Host
runtime, model, backend, and persistence contracts remain the owners of their
current state.

The shared export is additive through `@zcode/shared/agent-host`. Future
Project Catalog and target Host work can consume these records, then add
target-local Git discovery, durable uniqueness checks, realpath/symlink
validation, explicit adoption, and admission wiring. Sidebar rendering,
worktree creation/removal, legacy-session mapping, remote transport, and
multi-host persistence are outside this slice.

## Profile Catalog target references

The profile Project Catalog stores a display-only
`ProjectWorkspaceReference` keyed by `(targetId, workspaceId)`. The record
also carries `projectId` and `repositoryBindingId`, and is accepted only when
an `IWorktreeService` snapshot proves that the workspace belongs to that
binding, target, and Project. Equal paths and Git origins on different targets
do not combine references.

The Catalog may persist a last verified display presentation—title, head,
main-worktree flag, lifecycle, and optional Host-derived session rows and
summary—with verification timestamps and target freshness. It does not persist
the target's `worktreePath`, `worktreeGeneration`, common-directory path, or
remote connection/session ID as execution authority. Its offline presentation
is only a cache; after reconnect, execution still requires a fresh target-side
identity and generation check. A v1 Catalog `workspaceId` with no target is
migrated to `needsVerification` and is never attached to the currently
connected target by inference.
