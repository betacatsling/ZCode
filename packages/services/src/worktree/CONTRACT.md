# Worktree module contract

`IWorktreeService` is target-scoped. `getAvailability()` returns the injected
stable target ID and whether the target Worktree owner is writable. It discovers
Git worktrees through an injected parameterized Git command port and persists
explicit adoption, revalidation, creation, and confirmed linked-worktree
removal. Repository bindings are keyed by target ID and canonical Git common
directory; workspace records retain canonical path, device/inode evidence,
lifecycle, verification, and generation.

The service creates linked worktrees only through `createWorkspace`; it removes
only a Git-confirmed linked worktree after a clean preview, explicit token and
generation, a frozen native/external admission fence, authoritative idle owner
facts, and a final Git/path/evidence recheck. Removal never uses force, removes
branches, or deletes history. `updateWorkspace` rename/archive/unarchive
operations are metadata-only; archive blocks new admission but leaves activity
visible. A Git-success/persistence-failure creation returns a typed
unregistered result and leaves the worktree for explicit adoption. Only a
persisted full creation receipt makes an exact retry idempotent; existing
adopted or unreceipted candidates cannot be silently claimed. File persistence
uses the existing shared lock and atomic-write helpers. Unknown/future schemas,
unknown owners, and failed scans fail closed without clearing valid records.

`adoptBareRepository(projectId, request)` handles an explicitly discovered
bare repository even when it has no linked worktree candidates. It re-discovers
under the target operation lock and checks the target ID, repository path,
common directory, and filesystem evidence before creating or reusing only a
`RepositoryBinding`. It never creates a synthetic workspace or touches the
repository. Repeating the same request is idempotent; another Project cannot
claim an existing target/common-directory binding. A later `createWorkspace`
uses that binding and still validates its base commit through Git, so an empty
bare repository cannot create a branch without a valid base.

Admission lifecycle decisions live in the app layer and use the public
`WorkspaceAdmissionFencePort`. The Node adapter owns fence paths, file reads,
atomic writes, and lock acquisition through the existing shared lock helper.
Node composition supplies this port to both Worktree operations and native or
external admission routes. App code imports no Node filesystem or shared Node
implementation.

Native quiescence is idle only when the V4 owner can enumerate every persisted
session and read each session's live projection and CommandInbox pins. A
persisted but unmounted session currently returns `unknown`, including an idle
cold-history session; starting a read-only owner does not mount it. That
conservative behavior can leave a clean worktree unremovable until a native
owner capability can prove the cold session has no accepted input, active turn,
approval, or uncertain runtime state. Do not infer idle from absence of a
mounted publisher. Existing old-session history remains readable; history-only
adoption is not resumable execution.
