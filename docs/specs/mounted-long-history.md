# Mounted synthetic long-history D (opt-in test only)

Owner: the existing Core AgentHost SessionHost owns canonical event sequence, durable journal, projection, historical revision, and accepted turn; the synthetic adapter owns only backend emission after an accepted command. The Core Catalog owns the actual session reference; Desktop window Host attaches with its existing ticket and provides the production continuous MessagePort RPC to the Shell. The UI store owns only its bounded browsing cursor/window. Neither renderer nor fixture writes the journal or read model.

```text
real Core create factory + trusted Node fixture harness → Catalog/Host accepted create/send
 → adapter emits strictly validated canonical events, serial/bounded producer backpressure
 → SessionHost committed journal → projection/revision → ticketed RPC
 → existing Electron utility Host/preload/public client → actual Shell older/newer/latest controls
 private IPC barriers: pause/release producer ONLY; separate Core ticket: readonly observations
```

Default additionalTrustedHarnesses is empty; Pi remains registered; manifest ID/version must match adapter and duplicates are rejected. No test adapter factory crosses RPC, and no production model credentials, native/phone auth, supervisor, or app profile is touched. Test-profile synthetic harness must not appear in default production session creation. The test child passes a factory to the existing runServerCore factory argument; it does not replace Core authority or business services.

Acceptance: use one real committed Git worktree, actual Core Catalog/Host session and accepted command; observe >=100000 *committed* event sequences and >2000 actual projected rows (not adapter loop counters), no duplicates/gaps. Shell navigates repeatedly via actual controls to earliest and latest, verifies row IDs/cursors/retained bounded window. Hold an older page/anchor, append newer accepted events while producer is paused in controlled phases; finish an early still-pending tool using its accepted turn/tool IDs *after* append. Assert the original older row ID changes status/content and historicalRevision genuinely advances in Core and the visible Shell without jumping to tail. Navigate forward/latest and verify contiguity/no stale resurrection. Observe every barrier from committed Core facts, not sleeps or a forged read model. Use one-use ticket observer solely for reads. Desktop continuous only: phone replayable is out of scope.

Failures/timeouts: fail closed and stop/reap only owned Core/Electron/Model; never rewrite event IDs or retry an uncertain accepted send. Keep network loopback-only, isolated HOME/XDG/userData before imports, opt-in build/view, Node24.14.0/2GiB/one heavy-slot/internal fanout 1. Report A/B/desktop C regressions separately. Synthetic D is not Pi-provider performance, 8h load, physical SSH, native create or packaged-app proof.
