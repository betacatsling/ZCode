# Project sidebar and read-only Host ports

This is the first product UI slice for the v0.3 Project → Worktree → Agent
hierarchy. It adds a read-only Host directory and bounded session summaries,
then projects them with the existing hierarchy/sidebar contracts. The existing
WorkspaceSidebar remains the fallback and continues to own native task actions.
The Project tree replaces only the old Project/Workspace list region; footer,
task flow, conversation flow and other WorkspaceSidebar actions remain mounted
once.

## Owners and ports

```text
ProjectCatalogService ── Project metadata and workspace references
WorktreeService       ── RepositoryBinding/WorktreeWorkspace and adoption
SessionHierarchy      ── native session membership and migration records
AgentHost              ── trusted Harness directory and external summaries
projectSidebarProjector ── pure joined SidebarSnapshot
projectSidebarViewStore ── expanded/hidden/selected window view state only
```

The Catalog is the only owner of Project metadata and workspace references;
WorktreeService owns repository bindings and adopted workspaces; SessionHierarchy
owns membership/migration records; AgentHost owns external execution facts and
summaries. The per-window Zustand store owns expansion, visibility, ordering and
selection preferences. View state never writes Catalog, WorktreeService, Host,
migration or runtime facts. Attention totals are derived from the complete
projection before hidden/collapsed presentation is applied.

`IAgentHostService.getDirectory()` returns a target-scoped manifest directory.
The native `zcode` manifest is injected by the Host directory source; external
manifests are additive views over the existing executable Registry. A manifest
does not claim a capability or a runnable route. Unknown IDs and unknown static
asset IDs resolve to safe fallback icons.

The first checked-in native asset IDs reuse the existing ZCode/GLM monochrome
resources under `packages/ui/src/assets/cli-icons/`; Pi keeps a generic/initial
fallback until a licensed Pi asset is supplied. That fallback is an explicit
availability boundary and is not treated as a certified brand icon.

`IAgentHostService.listSessionSummaries(workspaceIdentity, worktreePath)` is a
read-only bounded summary port. Mounted Hosts derive activity, pending
interactions and recent outcome from their in-memory journal state. Cold rows
come from stored manifest/index facts only and are marked stale/offline with
unknown runtime outcome; this call never starts an adapter, reads a transcript,
or fabricates completion. The session `spec` remains the identity locator.
For a session `spec`, preserve `execution.workspaceIdentity` byte-for-byte when
matching summaries, hierarchy owners and events. It is already the canonical
identity key; trimming it could route a row to a different workspace. Fall back
to the spec's worktree path only when that identity field is absent.
Preserve the source session title and last update time when present; a Host-only
row may use its stable `hostSessionId` only as the explicit fallback title.
An absent summary cannot prove that the session never had a turn, so projections
use `recentOutcome: "unknown"`; `"none"` is reserved for an explicit Host fact
that a new session has no prior turn.
Missing capabilities are represented as unavailable/disabled with a reason,
never as an assumed native command path.

Freshness is separate from execution and last-turn outcome. On a transient
disconnect in the same workspace identity, target and Host generation, retain
the last ready tree and mark its target/session rows stale or offline. Never
translate loss of connectivity into `completed`, clear the tree, or infer that
a session stopped. On a workspace/target/Host generation change, invalidate
old requests immediately; late Catalog, Worktree, migration, directory, summary
or create results from the previous scope cannot update the new scope. An event
refreshes only summaries for affected workspace(s), coalesces bursts with one
in-flight refresh plus at most one trailing refresh, and never reads transcripts
or reruns discovery/migration/Git work per token. Continuous text deltas and
usage reports do not refresh sidebar summaries.

## Multi-target profile tree and bare-repository flow

