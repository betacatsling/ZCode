# Mounted load validation (§10.2 / §13.8)

## Scope and authority

This is a **gate runner**, not certification of the current checkout. The only durable session/event authority is the target Host; Project Catalog owns project/workspace references, target WorktreeService owns worktree facts; the mounted Shell/ProjectSidebar/SessionPane owns only focus and drafts. The runner owns disposable fixture paths, schedules and measurements, never business state. Do not launch Desktop/Web with real HOME or userData. The runner requires a caller-supplied production driver module; no detached-tree/Button fixture or in-memory substitute may pass the mounted gate. No paid provider or SSH use.

```text
runner → disposable tiny Git repo → target Git discovery (read-only)
       → production Catalog/Host admission → synthetic Harness events → durable Host journal
       → actual mounted Shell/ProjectSidebar/SessionPane → browser interaction samples
       → owner counters + cleanup/reconnect facts → artifact manifest
```

Each session has unique command/turn identity. Send/admit once; detach only removes subscription. Reconnect queries/replays Host journal by cursor, never resends prompt. Host epoch and session identity fence late events. Desktop continuous and Web remote replayable are distinct delivery modes: record both separately; do not interpret connection interruption as session completion. No timeout-based sync: wait for explicit owner sequence/cursor. Fail if unknown, offline, or gaps are presented as caught-up. Counters come from owner calls, not DOM heuristics. A false observation or missing counter is a failure, not zero.

## Contract / fixture

`scripts/e2e/multi-harness/load/runner.mjs` exports `runLoad({driver, durationMs, eventCount, worktreeCount, sessionCount, expandedCount, reconnectEveryMs, sampleEveryMs, artifactBase, baselinePath, mode})`. Driver is loaded via `--driver <absolute .mjs>`; the runner does not import mutable product internals. A production driver must implement `open({root,repo,worktrees,artifacts,mode})` returning:

- `mount({expandedWorktrees, sessions})`: create 10 distinct **synthetic runtime** sessions across ≥5 expanded workspaces through actual production Catalog/Host and mount the real Shell + ProjectSidebar + SessionPane. Return `{ mountedSurfaces: ['Shell','ProjectSidebar','SessionPane'], owner:'durable-host', delivery:'desktop-continuous'|'web-remote-replayable' }`; do not return this metadata unless independently verified.
- `discover({repo, candidates})`: read-only production target discovery; return stable candidate IDs (including main), no Agent start, no Git mutations. Worktrees passed to mount are the discovered real paths.
- `emit({sessionId, eventId})`: inject one synthetic Harness event into the **real durable Host**; resolve only after committed sequence. No paid Model calls.
- `sample({sessionId})`: perform a real typed-input + session-switch interaction on the mounted page, returning `{typedInputMs, sessionSwitchMs, focusStable, draftStable, selectedStable, worktreesStable}` measured from browser interaction to painted response (not RPC response).
- `detach()` / `reconnect()`: sever and restore client attachment, not Host. `reconnect()` must query the owner journal, return `{replayedWithoutResend:true, caughtUp:true}`.
- `facts()`: return `{durableEvents, backlog, implicitCliStarts, fullHistorySidebarReads, worktreeMutations, childProcesses, acceptedPrompts, focusStable, draftStable, selectedStable, heapBytes, rssBytes}` from instrumented owner + process metrics; all numeric fields finite nonnegative, booleans true. `backlog` is committed minus UI-consumed event sequence, not history row count. Use process memory of Host **and** renderer as separate optional `processes` entries; never present runner heap as product heap.
- `gatewayProbe?()`: optional local Fake Provider **pure ingress→executor→egress** adapter samples in milliseconds; no live Provider traffic. Omit if unavailable and mark unsupported.
- `close()`: explicitly close mounted client and synthetic sessions/children without terminating unrelated processes. Subsequent `facts()` must show zero owned child processes; idle memory samples must be taken after cleanup. Driver must not modify global account/config data.

All hooks must return truthful production instrumentation. No production driver is shipped at this checkpoint; a missing driver fails closed. Driver version + production commit + shell/Host provenance must be placed in `metadata` by `open` for review. Tests use a labeled **contract stub** solely to test runner invariants, never to claim mounted success.

## Gate, evidence and failures

Defaults: ≥50 *real* worktree candidates from a newly initialized disposable tiny Git repo (never this project repo); 10 sessions in ≥5 expanded workspaces; ≥100,000 committed events; ≥8 hours elapsed monotonic clock. Attempts to call `--mode acceptance` with lower minimums fail before any Git/process launch. `--mode smoke` allows smaller duration/events, always reports `smoke` even if all counters pass. Every run creates a fresh temp directory; no cleanup of pre-existing directories. Output `result.json` written even on gate failure with status, reasons, elapsed, counts, event backlog maxima/final, typed/switch p95, time-series heap/RSS (including post-idle/cleanup), process counts, provenance and unsupported checks. Samples must be sufficient (≥20 each for acceptance); no zero-latency defaults. Missing baseline means regression **unmeasured**, never ≤10%. Compare only preserved baseline worktree/commit on same machine and *same config/driver/load*, separately for typed and switch p95; nonmatching baseline is rejected. A proposed +10% budget is not a certified threshold before real baseline approval. Separate Fake Provider adapter-only latency from live Provider compatibility (not measured here).

During setup: derive isolated HOME/XDG and Desktop userData and Web browser profile **inside the new artifact root**, prove realpaths are descendants before any driver launch; pass the paths into `open`; driver must attest the effective app/browser paths and must reject otherwise. No regular HOME, credentials, inherited provider keys, production server endpoints, SSH, or real accounts may be used. Driver must refuse to run if mount/runtime hooks are unavailable. Artifacts must not contain credentials, prompts or endpoint URLs.

Short contract tests: `mise exec -- node scripts/mise-run.mjs pnpm exec node --test scripts/e2e/multi-harness/load/*.test.mjs` (if pnpm dependencies absent, `mise exec -- node --test ...` uses only Node/Git). Production gate command after mounted integration is stable and driver is implemented:

```sh
# In MAIN, from the integration checkout; run as a background job managed by MAIN, not a child agent.
# bg_run(command="mise exec -- node scripts/mise-run.mjs pnpm exec node scripts/e2e/multi-harness/load/runner.mjs --driver /ABSOLUTE/ISOLATED/production-driver.mjs --mode acceptance --artifact-base /ABSOLUTE/DISPOSABLE/ARTIFACTS --baseline /ABSOLUTE/BASELINE/result.json", timeout=32400)
```

Driver and baseline are required for production certification; the above is an invocation *template*, not a claim those files exist. Reserve an isolated hardware window; run preserved baseline and candidate serially under identical 50/10/5/100000/8h settings, then inspect both result.json files. Do not run a second broad build/browser load concurrently. Unavailable mounted driver, absent comparable baseline, or missing Desktop/Web isolation proof are explicit product gates, not skips declared green.
