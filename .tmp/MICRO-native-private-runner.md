# MICRO — native-private-runner (owned lane)

Base: current public V2 `6456283`; staged prior native fixture commit `e55c29e` (3dbb6c equivalent); Core ordering fix `b03abc0`. This lane does not own Services/GUI/HostV2 or protocol-v2-closure. **No real provider/paid request was made in this wave.** Independent MAIN review and execution remain required; neither fake proof nor this report certifies production GUI/SSH/live routes.

## Delivered source and ownership

- Core `MessageHistory` is sole source of ordered entries; request projection now preserves attachment/reminder source order around any `developer` boundaries, both `useMidConversationSystem` modes, multiple developers; histories without developers keep existing bubbling. Interleaved compaction remains fail-closed (not falsely reported as successful compaction).
- Trusted Node-only `runZCodeProtocolAgent` injection borrows the *existing* `ProviderRegistryService`, `AiSdkModelAdapter`, `FileSystemPort`, `ExecutionPort`, and private logger factory. No serialized `ModelRequest` callback, account overlay secret, replacement Model executor, alternate HTTP client, UI/ServicesNode/CoreSupervisor change. Product bootstrap without injection retains default behavior.
- `scripts/native-private-runner.mjs` defaults to fake; explicit `--live` accepts **only** `stepfun/step-3.5-flash` or `axonhub/deepseek-v4-flash`. Parent makes an isolated worktree/DB/HOME; child isolates HOME/XDG/ZCODE_DATA before product imports, reads selected existing local Pi model config in private Node memory, builds a real registry, configures SDK `maxAttempts=1`. Proxy routing (which could bypass injected fetch) and automatic redirects are disabled for this private run. Trusted transport observes and reserves ≤12 SDK HTTP requests *before I/O*, independently of Model invocation count; wrong API route/model/budget fails closed. Non-2xx echo and network cause sanitized before SDK/V4 persistence; private logger is disabled to avoid logging `baseURL` from status context.
- Private `FileSystemPort`/`ExecutionPort` delegates only authorized fixture Read/Write/Bash to existing adapters; each turn's test phase is ACKed over IPC **before** V4 input. Exact permission frame tool input is separately checked; first valid Write denied, second valid Write allowed. Unknown input/cwd/extra command/scope denied. Bash command exactly `node verify.cjs` at isolated cwd. No user profile write; child execution env exposes only PATH and disposable HOME. External input file changes only after turn 2's matching terminal.
- V4 evidence uses actual conversation topic/session, turnHeader `sourceCommandId` + `completedSuccess` and finalized assistantText on the matching `turnId`; never old control phase, ACK, old terminal, tool-result text or arbitrary nonce. Retained live summary contains pseudonymous session, command IDs/ACK/start/terminal order, allowlisted tool/action kinds, effects, HTTP vs Model counts, usage `present`/`absent` (no fabricated zeros), child exit/stderr byte count and cleanup. Raw endpoint/header/key/request/transcript/error cause never printed by runner. Child stop requested by ≤230s and force-killed after 3s during cleanup; 240s success deadline includes bounded artifact scan/cleanup (deadline overrun cannot report success; wall time of filesystem cleanup is not strictly capped). Frame/queue/row/scan memory bounds fail closed.

```text
V4 input → CLI CommandInbox/runtime (owner) → existing Model + scoped I/O adapters
         → SDK HTTP observer (identity/path/budget before fetch) → approved provider
fake/live child → V4 row commandId/turnId → parent phase fence → next input/external edit
```

## Commands and actual results (all heavy work via shared 2GiB slot, serial)

- Offline root frozen install: pass; attempted nested CLI install failed (`@zcode/model-option-map@workspace:*` not found in nested workspace; nested lockfile stale). Reinstalled root frozen to restore correct zod3 links. No lockfile or package manifest changed.
- `pnpm -r --workspace-concurrency=1 --filter '@zcode/bootstrap...' build` **pass**; scoped `typecheck` **pass** after final source edits.
- `node scripts/native-matrix.mjs` **15/15 pass**: real fake-upstream Model/Registry/native V4 child, 10 fake HTTP requests matched by separate child transport observer, 3 matching terminals, denied/allowed Write, exact Bash effect, changed file fresh Read and final assistant answer, disposable artifact scan **10 files pass**; negative ACK/stale terminal, wrong permission/cwd, wrong route/model/budget, redirect and fake HTTP error echo covered. No provider usage claimed.
- `node scripts/native-private-runner.mjs --fake` **pass**, output `{"mode":"fake","scenarioPassed":true,"fakeHttpAttempts":10,"privateArtifactScan":true,"paidCalls":0}`; `--help` works without credential load; invalid `--live other/model` exits 2 before credential load.
- Root `pnpm lint --threads=1`: **pass, 0 errors / 76 existing warnings**; changed CLI source oxlint with explicit `--threads=1`: **0 errors/0 warnings**; `pnpm architecture:check --changed` **0 violations**; `git diff --check` pass.
- Root `pnpm typecheck`: **failed**, preexisting Codex V1 `HarnessAdapter` create/attach incompatible with public V2, then Node 2GiB OOM (earlier run also saw missing CLI dist, subsequently built). Did not raise heap or rerun unchanged OOM; this is **not** a root pass. `pnpm --dir apps/zcode-cli typecheck` and `lint` direct aliases both failed `turbo: command not found` in this nested workspace install; equivalent root-scoped build/typecheck succeeded, changed source lint succeeded. Recursive scoped lint failed on ignored nested dynamic-workflow-runtime files under root oxlint config, not silently counted as passed.

## Exact use (MAIN only for paid routes after review)

```sh
# default fake / no credential read / no paid requests
python3 /Users/ykzheng/Desktop/Projects/Zcode/.tmp/multi-harness-5be7ed74/heavy-slot.py mise exec -- node scripts/native-private-runner.mjs --fake
# EXPLICIT LIVE: MAIN selects exactly one approved route per invocation; DO NOT run both automatically
python3 /Users/ykzheng/Desktop/Projects/Zcode/.tmp/multi-harness-5be7ed74/heavy-slot.py mise exec -- node scripts/native-private-runner.mjs --live axonhub/deepseek-v4-flash
# alternatively: --live stepfun/step-3.5-flash
```

Remaining acceptance (not passed/not asserted): MAIN independent review of actual selected local API/baseURL and all I/O scope edges, then bounded opt-in one-route-at-a-time live native run, inspect actual 3-turn effects and redacted outcome/cleanup. Fake sentinel scan does **not** establish a real-key scan (`realCredentialArtifactScan: not-performed`); real provider usage/route counts and any real-provider prompt/tool compliance are unobserved. CLI default profile and desktop/mobile product/GUI/SSH/8h matrix are outside this lane. Root V2 Codex typecheck owned by protocol-v2-closure and 2GiB root OOM remain blockers; no bypass or false certification.
