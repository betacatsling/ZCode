# Workspace admission and linked-worktree removal (08A)

## Ownership and contract

`IWorktreeService` is the target-local owner of worktree identity, generation,
lifecycle, admission fence, and removal. Its catalog remains the only source of
workspace paths. `CommandInbox` remains the only owner of accepted native V4
commands and pending/held input. `AgentHostTargetService` remains the only
owner of external sessions and backend admission. The target host joins those
facts for removal; it does not copy either queue.

The target Worktree service exposes a read-only removal preview and a separate
confirmed remove call. A preview binds a short-lived token to target ID,
workspace ID, generation, canonical path, filesystem evidence, repository
common directory, and Git candidate. Confirm must supply that token and the
expected generation. Tokens are single-use. Main worktrees, dirty or untracked
worktrees, submodules, locked worktrees, stale generations, unverified paths,
and unavailable owners are rejected without stopping sessions or touching the
directory.

Worktree app code owns lifecycle decisions but performs no filesystem or lock
IO. It depends on the public Worktree admission-fence port; a Node adapter owns
fence file paths, reads, atomic writes, and lock acquisition, reusing the
shared file-lock implementation. Node service composition supplies that
adapter. Renderer and other domain code use the service contract and never
import the Node adapter directly.

Native command admission and external `create`/`attach`/`dispatch` share one
per-target, per-workspace filesystem fence. It uses the existing target state
root and cross-process file-lock primitive, keyed by
`workspaceIdentity?.trim() || workspacePath` without trimming the path. Native
CommandInbox acquires this fence while making its accept/reject decision and
pinning the command. External admission acquires it while its owner records the
session or accepted command. Remove changes the fence to `frozen` before
reading activity; the fence remains frozen through Git removal and catalog
registration. A deny reopens only the same token/generation. Successful removal
leaves a durable `removed` fence, so late requests cannot use the old runtime.
Archived workspaces use an `archived` fence for new admission, while existing
activity remains visible to removal checks.

Removal asks the native owner for a strict, read-only quiescence result. The
result includes CommandInbox in-flight/live-input pins (including accepted
queued or held work), live runtime phases, active work, queued items, and pending
interactions. If Main has no announced task/session owner, the requesting Host
may start one CLI process only to perform that read; it does not attach/resume a
session or replay work. An unmounted persisted session, missing/unresponsive
owner, incomplete enumeration, unsupported protocol, stale generation, or read
error is `unknown`, never idle. The host also reads the complete target
`IAgentHostService.listActivityIndex()` and
matches all sessions by target and normalized workspace identity/path,
independent of archive or UI visibility. Running, approval-pending, queued,
held, and unknown external activity denies removal.

The check cannot enumerate processes started outside ZCode. Preview therefore
states that boundary and requires explicit confirmation even for a clean,
quiescent linked worktree. It does not claim that a successful check proves no
external writer exists.

## Event order and failure boundary

```text
native CommandInbox admission ─┐
external Host create/send ─────┼─ shared workspace fence
                              │
remove preview ── Git/evidence + idle-owner preview token
                              │
remove confirm ── freeze fence ── read native inbox/runtime + external index
                              │             │
                              │             ├─ busy/unknown/stale → reopen; no Git/session side effect
                              │             └─ proven idle → recheck generation, realpath, evidence, Git state
                              │                                  └─ plain `git worktree remove`
                              │                                       ├─ Git failure + candidate remains → reopen
                              │                                       ├─ ambiguous result → keep frozen
                              │                                       └─ Git success → persist `removed`; keep fence closed
                              └─ late native/external admission sees frozen/removed/stale and rejects
```

The Worktree operation lock serializes Git create/remove and metadata recovery.
The per-workspace admission lock serializes the final admission edge with
freeze. Lock order is admission fence, then Worktree operation lock, then the
existing catalog persistence lock. No path acquires those locks in reverse.
There is no timeout-based idle inference. A lock timeout or failed owner query
is a denial. If Git succeeds but catalog persistence fails, the fence remains
closed; a later preview can confirm from Git that the candidate and directory
are absent, then finish the metadata update without repeating the Git side
effect.

History reads keep using persisted native IDs, cwd, target, and external
session locators after removal. History operations never acquire an execution
permit or recreate a path. A new session/turn requires the current active
generation and a verified path. Archive is metadata-only and does not stop
execution; activity indexes are never filtered by lifecycle.

## Public surface and migration

- `IWorktreeService.previewRemoveWorkspace({ workspaceId, expectedGeneration })`
  returns risks, `safeToRemove`, a one-use `confirmationToken`, and the
  external-process boundary statement.
- `IWorktreeService.removeWorkspace({ workspaceId, expectedGeneration,
confirmationToken })` revalidates and removes only the exact linked Git
  worktree, preserving its branch, repository, and session history.
- Target-local admission runners are injected into native and external owners;
  they are not renderer-supplied paths and are not exposed as a second queue.
- Admission and freeze are verified across processes with a temporary fence
  directory: while one process holds the shared fence lock and records frozen,
  native `create`/`send` and external `create`/`send` cannot be accepted; child
  processes are always awaited and reaped.
- External V1 session/history records remain readable. New workspace-based
  external creation accepts workspace ID and expected generation; the Host
  derives target, path, and normalized identity from `IWorktreeService`.
- Old native/external records without a generation remain history-readable.
  Their original owner generation is persisted and reloaded; a current Host
  generation supplied during a later query cannot upgrade an old session.
  They do not authorize new admission after a workspace has a managed fence.

The current native idle proof path is `listStoredWorkspaceSessionIds` for the
complete persisted session set, followed by a live V4 publisher snapshot and
`CommandInbox.workspacePins()` for every returned session ID. A missing
publisher makes the enumeration incomplete and returns `unknown`. Merely
starting a read-only owner process or observing no mounted worker is not proof.
An idle cold-history session can therefore keep a worktree unremovable until a
separately specified native owner capability can read its durable activity
facts without mounting execution. History-only adoption of an old session
preserves reads but does not claim resumable execution; complete recovery
remains explicit migration work.

## Acceptance scenarios

Use isolated temporary repositories and the pinned Git 2.45.4 binary. Verify a
clean linked remove preserves the branch and both native/external history;
main, dirty, untracked, submodule, and locked paths reject; running/held native
work and running/approval/unknown/archived external activity reject; concurrent
remove/create/send and two Host instances serialize; stale token/generation
reject; denials do not terminate any session; Git failure and catalog-write
failure recover by rechecking rather than repeating Git removal; and a removed
native session's original ID/cwd remains readable while new turns are denied.
