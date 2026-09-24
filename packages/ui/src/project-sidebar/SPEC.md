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

When a prior workbench binding has no current proof (e.g. renderer restart), it is never classified as native merely from its ID or path. The UI must obtain a fresh hierarchy resolution before restoring execution. Only renderer-local navigation proofs are cached while mounted; the Catalog and Host remain authoritative. Focus/split of an unproven binding must not call native navigation; focus of a proven external binding selects that owner's Host view and never sends its ID to native. A shell-selected external binding must be the active workbench binding (including split placement), not a stale native activeTaskId. A newer verified owner for the same session ID and attachment replaces an older renderer proof even if the Catalog workspace record was rebuilt; a late response for a different attachment cannot displace the current selection. Acceptance: native plus two Pi siblings in a workspace, late owner resolution, focus/draft persistence, desktop/mobile rendering, unknown no native RPC, and reopen without create.

## Current integration gates

The shell mounts the tree only if both authoritative services are present. Until the session-pane owner wires `MountedSessionOwner` through split-pane bindings to `SessionPane`, shell navigation for external owners is explicitly blocked: **never pass an external ID into the native task store**. The mounted hook consumes the optional trusted removal-preview port and fails closed if the production Host does not provide it; the target must recheck at commit. A local closed tab with a nonempty identity cannot be reopened through the legacy navigation helper without a target-verified local attachment classification; the shell fails closed rather than creating a fake remote or local tab. The mounted hook reads target-scoped `listCreateOptions(workspaceId)` from the hierarchy Host: it supplies only certified bindings sourced from its Model selection catalog and harness capability checks. No synthesized harness-managed fallback is offered. Unavailable/experimental reasons remain visible through `listHarnesses`. A missing/failed options read keeps creation unavailable, not silently downgraded. The target-scoped response is checked against the workspace ID and generation before display and again at create. Options and Harness availability/reasons are indexed per workspace rather than intersected across targets: a selection certified for target A must not disappear merely because target B cannot offer it, nor be displayed in B. A supported Harness in one workspace cannot conceal an unsupported/experimental reason in another. If any options request fails, that workspace shows no choices while other workspaces remain usable. A failed snapshot refresh retains stale read-only rows but blocks create/remove commands until a fresh snapshot confirms generation. During refresh, clear prior options before publishing the new snapshot; never present options for a changed generation. The creation dialog uses the selected workspace's options only. The Host remains final authority. Model selection retains provider/model/reasoning options without a string roundtrip. Removal preview comes from the hierarchy target authority; catalog removal is only sent after an allowed preview and the target must recheck at commit. These are not accepted production completion.

Acceptance: full shell with zero-session projects, multiple harness sessions in one worktree, two targets with same path, hidden waiting attention, native original ID, external spec, unknown navigation blocked, create failure preserving draft, main checkout no remove, stale snapshot on disconnect, desktop and mobile. Controlled-service fixture validates only the mounted sidebar controller, **not** the entire shell/production process or pane. Full real-shell E2E and Host-to-pane linkage remain integration gates.

# Sidebar removal confirmation

The server resolves the target and original generation for preview. A loading/failed/unknown/unsafe preview cannot enable confirmation. Activity counts must be finite nonnegative safe integers and zero; malformed activity cannot authorize removal even if a malformed preview claims `safe`. Show dirty, untracked, submodules, locks, main, unknown and live activity, and warn of external-process races even for a safe preview. Clicking confirm invokes only the existing removal command with original generation; the host freezes and rechecks. Keep the dialog open with the error when removal rejects. Closing/reopening discards stale preview. The sidebar never treats a client path, cached summary, or preview as permission to remove.

## Create intent ordering

```text
workspace target + generation -> Host listCreateOptions -> UI draft selection
UI create intent (stable commandId for exact input) -> Host admission/receipt -> catalog refresh -> navigate
                                      rejection/unknown -> dialog stays open; same intent retries same ID
UI remove -> Host preview(workspace,generation) -> operator confirmation -> Catalog remove -> target recheck
```

The hierarchy Host owns capabilities/receipts, Model registry owns model facts, target owns worktree identity and preview, and UI owns only draft/command ID until acknowledgement. A changed input or generation is a new intent; a successful Host receipt must not be redispatched merely because subsequent refresh/navigation fails. An unknown outcome is retried only by identical command ID, never a fresh create. No UI-local session or worktree is fabricated. Browser fixture acceptance: host-managed Pi/Codex selection retains reasoning, rejected create keeps dialog and command ID, removal rejection keeps dialog, unknown target/gen fails closed.

## Product closure navigation/reload (2026-09-24)
The shell owns only the current navigation intent (monotonic request version, scope and generation). The hierarchy owns owner facts. Every selection invalidates previous lookups *synchronously*, including later failure; unmount or workspace/endpoint switch invalidates them. A stale success/failure cannot alter selection or error. Target/workspace/generation are compared to the original Catalog row; native proof retains original ID and historyOnly. Restore stores only routing keys and never restores a service fact: query hierarchy for the same session, then subscribe; unavailable/missing/stale yields a read-only unresolved view, never implicit create, send or native fallback. External pane owns only its draft/command marker while Host owns accepted turns; neither provider nor data layer for external pane subscribes to native.

```text
click/reload → shell intent(version,scope,session) → hierarchy.resolveOwner
  later intent/workspace switch ── increments version ── stale completion discarded
  current proof → shell selected pane → Host-only external OR original native (history-only read)
  missing/offline → unresolved read-only; no native transport and no create
  desktop continuous ─ Host sequence ─┐
  mobile replayable ─ snapshot/gap repair ┴─ same owner; no accepted-send replay
```

Old `rows/range` results may merge only when epoch, cursor, projection revision and subscription generation still match; a duplicate page does not erase new revisions or resurrect removed rows. Display absent usage as unknown, measured zero as zero; do not infer missing metadata. Removal uses canonical object preview; stale generation and unknown risks fail closed. Create choices are target/generation facts, never generated by UI. E2E: out-of-order first/second navigation including first rejection and workspace switch (desktop/mobile); two external panes, zero native traffic; reload same owner and offline unresolved; older page concurrent delta and duplicate; create/removal failures preserve intent and risk display.

Split-pane reload has a second local binding surface (`paneLayoutPersistence`). For every restored scoped leaf without an in-memory owner, the workbench resolves the Catalog workspace by unique `(path, identity)` plus trusted `resolveWorkspace(targetId, remoteSessionId)` and `resolveOwner` before clearing `restoredUnvalidated` and attaching either transport. Missing/ambiguous/offline/mismatched generation stays unresolved and must never subscribe native. Primary reload bookmark stores both native original ID and external Host ID with target/workspace/identity/remote keys; native `historyOnly` remains read-only and external generation is checked against Catalog. A draft intent clears the bookmark. Controlled full-shell desktop/mobile tests must include restored split, external reload, native original ID reload and offline restore; they do not certify actual Core process or Host writer.
