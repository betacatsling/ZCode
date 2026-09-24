# v0.3 hierarchy contract (P1 freeze)

Project Catalog is the single writer for Project names, references and ordering. Target Runtime Host is the authority for RepositoryBinding, actual worktree identity/generation, cwd containment and new-session admission. Harness owns native context; the UI owns focus only. Project → WorktreeWorkspace → AgentSession is the visible tree; repository binding is internal. Main checkout and default workspace are independent properties. A workspace can have multiple sessions of the same harness; adding a session never creates a worktree or changes branch. A session inherits target and worktree from its workspace, not from the UI request.

```text
Catalog project + target-verified repository/worktree
  → Host validates project/binding/worktree/generation & cwd realpath containment
  → Host admits a fresh hostSessionId and freezes SessionSpecV2
  → adapter creates its own independent backend binding
  → Host emits summary; UI renders without changing focus
```

The exported pure admission function compares verified snapshot IDs, target and worktree identity; callers MUST revalidate target-local Git identity/generation and symlink-resolved cwd containment at the Host immediately before admission. `cwdRelativeToWorktree` is POSIX relative notation: `.` or segments without `.`/`..`, backslash, absolute prefix, NUL or empty segment. It is not a security substitute for realpath checks. Never derive identity from branch/path/connection ID, and never synthesize missing workspaceIdentity or generation. Distinct target IDs or generations never merge even when paths match. No creation or destructive Git operation is implemented by this contract.

New writable records require strict schemaVersion 2 and projectId/workspaceId. Legacy schemaVersion 1 is a read/migration format only; current runtime v1 writer is not migrated in this P1 lane. Migration retains original native ID, model selection and subdirectory cwd, and needs actual target verification; unknown/offline/non-Git records remain read-only pending explicit mapping. Future versions are not writable. No implicit fallback to a local/default target or harness. Duplicate IDs must be rejected within the authoritative catalog/host index before write; a Zod object alone cannot determine cross-record uniqueness. Summary contains all unarchived top-level host sessions regardless of collapsed UI, and freshness is orthogonal to execution state. Hidden workspaces with pending interactions remain visible in project attention counts.

Acceptance: serialization and strict versions, wrong project/binding/target/generation, cwd traversal, duplicate IDs, three independent sessions on one worktree including two same-harness IDs, and no v1 write admission. Target filesystem/Git implementation, offline freshness reconciliation, sidebars and legacy mapping belong to P2/P4 owners.

## Downstream migration seam (not implemented here)

1. Project Catalog/WorktreeService validates repository common directory, target, main/linked status, worktree generation and cwd realpath on the actual target; record a durable legacy→project/workspace mapping with backup and idempotent dry-run. Never map solely on path, branch or opened tabs. Missing/offline/ambiguous old records remain readable and unadmitted.
2. Runtime owner changes `SessionHost.create`, `TargetAgentHostService.create`, manifest/index and route to accept only `SessionSpecV2` via `writableSessionSpecV2Schema` and target-derived admission, checks hostSessionId uniqueness in the target index, checks selected model with the authoritative model catalog and adapter inspection, and binds `BackendBindingV2` to the verified target/workspace/generation/harness. The old `IAgentHostService.create(SessionSpec)` currently still writes v1; it is legacy and must be removed from _new_ admission before claiming v2 integration. No new v1 writes in final path.
3. Legacy `sessionSpecSchema`/`SessionSpec` aliases remain for existing consumers while their read-only history and migration paths use `legacySessionSpecSchema`/`LegacySessionSpec`. Preserve original native session ID, requested model and exact old subdirectory cwd after verified mapping; no prompt replay, no new native identity, no silent root cwd. Unknown future schemas refuse writes.
4. `IAgentHostV2Admission` defines the next Host surface (not yet wired as a channel). UI/facade uses target-scoped catalog, not `register()` or a hard-coded logo list; sidebar consumes summary, leaving native `glm` wire identity untouched. Legacy writer/tests remain baseline compatibility evidence only, not v2 acceptance.
