# Pi v2 live verification (local, explicitly gated)

This is a **test-only** evidence lane for `PiHarnessAdapter` schema v2, not product certification. The isolated local `ProviderRegistryService` owns the model configuration; `bindHostModel` captures its selected `AiSdkModelAdapter` executor for each turn, and the adapter owns the native Pi session and approvals. The test reads the pre-existing, explicitly authorized local StepFun configuration in its own process. It does not persist credentials, log requests/responses or endpoints, change global settings, or transfer authentication to a worker or remote target.

```
registry selection → bindHostModel → Pi create → prepareTurn → send
                                                    ↓
        native Pi tools ← model IPC for captured turn executor
                ↓
        write/bash approval → deny or allow before side effects
                ↓
        turn settles → next prepareTurn → follow-up
```

Each run creates a disposable worktree and isolated Pi session/config directories and cleans only those paths. `ZCODE_LIVE_STEPFUN=1` is required for real account-consuming calls; default execution skips. Tests must check denial before write, then read/write/bash on approved calls, file contents on disk, context follow-up, and stop/late approval when reachable. Approval correlates turn, tool call and runtime epoch; absence or stale approval cannot authorize a write. Event diagnostics may expose only kind, count, stage, and metadata key/type shape; never model body, command/prompt, credential, endpoint, or signature values. On opaque metadata/signature incompatibility, stop after the first bounded failed attempt; retain a redacted finding for product repair instead of modifying the bridge in this lane. Native CLI and SSH checks, if feasible, require independent isolation/target-local authorization; neither a local smoke nor a Node version probe proves packaged remote execution.

Run (from root, pinned tools):

```sh
mise exec -- node scripts/mise-run.mjs pnpm exec tsx --test packages/services/test/live/piV2.test.ts
ZCODE_LIVE_STEPFUN=1 mise exec -- node scripts/mise-run.mjs pnpm exec tsx --test packages/services/test/live/piV2.test.ts
```

## Signed-reasoning follow-up (bounded authorized attempts)

With the frozen upstream API type and endpoint fingerprint captured by `captureHostModel`, the second **changed-prompt** StepFun run passed in 27 seconds without force-exit: `modelCalls=8`, three approvals, three finished turns, and successful read/write/bash tools. The first turn denied the proposed write before its side effect; the subsequent approved turn wrote the disposable `output.txt` and verified its contents with bash; the follow-up turn read the result, returned the expected seed value, and stop rejected a late approval. This is one real-Provider local Pi path, **not** a second Provider, packaged worker, Linux SSH, or product/UI certification. Model API/default-endpoint signatures without a configured base URL remain deliberately unsupported (unsigned turns still work). No credential, endpoint, prompt, signed contents, or request body was logged.

The previous isolated real Pi SDK + Registry/AiSdk StepFun run progressed past the previously fatal `reasoning_delta:anthropic:object`: two Model calls, event counts `start=2`, `reasoning_start=2`, `reasoning_delta=39`, `reasoning_end=2`, `tool_call=1`, `finish=2`, `text_delta=30`, with one `tool.started`/`tool.finished`, a `turn.finished`, and **no `session.error`**. The run nevertheless failed at `denied-write`: it reached no `interaction.requested` write approval and did not run the approved write/bash or follow-up stages. This is a real-Provider prompt/tool-behavior limit, not an approval success, and must not be retried unchanged. The next bounded attempt changes only the first turn to request the denied write directly, so that a read-only preface cannot satisfy the prompt without visiting the approval gate; it also captures the actual upstream API/endpoint route via `captureHostModel` before Pi prepares the turn. Diagnostics remain field/type and event-kind/count only. Deterministic pinned Pi SDK signed reasoning → tool → follow-up → session-file restore passed separately, as did the existing Host test after its isolated worker teardown; neither substitutes for this missing live approval path. Root typecheck still requires the target-local `WorkspaceAdmissionPort` composition at `packages/services/src/node.ts:2644`, outside the Pi adapter boundary.

## Earlier observed local/remote result

One bounded local account-consuming v2 run failed at `denied-write`, **before the first approval or any tool execution**: model event counts `start=1`, `reasoning_start=1`, `reasoning_delta=21`, `reasoning_end=1`, `text_start=1`, `text_delta=1`; only metadata shape `reasoning_delta:anthropic:object` was observed (no metadata values captured). Pi event kinds: `turn.started`, `message.finished`, `usage.reported`, `session.error:pi-model-executor-stream`, `turn.finished`. The bridge rejects nonempty provider metadata, and it is not safe to discard opaque content; no unchanged retry was attempted. Denied-file side effect, approved write/bash/read, context follow-up, concurrent real Pi, stop/late approvals remain **unverified** in this real-provider run. The test fails visibly rather than claiming a passed workflow.

Read-only `ssh server1` inventory found a target-local Pi config file with `stepfun` entry, string API type, credential presence and `step-3.5-flash` model match. Neither API value, endpoint nor credential was read into the local process/output; this does **not** prove a compatible credential, installed packaged worker/Node 24 runtime, or remote execution. Previous probe established only an ephemeral Node 24 version and removed it; this lane did not execute a remote model call. Native ZCode CLI's previous help inventory exposed prompt/cwd/resume but no safe isolated ProviderRegistry injection/config selection; no native two-turn test was attempted and global settings were unchanged.

The earlier default gated test skipped (1 skip); its explicitly enabled test failed (1 fail, 0 pass) after one model call. Targeted oxlint and formatting passed; `pnpm lint` passed with 70 existing warnings and changed architecture check had zero violations. Root `pnpm typecheck` failed on three existing v1 `HarnessAdapter` versus v2 Pi `create`/`attach`/`lazyTargetService` mismatches; this test-only lane does not own that Host integration. Actual approved tool/context/late-reply/parallel live gates and packaged SSH remain unrun. Do not promote a synthetic pass or a provider smoke to a complete Pi approval/tool-loop result.