One window renders the profile Catalog as one Project tree. Project existence,
target-scoped repository/workspace membership, defaults and last verified
presentation come only from `ProjectCatalogService.readWorkspaceCatalog()`;
tabs and open workspaces are never Catalog inputs. The local base services and
currently registered remote workspace attachments are enumerated through the
existing `useWorkspaceServices`/window connection store. Each attached target is
identified by `IWorktreeService.getAvailability().targetId`; its attachment
generation fences reads and its `remoteSessionId` is used only when routing a
live action. Row labels reuse the configured RemoteTarget presentation helper
after stripping secrets. Catalog V2 may cache only an optional target kind and
safe display name; it never stores an attachment/session ID or connection secret.
An unverified legacy row uses localized verification copy, not its raw UUID, as
the default product label.

For each durable target ID, sidebar work is serialized in this order:

```text
attachment source + generation
  → getAvailability(targetId)
  → mark a newly attached generation stale in the profile Catalog
  → Worktree.read + bounded hierarchy/directory/session summary reads
  → reject if attachment generation changed
  → ingestTargetSnapshot(targetId, worktree facts + display summaries)
  → readWorkspaceCatalog(all known target IDs: connected or offline)
  → merge target-scoped rows by (targetId, workspaceId)
```

Different targets may refresh independently. A failed or superseded target
keeps its cached rows and summary freshness; it cannot clear or change another
target's rows, selection, or session activity. Only a successful authoritative
read plus Catalog ingestion makes the target presentation live. Cached rows have
title, head and cached summary but no execution path or generation. They are
visible as stale/offline/unknown, and cannot start, select, create, or run Git.
Every live action resolves its target from the current attachment again and
uses that target's current services; the Catalog is never an execution route.
An optional target presentation in Catalog V2 contains only a target kind and a
safe display name generated from the existing RemoteTarget label helper after
secret stripping. It does not contain a remoteSessionId, host credential or
execution authority.

Workspace expansion, hide, active selection and session selection use stable
composite keys containing target ID plus workspace/session IDs. On migration
from the previous window-store version, a legacy workspace ID is carried over
only when the loaded Catalog proves it occurs on exactly one target. Ambiguous
legacy IDs are not assigned to an arbitrary target. Project expansion remains
Project-scoped. This state stays window-local and never writes back to the
profile Catalog or Host.

A legacy default Workspace without a scoped `defaultWorkspaceTargetId` is
rendered as default only for an unscoped legacy reference. Matching Workspace
IDs on connected targets do not inherit that old default by identity alone.

Import explicitly selects one currently attached target and either a new
Project or an existing profile Project. Adding a target never replaces that
Project's references or scoped default. Ordinary Git discovery still requires a user-selected candidate. If a target reports a bare
repository with zero worktree candidates, the form offers an explicit
“adopt bare repository” action. Confirming it creates/reuses the Project and
calls `adoptBareRepository` with the discovery evidence, then ingests the
target's real binding. The resulting Project has a repository reference but no
Workspace/default; no synthetic main checkout, local Git call, branch, or file
is created. A partial failure retains the same Project intent and retries only
the missing owner write. Later workspace creation requires an explicit
connected target/binding choice and explicit title, path, branch mode, and
base/branch. Multiple target bindings are never selected by array order. An
empty bare repository without a valid base ref reports the Git validation
failure and remains adopted without a fake workspace.

If there is no usable current target source, the sidebar keeps the existing
workspace/task region available and gives cached offline targets a clear
read-only/reconnect explanation. Existing remote connection configuration and
attachment flows remain the only way to restore a route. A Host that lacks the
required sidebar services falls back to the legacy region; it does not render a
partially fabricated live tree. New-session picker/API work remains out of this
slice.

## UI behavior

The new tree replaces only the existing Project/Workspace list region inside
`WorkspaceSidebar`; the footer, task flow, conversation flow and legacy actions
remain in place. The old workspace/tasks content is supplied through a render
callback so rows already mapped to a live native Project session can be removed
from the compatibility list by `(workspaceIdentity-or-path, sessionId)`. When
the Catalog is nonempty, remaining old/non-Git/pending workspaces stay reachable
inside a collapsed “legacy workspaces and task history” section. That section is
the history-only fallback and does not inherit a current Project execution
route. A missing required service, failed initial read, or unsupported active
Host shows the original legacy DOM. If the Catalog is empty, show the Project
management/add entry together with the legacy list directly. An individual
pending native record is shown as “needs verification” where its workspace
membership is known; it does not hide the project or empty workspace.

