# Legacy session hierarchy migration (P2 metadata foundation)

This service maps persisted task/session index entries to the already adopted
Project → WorktreeWorkspace hierarchy. It never scans tabs, reads transcripts,
starts an Agent, sends a prompt, changes Git, or rewrites native/external
session data.

```text
TaskIndex/session index (all persisted locators)
  ├─ native-v4 task IDs
  └─ AgentHost persisted manifests (hostSessionId)
       ↓
  → WorktreeService.read (target-owned adopted facts only)
  → WorktreeService.discover (read-only root resolution for subdirectories/nested repos)
  → preview: linked records + pending-verification reasons
  → explicit apply: atomic versioned metadata sidecar
```

`ownerKind: "native-v4"` records use the existing native task/session ID;
`ownerKind: "agent-host"` records use the persisted Host `hostSessionId`.
The two are never treated as a backend ID mapping or replacement session.
`hierarchySessionId` is independently derived from owner kind, target,
workspace identity, Harness, source key, and native/host session ID. Native
ZCode remains CLI-owned and external sessions remain SessionHost-owned.
The sidecar keeps the original owner `workspacePath` and session ID for routing;
canonical Worktree root/common-dir fields are internal matching evidence and
are never substituted into the owner locator.

The sidecar is strict `schemaVersion: 1` and stores source fingerprint,
command key, target/workspace locator, original native ID, model selection and
cwd relative to the adopted worktree. Missing/non-Git/remote-offline/unknown
Harness/unverified cwd entries stay readable as `pending-verification`; the
service never falls back to the local target or GLM.

Preview is repeatable. The source snapshot, including nested locator fields and
target worktree generation facts, is sorted and hashed; equal source
fingerprint/command key returns the existing preview/apply result without
rebuilding hierarchy IDs. Apply accepts only the preview source token and an
explicit expected current revision (`null` for an empty sidecar). While holding the sidecar lock, the
service rereads the persisted index and Worktree facts, recomputes the preview,
and rejects a stale token or baseline before writing. A failed write leaves the
previous sidecar and user files untouched. Each changed sidecar writes a
versioned `.bak` record containing `{ appliedRevision, previous }`; an
idempotent apply does not rewrite it. The explicit rollback operation checks
both the current revision and the backup's applied revision, then restores the
previous sidecar (or removes the sidecar when `previous` is `null`). It never
touches native session or Git files. Unknown future sidecars are read-only to
this version.

The service exposes `read`, `preview`, `apply`, and guarded sidecar `rollback`.
Worktree creation,
Project Catalog mutation, old session content migration, remote discovery while
offline, and UI presentation belong to later owners.

## Explicit workspace session creation and current membership

The target-scoped `IAgentHostService.createWorkspaceSession` operation creates
one persisted owner for an explicitly requested workspace session. Its request
contains `requestId`, `workspaceId`, `worktreeGeneration`, a Harness ID, an
explicit model binding, and an optional title. It never accepts a path or
target. The Host resolves both from `IWorktreeService`, checks that the target
is available and the workspace is still active and verified at the expected
generation, verifies the real directory/cwd policy, and relies on the existing
shared workspace admission fence before accepting the owner operation.

`zcode` preserves native model-selection semantics and goes through the
existing V4 `createSession` command and native CLI owner. An explicitly managed
native session is persisted immediately, including when it has no first input;
the existing automatic prewarm path remains an unassociated deferred draft and
stays hidden. The native owner stores only a stable managed association
(`workspaceId` and the original `worktreeGeneration`) and an idempotent create
receipt in its existing session entries. It does not copy runtime or model
state. `pi` uses the existing workspace-derived external create path and its
Host manifest; its model binding is validated by the current Harness adapter
and Model layer. Neither path sends a model prompt.

The target Host keeps a bounded, target-scoped create-receipt index containing
only the request fingerprint, owner kind/ID, workspace ID/generation/identity,
Harness, and requested title. It reserves an idempotency key before owner
create and marks it created only after a durable owner result. It does not
contain model selection, runtime state, accepted inputs, or a queue. This small
owner receipt prevents cross-Harness request-ID reuse without starting Native
ZCode to check the other Harness.

The service uses `requestId` as an idempotency key. Repeating the same request
returns the same owner session ID, including after owner restart. Reusing that
key with a different workspace generation, Harness, title, or model binding is
rejected. Native V4 command admission remains the only accepted command queue.
The Host does not create a second runtime, process scheduler, or queue. If an
owner has durably created a session but the response or hierarchy read fails,
the persisted owner receipt/manifest remains the recovery point; the Host must
return or recover that same ID and must not create a replacement or delete the
session.

