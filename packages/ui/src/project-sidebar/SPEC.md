# Mounted project hierarchy (UI)

The profile Catalog owns projects, bindings, workspace presentation and the session index; target/Host own worktree identity, Git and runtime activity. The UI owns only expansion, selected row, drafts and scroll. Render the Catalog sidebar snapshot including projects without open tabs or sessions. Never create a worktree on session creation. Main checkout cannot be removed as a linked worktree.

## UI/host boundary

`ProjectSidebar` receives a complete validated `SidebarSnapshot`; its commands carry stable workspace ID/generation and creation intent. Selection carries the full indexed session summary to the shell; shell resolves `{targetId,workspaceId,sessionId}` via `IWorkspaceHierarchyService.resolveOwner` before navigating. Native navigation uses `originalSessionId` and the returned scope, external navigation uses `spec.hostSessionId` and scope. No unknown ID -> native fallback. `createAgent` returns authoritative owner; UI never allocates the session ID. Catalog `discover` is read-only, `adopt/create/remove/updateWorkspace` mutate through services, not Git from UI. Removal preview displays target-provided dirty/untracked/submodule/lock/unknown risks; final confirmation rechecks at target. If no preview authority exists, removal remains disabled. Failed commands leave their dialog open with error. A hidden workspace's waiting/error attention remains reachable via project-level entry.

```text
user intent -> catalog/target/Host command -> snapshot refresh -> visible tree
selection -> resolveOwner(target,workspace,session) -> native original ID or external spec -> pane
                            unknown/offline -> error, keep focus
```

Desktop live stream and mobile replayable reconnect only change the owner snapshot, never UI-authoritative status. Offline refresh retains last valid snapshot marked stale until a newer validated snapshot succeeds; don't claim live on transport loss. Feature-off or missing service keeps the existing native sidebar and navigation unchanged; hiding a workspace does not stop admitted work.

## Shell/pane routing (shell-pane)

When the authoritative hierarchy is mounted, its resolved owner is a navigation proof, not a tab or a second session index. The shell never calls the native `handleSelectTask` for external Host IDs and never creates a workspace tab merely to represent a Catalog row. It supplies a target-scoped owner to the selected workbench leaf and opts its `SessionPane` into `scoped` routing; an unresolved/mismatched nonempty ID renders an error without native subscription. External leaves must not mount the native workspace provider or the native restored-session index guard. The original native runtime ID, workspace scope and remote endpoint stay distinct from the Catalog tree alias. A new sidebar selection replaces only the current shell selection; workbench focus, drafts and Host rows remain owned by their respective pane/Host. Closing and reopening a session re-resolves it from hierarchy, never creates another session. Feature-off keeps the old native pane flow.

```text
Catalog selection → hierarchy.resolveOwner(target, workspace, alias) → shell navigation proof
  native original ID → pane scoped validation → native existing provider
  external Host ID  → pane scoped validation → Host provider → Host snapshot
  pending/unknown   → safe alert (no native provider, no native RPC)
Desktop continuous / mobile replayable → same Host journal; shell only selects view
```

When a prior workbench binding has no current proof (e.g. renderer restart), it is never classified as native merely from its ID or path. The UI must obtain a fresh hierarchy resolution before restoring execution. Only renderer-local navigation proofs are cached while mounted; the Catalog and Host remain authoritative. Focus/split of an unproven binding must not call native navigation; focus of a proven external binding selects that owner's Host view and never sends its ID to native. A shell-selected external binding must be the active workbench binding (including split placement), not a stale native activeTaskId. A late response for a different attachment cannot displace the current selection. Acceptance: native plus two Pi siblings in a workspace, late owner resolution, focus/draft persistence, desktop/mobile rendering, unknown no native RPC, and reopen without create.

## Current integration gates

The shell mounts the tree only if both authoritative services are present. The catalog/target contract currently lacks a trusted removal preview; the remove confirmation therefore stays disabled instead of calling remove without preflight. A local closed tab with a nonempty identity cannot be reopened through the legacy navigation helper without a target-verified local attachment classification; the shell fails closed rather than creating a fake remote or local tab. A Host-provided per-harness Model options API is also needed to enable verified host-managed model choices; the current picker offers only an explicitly labeled harness-managed request subject to Host rejection. These are not accepted production completion.

Acceptance: full shell with zero-session projects, multiple harness sessions in one worktree, two targets with same path, hidden waiting attention, native original ID, external spec, unknown navigation blocked, create failure preserving draft, main checkout no remove, stale snapshot on disconnect, desktop and mobile. Controlled-service fixture validates only the mounted sidebar controller, **not** the entire shell/production process or pane. Full real-shell E2E and Host-to-pane linkage are required for shell-pane acceptance.