Catalog/worktree mutation order is explicit:

```text
user intent (stable ID)
  → discover(path)
  → user explicitly selects candidate
  → adopt(projectId, candidate)
  → create/reuse Project metadata without inventing a targetless workspace ID
  → ingest the authoritative target snapshot to add scoped repository/workspace refs
```

Never choose the first discovered candidate on behalf of the user: that can
change a linked-worktree input into its main checkout. Keep one intent ID and
Project ID across retries. Each retry rereads both owners and performs only
missing steps. For a new Project, create metadata first, then adopt and ingest
the real target snapshot; a failed cross-owner write leaves a recoverable empty
Project or target binding. If the repository binding already belongs to another Project, reuse it only when the
candidate explicitly identifies that owner or report the ownership conflict;
never move it implicitly. A bare repository with linked worktrees can be
adopted. Adoption never creates a branch, moves files, or creates a worktree.
If an existing Project's reference write fails after adoption, retry only that
target snapshot ingestion. Never use legacy `setWorkspaceRefs` to represent a
target-scoped reference.

For a bare repository with no candidates, the explicit bare action is a separate
path: create or reuse the Project with no workspace/default, adopt only its
RepositoryBinding, then ingest the binding into the target-scoped Catalog
reference. Retry the same Project ID and evidence after a partial failure.

Creating a workspace uses the frozen strict WorktreeService port: the user
chooses either a new branch or an existing branch, and request/result types come
from that contract. If Git succeeds but Catalog registration does not, display
the returned unregistered candidate with an explicit recovery path; do not show
success. The recovery action adopts that exact candidate through
`WorktreeService.adopt(projectId, candidate)` and then repairs the Project's
workspace references. It never repeats `createWorkspace` or the Git operation.
Keep the original create request ID stable for the lifetime of the form intent,
and retain scope fencing for late results. Re-adoption is idempotent when the
Worktree receipt already exists but the Catalog reference write failed; repair
only missing references and preserve the Project's existing default workspace.
If an unregistered result has no candidate, do not choose a discovery result
implicitly or retry creation. Show a recoverable instruction to refresh
discovery and explicitly select the existing path for adoption. Native creation uses the existing callback with the original owner
`workspacePath` and `workspaceIdentity`. Existing external-session selection
and V4 conversation routing follow the linked owner locator and target
attachment rules in [UI-CONVERSATION.md](./UI-CONVERSATION.md). Pi/session
creation remains outside this slice. Absent a confirmed mapping and capability,
show a disabled action and reason rather than substituting the worktree root or
fabricating a native ID.

The owner and event order for workspace recovery is:

```text
stable create intent
  → WorktreeService.createWorkspace → Git worktree add → Worktree persistence
  → ProjectCatalogService.setWorkspaceRefs
       ├─ Worktree write failed → unregistered(candidate, no receipt)
       ├─ Catalog ref failed    → unregistered(candidate, receipt exists)
       └─ success               → fenced refresh
unregistered(candidate) → explicit recovery click → adopt(exact candidate)
                        → repair missing Catalog refs → fenced refresh
unregistered(null)      → read-only discovery → explicit candidate selection → adopt
```

Workspace creation chooses an attached target and one of that target's
Project-owned RepositoryBindings. A single binding may be preselected; when
multiple target/binding pairs exist, the user must choose explicitly. Cached
offline references remain visible but cannot be selected for writes. Rename and
archive actions stay disabled until the target Worktree port exposes the frozen
mutation contract; a disabled entry explains the missing capability and does
not imply that a Git operation completed.

