# codex-control-proof — bounded implementation

## Own commits
- `5ccbcc5` — early typed interface handoff (`.tmp/interface-handoff.md`), base SHA `727b847`.
- `90599bb` — acceptance spec before code (`docs/agent-host/CODEX-ADAPTER.md`).
- `5f521d9` — pinned native Host control proof, adapter lifecycle fix and test.

## Scope and contract
`CodexHarnessAdapter` remains the target-local `HarnessAdapter` with the existing `CodexTurnLeaseIssuer` and exact 0.156.1 trusted manifest. No Gateway, Model, Host, shared schema, UI or production mount changes. Adapter now keeps its `send` promise pending until the native turn is terminal (so SessionHost does not misclassify a live accepted prompt as execution-unknown), emits the accepted user message, and revokes each scoped token before settling the next turn. `codexTurnRuntime.ts` is adapter-private deferred lifecycle state, not another command owner.

Owner/event order: Host accepts + journals command → adapter leases frozen Model/epoch/turn → pinned CLI starts/resumes → canonical user/tool/approval rows → Host journals resolution → native accepts/declines → adapter emits terminal event + revokes token → Host finalizes receipt. Old token cannot authorize a new Model. Desktop continuous/mobile replayable are Host projections over that same journal; the adapter has no second replay owner.

## Executed evidence (isolated private home; fake loopback upstream, no paid calls)
- `ZCODE_CODEX_ADAPTER_JOIN=1 mise exec -- node scripts/mise-run.mjs pnpm exec tsx --test packages/services/test/agentHostCodexNativeControls.test.ts packages/services/test/agentHostCodexAdapter.test.ts packages/services/test/agentHostCodexTransport.test.ts`: **11 pass, 1 opt-in transport smoke skipped, 0 fail**. Actual installed `codex-cli 0.156.1` → adapter → SessionHost → Gateway → OpenAI Responses Model SDK → fake upstream. Host receipt and durable rows, deny without file, allow with actual file, stale epoch rejection, active cancellation with upstream closure/no success, native thread resume retaining context, second selected Model and 401 for old token. Raw fake-child adapter regressions also pass.
- `mise exec -- node scripts/mise-run.mjs pnpm typecheck`: **pass**.
- `mise exec -- node scripts/mise-run.mjs pnpm lint`: **exit 0**, 70 existing warnings, 0 errors.
- `mise exec -- node scripts/mise-run.mjs pnpm architecture:check --changed`: **OK**, 0 new/baseline violations; `git diff --check` clean.
- Initial frozen offline install could not use checkout's stale lockfile; installed with `pnpm install --offline --no-frozen-lockfile` from local cache, restored generated lockfile to original HEAD immediately. No paid/global configuration change.

## Limits / dependencies
Pinned CLI + off-only fake upstream proof, not real Provider certification, not production composition registration, not claim of arbitrary CLI versions/tools. No shared seam blocked this bounded test. An accepted native turn ending with `unknown` is adapter-fenced and cannot silently retry; recovery remains Host-owned. No push, no other worktree edits.
