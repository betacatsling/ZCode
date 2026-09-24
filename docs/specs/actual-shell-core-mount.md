# Actual Electron Shell → Core mount acceptance

## Behavior and boundary

A disposable Electron window uses the **production** main Core endpoint resolver, utility Host, preload MessagePort and renderer service connection. The isolated fixture must fail closed for non-loopback Node TCP (including inherited CLI worker) and non-local Electron renderer requests; IPC and localhost fake Model are allowed. An isolated default Core owns Target/Catalog, workspace identity, AgentHost/session journal and Pi worker. The Shell may select a real existing Git workspace, create a Pi session using real hierarchy/Host commands, submit typed input and display its matching final response and measured Model usage. Native creation stays disabled. No renderer business-service object literals, generic unauthenticated Core WebSocket privileges or second Host/Core are allowed.

```text
Git receipt → Core Target/Catalog → Core Host create/admit → Pi SDK worker → local HTTP Model
                                  │       └─ journal/snapshot (only authority)
                       one-use ticketed RPC → window utility Host → MessagePort → preload
                                                                             → renderer Shell view
view detach/reload ──> reattach original Host/session (never resubmit command)
desktop-continuous: live port; phone web-remote-replayable: authorized attachment + replay/gap repair
```

Core owns persisted workspace/session/journal and command admission; main owns window and process lifecycle, window Host owns attachment routing, renderer only draft/cursor/pending overlay. Identity is `workspaceIdentity?.trim() || workspacePath`; filesystem cwd always workspacePath. Reject stale target/generation/lease and duplicate submission at authoritative command boundary, not by hiding a renderer callback. Detach must not terminate owner. Mobile viewport emulation alone cannot certify phone transport. The phone attachment must be paired and authorized, scoped to original Host, revocable, with distinct replayable delivery.

## Test scenarios (staged)

1. **First RED:** one hidden owned Electron window, disposable HOME/XDG/userData before production imports, one actual default Core process and real utility Host, production preload and renderer connection. Assert the UI's create/input/final/usage against Host snapshot and local fake HTTP Model request/usage receipts. The test fails if the real mount/creation is missing; a controlled services fixture is not acceptable. Close/reap all children and verify no unauthorized network/telemetry. Commit the first passing vertical slice before expanding.
2. Two distinct Pi Host IDs with the _same_ existing worktree, identity and generation. Switching/splitting/focus doesn't spawn/stop their owners or invoke native conversation operations from the external pane; legitimate CLI bootstrap is not counted as pane traffic.
3. Block local Model stream at producer, detach only the renderer, prove Host journal advances and owner remains; reload/reattach same ID and recover final content/usage without replaying typed input. Test desktop-continuous independently from authorized phone web-remote-replayable.
4. Seed actual Host journal via documented test-only producer with >100k canonical events; mounted Shell pages repeatedly across >2000 rows to earliest and back to latest under live append and a genuine older-row mutation revision. View is bounded, ranges contiguous, loaded/not-loaded and zero/absent usage stay truthful. Synthetic 100k is not measured 8h load.

The production RemoteServiceAccess exposes methods through an RPC Proxy with a `get` trap, not own keys: `method in proxy` is false even though `typeof proxy.method === 'function'`. Shell's `hasMountedHierarchy` must accept its public service accessor based on callable required methods (still check service objects), then use real server RPC failures/availability for access control; never use `in` as a proxy capability/authentication test. Regression includes the real proxy shape and missing service case.

Desktop's Node bundle must preserve `node:` builtin specifiers (in particular `node:sqlite` from the actual Core/CLI storage route); a bare `sqlite` import cannot be resolved in Electron. Verify fresh Main/Host outputs, not an ignored stale chunk. The test entry is opt-in at build time and never part of the default production bundle.

The joined fixture currently certifies scenarios 1–2 and only the **desktop** part of 3: an active local Model stream advances Core's journal while the browser document is detached, then the same window Host reattaches and the Shell selects the same persisted ID/final/usage without a second request. A navigation away to an inert data document is a real renderer detach, but it is **not** a paired phone transport. Its new-document navigation requires selecting the session in the sidebar after reattachment; do not describe that as automatic same-document reload recovery.

The actual phone attachment remains separately required. Generic Core `/ws` intentionally denies Host/Catalog/hierarchy; a replayable port on its own does not prove phone pairing or authorization. Desktop's existing remote-workspace replayable port is bound to a pre-existing remote logical session and cannot certify a local phone attachment by itself. Require an authorized, revocable attachment scoped to the existing local window Host before claiming the mobile part of scenario 3. Scenario 4 likewise still requires a bounded, documented **Core-owned** journal producer for mounted history (not a replacement renderer snapshot or a write beside a live journal lock); the prior isolated 100k projection/Host tests are not this joined proof.

No packaged binary, Supervisor, SSH, paid provider, Native, live production or multi-hour certification follows from this fixture.