`desktop-continuous` and `web-remote-replayable` share the same Host-owned
summary and session identity. `ProjectSidebarSessionAction` is discriminated by
owner kind. Native actions route with the migration record's original
path/identity and native session ID; the worktree root is only display and
membership context. External actions route with the Host session ID and never
fall back to native IDs. With no owner mapping, open/select is disabled with a
visible reason. Background events update rows and counts without changing
focused input, active selection or keyboard focus. Offline/stale preserves the
last tree; it does not clear the project, convert to completed, or remove an
empty workspace. Aggregate counts are calculated from all hierarchy rows before
hidden/filter/pagination state.

If a collapsed Project or hidden Workspace has pending interaction, a Project
attention entry can explicitly expand the Project and reveal that Workspace.
Hidden/collapsed rows continue to contribute to totals. Labeled touch-sized
controls remain available on mobile; editable controls use
`text-mobile-input-safe`. All user-visible strings use both supported locale
files and existing Button/Input primitives and design tokens.

## Acceptance cases

1. Empty Catalog renders old workspace/tasks DOM and a reachable add-Project
   management entry. Missing Host/service/capability renders the legacy region.
2. Two Projects each show multiple Workspaces, including an empty workspace,
   main worktree, linked worktree and detached HEAD. The fixture includes
   multiple sessions under one workspace and two sessions with the same Harness.
3. Discover requires explicit candidate selection; adopt then register updates
   Worktree and Catalog refs without changing files or branches. Retry after
   Worktree adoption or Catalog failure reuses intent/IDs and completes only
   missing steps, including a bare repository with linked worktrees and a
   binding already owned elsewhere.
4. A create result marked unregistered displays its recovery candidate. It is
   never reported as a successfully registered workspace. The explicit recovery
   action adopts that candidate and repairs Catalog refs without a second create
   request; its directory, branch and Project default workspace remain unchanged.
5. An unregistered result without a candidate provides a clear recovery
   instruction and never selects the first rediscovered candidate or reruns Git.
6. When Worktree registration succeeded but Catalog reference persistence failed,
   recovery repeats adoption idempotently and writes the missing reference once.
   An existing user-linked path remains rejected by ordinary create and can be
   registered only after an explicit adopt action.
7. A pending/failed/offline row remains reachable through a collapsed or hidden
   workspace Project attention entry; aggregate counts still include it.
8. Same-scope offline preserves the tree and marks freshness stale/offline.
   Changing workspace/target/Host rejects late refresh and summary results.
9. A background summary update while an input is focused preserves its DOM
   node, text, active selection and focus; it does not trigger full Git or
   migration reads.
10. Native session actions use original migrated cwd/identity/native ID; external
    actions use only Host ID. Unmapped and unsupported create actions remain
    disabled with reasons.
11. Mobile controls remain reachable by touch and editable fields use the 16px
    mobile-safe token; English and Chinese strings remain complete.
12. Browser acceptance uses an isolated service-port fixture; it is not live
    Provider, SSH, or full Electron certification.
13. Two targets with the same path and workspace ID remain two visible rows;
    project defaults, workspace expansion, hide and selection are scoped by
    target. A reload preserves the profile tree even when all targets are
    offline, and cached summaries remain stale/offline/unknown until a real
    target read succeeds. A late previous-generation read cannot overwrite the
    current target view.
14. Import and create preserve every existing target reference/default. Bare
    zero-worktree adoption creates only a binding; a later explicit binding
    selection can create a linked workspace. Empty-bare base validation fails
    visibly, and ambiguous target/binding choices require explicit selection.
15. Browser validation uses production React/Vite components with real
    file-backed ProjectCatalog and Worktree services over isolated temporary Git
    repositories. It asserts visible DOM state and persisted owner files,
    including old-Host/empty-Catalog fallback and the accepted external-chat
    route, focus, locale and mobile-width behavior.
16. With a nonempty modern target tree and an old or non-Git/pending legacy
    workspace still open, mapped native sessions do not appear twice, while
    unmatched legacy history remains reachable in the compatibility section.

Production Node registration of the new Host methods remains an integration
dependency where the service channel is assembled by another owner.
