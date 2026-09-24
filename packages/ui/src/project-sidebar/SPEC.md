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

Acceptance: full shell with zero-session projects, multiple harness sessions in one worktree, two targets with same path, hidden waiting attention, native original ID, external spec, unknown navigation blocked, create failure preserving draft, main checkout no remove, stale snapshot on disconnect, desktop and mobile. No component-only fixture is production E2E evidence.
