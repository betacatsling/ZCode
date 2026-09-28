# Target Worktree Service contract (P2 foundation)

This target-local service owns Git discovery, explicit adoption,
linked-worktree creation, and confirmed linked-worktree removal. It persists
`RepositoryBinding` and `WorktreeWorkspace` records for one injected execution
target. It does not move/prune worktrees, start an Agent, or update the Project
Catalog. The Catalog can reference the persisted `workspaceId`.

## Ownership and boundary

```text
target-scoped WorktreeService
  ├─ injected targetId provider
  ├─ injected parameterized Git exec + realpath/stat ports
  ├─ discover/adopt/revalidate/create/remove → one target catalog
  ├─ per-workspace admission fence + cross-process lock
  └─ binding/workspace facts + lifecycle/generation/filesystem evidence
```

The target ID is supplied by the host connection owner; this module never
constructs one from a path, SSH alias, or hostname. A binding is shared by
worktrees with the same target ID and canonical Git common directory. Different
targets remain isolated even when their paths or origins match. An origin URL
is never used to merge repository instances.

The persisted file is owned by this service and contains only target-owned
binding/worktree facts. Project Catalog owns Project names, workspace
references, pinning, and ordering. Sessions and runtime state remain outside
this file.

## Discovery

`discover(path)` passes arguments to the Git executable without a shell:

```text
git -C <path> rev-parse --show-toplevel
git -C <path> rev-parse --git-common-dir
git -C <path> rev-parse --is-bare-repository
git -C <path> worktree list --porcelain -z
```

The primary worktree parser consumes NUL-delimited records and never splits a
path on whitespace, spaces, or newlines. A target Git that rejects `-z` returns
a structured upgrade-required error; the service does not guess record
boundaries from line-oriented output.

Discovery returns explicit `git`, `bare`, or `nonGit` results. A Git result
includes the canonical common directory, main/linked worktree candidates,
branch or detached HEAD facts, canonical worktree path, and target-native
filesystem evidence. A bare repository has no executable main worktree; any
existing linked worktrees are still returned as candidates. Input from a child directory or linked worktree is resolved to the same common
directory and candidate set. Discovery never writes the Catalog file and never
changes Git.

## Adoption and persistence

`adopt(projectId, candidate)` validates that the candidate came from this
target and a Git result, then performs one locked read/validate/mutate/write:

- a new common directory creates one UUID `RepositoryBinding`;
- a new worktree creates one UUID `WorktreeWorkspace` with a UUID generation,
  `origin: "adopted"`, `lifecycle: "active"`, and `verification: "verified"`;
- repeating adoption of the same target/common-directory/path and unchanged
  filesystem evidence returns the existing records without duplicates;
- a path/evidence mismatch is not silently reused or merged and requires
  explicit revalidation.

The persisted envelope and records are strict `schemaVersion: 1`. Duplicate
stable IDs, binding/workspace ownership mismatches, future versions, and
malformed evidence reject the whole write. A failed Git scan or filesystem
probe never replaces a previously valid file with an empty result.

### Bare repository takeover without a worktree

`adoptBareRepository(projectId, request)` is the explicit takeover path when
discovery returns a bare repository with zero worktree candidates. The request
contains the target ID, discovery input path, canonical common directory, and
the discovery-time common-directory filesystem evidence. The service repeats
discovery under the target operation lock and accepts the request only when
the current result is still bare and all target/path/evidence facts match.

Successful adoption creates or reuses only a `RepositoryBinding`; it does not
create a fake main workspace, run `git init`, or create files. Repeating the
same adoption for the same target/common directory/Project/evidence is
idempotent. A stale common-directory observation, replaced repository path,
different target, or binding owned by another Project is rejected without
changing persisted state. A bare repository and its linked worktrees share a
binding when their target and common directory match; different targets remain
isolated even if they observe the same path.

A Project may therefore own a binding while it has no workspaces and no
default. Later `createWorkspace` uses that binding to create a real linked
worktree. `new-branch` still verifies `baseRef` as a commit with Git before
creation, so an empty bare repository is adoptable but cannot create a branch
without a valid base. A failed Project creation or binding adoption leaves the
other owner's successful record intact for explicit retry; no orphan
worktree cleanup or implicit cross-Project binding transfer is attempted.

Canonical paths are obtained through the injected target filesystem port. The
evidence stores the canonical path plus target-native device/inode/birth-time
values when available. These facts help distinguish a deleted-and-recreated directory;
they are evidence, not a security claim that symlinks or remote filesystems
cannot change underneath the process.

## Revalidation and failure semantics

`revalidate(workspaceId)` re-probes the stored path and common directory:

- matching canonical paths, filesystem evidence, and repository/worktree facts
  keep the generation and return `verified`;
- a missing path is retained as `lifecycle: "missing"` and
  `verification: "needsVerification"`;
- a recreated, moved, or otherwise mismatched instance is retained and marked
  `needsVerification`; no new workspace ID is fabricated;
- `acceptRebuild: true` is an explicit operator action that records the newly
  observed evidence and advances `worktreeGeneration`, fencing stale runtime
  contexts before returning `verified`.

Non-Git input, bare repositories, command failures, and ambiguous output are
reported as structured results/errors. Existing valid records remain readable
after every failed scan. Moving a worktree and pruning Git metadata remain
unsupported. Removal is a separate preview + confirmation operation documented
in [`WORKSPACE-ADMISSION.md`](WORKSPACE-ADMISSION.md); revalidation never
deletes or adopts a replacement implicitly.

## Workspace creation and metadata

`createWorkspace` is the target-owned write path for adding a linked
worktree. Its request is one of these strict forms:

```ts
type CreateWorkspaceRequest = {
  requestId: string;
  repositoryBindingId: string;
  projectId: string;
  worktreePath: string; // absolute target path
  title: string;
} &
  | { mode: "new-branch"; baseRef: string; newBranch: string }
  | { mode: "existing-branch"; existingBranch: string };
```

The service supplies `executionTargetId` from its fixed target authority. It
re-reads the binding and filesystem evidence under a cross-process operation
lock, validates refs with parameterized Git commands, rejects occupied paths,
branch conflicts, invalid refs, and a bare repository's own root, then runs
`git -c core.hooksPath=/dev/null -C <common-dir> worktree add ...`. Discovery
and preflight never execute hooks. A bare repository may create a linked
worktree; the operation never clones or removes a branch.

After Git succeeds the service discovers the new candidate and registers the
target-owned `WorktreeWorkspace` in the same operation sequence, recording a
full creation receipt. Repeating the exact request with that receipt returns
`already-present` without running `git worktree add` again. A pre-existing
adopted/main/linked candidate, or a Git-success candidate without a persisted
receipt, requires explicit `adopt`; it is never silently claimed by create. If
Git succeeded but persistence failed, the result is `status: "unregistered"`
with the candidate when discovery succeeded and a retryable error; the service
never removes the user worktree or branch.

`updateWorkspace` accepts strict `operation: "rename" | "archive" |
"unarchive"` requests and mutates only workspace metadata. Archive returns the
resulting `lifecycle: "archived"` record and does not terminate a session or
delete files; its fence prevents new sessions/turns while existing activity
remains visible. Project default workspace and `isMainWorktree` remain
independent facts.
