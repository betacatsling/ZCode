# Isolated live P0/P3 primitive verification (source 1e7c0e24)

This is a test-only evidence record, not GUI/SSH/P4 certification. The target-local `SessionHost` owns journal/command admission; Pi SDK worker owns agent context/tools; host-side `bindHostModel` freezes the requested/effective Registry selection and calls the existing `AiSdkModelAdapter`. Local secrets remain in the invoking Node process, never in worker boot data, traces, repository files or target SSH sessions. No production runtime changes are permitted for this experiment.

Test event order: create disposable worktree and per-session host/worker directories → start isolated registry and bind model → prompt → Pi read → model-selected write (approval pending before write) → explicit allow or deny → test shell (approval pending) → follow-up after first turn idle → terminate → clean only owned temporary artifacts. A denial must leave its target file absent. All real model calls require explicit `ZCODE_LIVE_STEPFUN=1`; ordinary tests remain fake/offline. Print only event kinds, counts, usage and allowed route identifiers, never endpoint, response payload or auth failures verbatim. A failed or incomplete turn is not a pass.

Target probe must not modify existing files/services. Remote credential transfer requires separate authorization; target-local Node 24 and packaged worker are independent prerequisites. Native CLI and Pi/StepFun tests must be distinguished; inability to run one does not imply success for the other.

## Evidence (to be updated after execution)

- Source: `1e7c0e24` (short checkout `1e7c0e2`).
- Baseline prerequisites: pinned mise Node 24.14.0/pnpm 10.33.2; offline frozen ignore-scripts install and `@zcode/adapters...` build succeeded in this worktree.
- SSH alias `server1`: Linux x86_64, system Node v20.19.2, Git 2.25.1; pinned Node 24.14.0 absent at standard user mise path. Remote credential availability not established; no credential copied.
- Local live smoke, model route `stepfun/step-3.5-flash` (Anthropic Messages): existing `ProviderRegistryService` + `bindHostModel` + `AiSdkModelAdapter` returned `finish:stop` twice with nonzero usage (`18/48`, `18/67` input/output tokens); one bounded diagnostic invocation returned `stop:18/41`. These numbers are individual runs, not aggregate Pi usage. Credential and endpoint read within process only; not sent to Pi worker.
- **Real Pi turn FAILED (three bounded invocations):** first tool turn emitted `turn.started,message.finished,usage.reported,session.error:pi-model-executor-stream,turn.finished`, no `interaction.requested`. Isolated disposable `denied.txt`/`output.txt` were removed after test; no write approved or executed. On the third invocation the executor stream event-type-only fixture was `start`, `reasoning_start`, `reasoning_delta` ×17, `reasoning_end`, `text_start`, `text_delta` ×7, `text_end`, `tool_input_start`, `tool_input_delta`, `tool_input_end`, `tool_call`, `finish:tool-calls`. `packages/services/src/agent-adapters/pi/piModelStream.ts` explicitly throws on every `reasoning_*` event (even though binding is `reasoningLevel=off`), before tool-call validation or approval. The SDK emitted a reasoning stream anyway. This is a confirmed first failure, not proof the later tool JSON/usage would pass. Do not discard reasoning or alter production semantics just to green the test; the model bridge owner must decide how to retain/handle this content.
- A subsequent test-runner change fails immediately on `session.error` instead of waiting for approval timeout; no further paid model calls were made after that change. Offline fake Pi SDK tool loop passes; live gate remains disabled by default.
- Official pinned Linux Node 24.14.0 x64 tarball was downloaded under one unique remote `/tmp/zcode-live-node-*` directory, checked against official `SHASUMS256.txt`, executed as an absolute path, and the owned temporary directory removed automatically. System `/usr/bin/node` remains v20.19.2. Git 2.25.1 is installed; remote pnpm 10.32.1 is below pinned 10.33.2. No repository/package/worker was installed on target and no credential moved to target.
- Native CLI help supports `--prompt`, `--cwd`, `--resume` but exposes no isolated ProviderRegistry injection flag. A disposable ZCode two-turn loop with this separately sourced StepFun configuration was not performed; it would need a reviewed isolated CLI config/selection bootstrap rather than modification of everyday account/session state. No GUI facade, packaged Pi worker or SSH task execution/reconnect was exercised. Full P0/P3/P4 certification remains open.

## Reproduction (redacted; worktree root)

```sh
node scripts/check-workspace-freshness.mjs
mise exec -- node scripts/mise-run.mjs pnpm install --offline --frozen-lockfile --ignore-scripts
mise exec -- node scripts/mise-run.mjs pnpm --filter '@zcode/adapters...' build
mise exec -- node scripts/mise-run.mjs pnpm exec tsx --test packages/services/test/live/stepfun.test.ts # skipped, safe by default
# Explicitly authorized local account-consuming invocation only; do not log stdout/errors unredacted:
umask 077; ZCODE_LIVE_STEPFUN=1 mise exec -- node scripts/mise-run.mjs pnpm exec tsx --test packages/services/test/live/stepfun.test.ts > /tmp/zcode-live-stepfun-private.log 2>&1
```

The private local failure log must not be shared unredacted. The checked-in runner emits only route IDs, event type sequence and error class; on failed SDK calls full TAP stacks must still be treated as private. No fixture stores secret values or provider message text.