`ISessionHierarchyService.read()` is the current membership read. It merges
already-confirmed migration-sidecar records with current owner facts: native
managed session entries and external Host manifests. Owner facts must match the
exact workspace ID and original generation to link as current; older or
unavailable owner facts are still enumerated as read-only history. This read
does not run legacy preview/apply, scan TaskIndex, read transcripts, attach an
owner, or infer a generation for an old session. A session with no managed
association remains history-only unless a user separately applies the existing
migration. Existing preview/apply/CAS backup/rollback behavior is unchanged.

The read-only owner index includes retained workspaces in every lifecycle and
verification state. It also enumerates owners for the retained `workspaceId`
without filtering them to the workspace's current generation. Only an owner
whose original workspace ID and generation exactly match an active, verified
worktree is linked as current. Archived, missing, removed, unverified, and
stale-generation owners remain visible as `pending-verification` history with
their original path, optional identity, Harness, session ID, and persisted
workspace association. A generation mismatch is classified as stale history;
it is never rebound to the newer generation. The history locator is
read-only metadata and is not an execution grant. Even `ownerAssociation` on a
linked row records workspace membership only; it does not claim that the
runtime is live or authorize an execution route.

For the native owner, an already-available owner index is authoritative. A
confirmed creation receipt may recover the original owner ID and creation
locator when that index is unavailable, but it proves creation only; runtime
state remains unknown and the row stays pending verification. Missing or
corrupt owner data is reported as unknown and never triggers session creation
or replacement. Pi history comes directly from target-local manifests. Neither
source starts a CLI, attaches a session, loads a model, or scans transcript
bodies. A retained sidecar mapping is merged by its complete owner locator and
is not discarded merely because the current Worktree catalog no longer has the
same generation.

`buildSessionHierarchyPreview` applies the same distinction: an exact active,
verified generation may be linked; all other retained owners are history-only
and have no current owner association or execution action. Archived, missing,
removed, unverified, and generation-mismatched cases carry explicit pending
reasons so a consumer can explain why the row is read-only. Legacy sidecar
records remain compatible and are not automatically migrated.

Workspace identity is resolved once at the boundary as
`workspaceIdentity?.trim() || workspacePath`. An explicit identity is trimmed;
the filesystem path fallback stays byte-for-byte intact, including spaces and
newlines. SessionSpec V1's legacy `workspaceIdentity` field stores that
resolved canonical key and is opaque after derivation; receipts keep optional
explicit identity separate from the original path. Existing strict V1
manifests and native owner paths are never rewritten to repair historical
trimmed fallback identities; an ambiguous legacy mapping remains
`needsVerification`.

Current Native membership reads use the receipt index as a non-activating
fallback after an owner restart. If the Native owner is already running, Host
may query its narrow read-only association index; it never starts the Native
process or attaches a session just to render the hierarchy. Current Pi rows
come from their Host manifests. A receipt in `reserved` state alone is not
projected as a Native session. Receipt-only rows are creation history with
unknown runtime state, not evidence that a session is running or complete.

```text
UI/Host attachment
  → createWorkspaceSession(requestId, workspaceId, expected generation, harness, binding)
  → Host reads IWorktreeService and verifies target, lifecycle, generation, realpath, and fence
  → Host reserves the idempotency receipt
  → zcode: V4 createSession → CommandInbox → native owner DB
    pi:     workspace-derived create → SessionHost → manifest
  → persist owner association/receipt → return the durable owner locator
  → hierarchy.read → merge confirmed migration mappings + exact owner facts
```

Acceptance covers two independent Pi owners and one empty native owner in one
worktree; current membership after service/owner restart; explicit title and
model binding; duplicate and conflicting request IDs; response/read failure
recovery; frozen, archived, removed, stale-generation, unavailable, symlink,
and replaced-directory rejection; history discovery after archive, missing,
remove, and generation rebuild; receipt-only runtime-unknown projection; exact
path identity with spaces/newlines; no new Worktree; and zero model calls. These
cases use a temporary Git worktree, real SQLite owner persistence, manifests,
and a no-cost fake Pi adapter. Generic Web and unscoped RPC do not receive the
creation capability.

The Node TaskIndex adapter assigns the injected target and `zcode` Harness only
to path-only local rows; valid remote workspace identities stay unresolved so
they cannot be claimed by the local target. Imported Claude rows keep Harness
unresolved. The durable workspace path is used as the native cwd head, while
the legacy model string is retained only in the source fingerprint and is not
converted into a `ModelSelection` because its provider identity is not
persisted. Native-v4 linking does not require a copied model selection; the
native owner remains responsible for model state. AgentHost manifests provide their
target/workspace/Harness/model-binding facts through public `listSessions`; no
worker or transcript is read. Nested and subdirectory paths are resolved by
target Worktree discovery, never by string-prefix ownership.
