# claude-header-control — negative pinned native wire result

## Own commits / owned files
- `c65e53b56f33a1b606cc8deb64011e639dabe5ad` — early typed observation interface (`.tmp/interface-handoff.md`) and updated transport spec (`docs/agent-host/CLAUDE-TRANSPORT.md`).
- `ed36619f06e2104184c350e37ceb8e03039a9714` — disposable native fake-endpoint fixture/test and final spec/interface updates: `packages/services/test/claudeNativeHeaderControl.test.ts`, `packages/services/test/fixtures/probeClaudeNativeHeaders.mjs`.
- This report is committed separately; no product/Model/Gateway/profile files changed. Relative to base `12d86b6`: 4 files, +266 lines before this report.

## Verified boundary and result
- Official <https://code.claude.com/docs/en/env-vars> checked 2026-09-24: `ANTHROPIC_CUSTOM_HEADERS` adds headers (>=2.1.227), not a documented replacement/deletion mechanism. `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` documents stripping beta/tool schema and disabling MCP tool search. Pinned bundled `sdk.mjs` (0.3.263) parses custom env into default headers; `buildHeaders` merges request headers *after* defaults. Static precedence cannot certify native wire.
- A real bundled CLI 2.1.263 started under fresh temp HOME/config and loopback fake Messages endpoint, no Provider or paid call. For unset, distinct custom header, and `ANTHROPIC_CUSTOM_HEADERS='anthropic-beta: '`, **each** native `POST /v1/messages?beta=true` has `claude-code-20250219`, `effort-2025-11-24`, `interleaved-thinking-2025-05-14` in its raw `anthropic-beta`. Distinct header `x-zcode-fixture-probe: on` arrives only in marker case. Each emitted exactly one request, native init version 2.1.263 and success; body thinking disabled, no `context_management` or deferred/eager tool schemas. This is not a claim beta flags are semantic no-ops, nor a complete proof all disabled features are absent.
- **Stop condition reached:** explicit empty native custom header did not suppress beta. Gateway `unsupported_beta` remains. No two-turn Gateway+Model fake-upstream deny/allow/cancel integration trial: its native zero-beta prerequisite failed. No patching SDK/CLI, Gateway stripping, passthrough or Model changes. No repeated unchanged probes needed.

## Executed checks
- `node scripts/check-workspace-freshness.mjs`: baseline fresh, ahead 52/behind 0.
- `mise exec -- node --test packages/services/test/claudeNativeHeaderControl.test.ts`: pass 1/1 (final run ~2.9s); one prior transient child timeout at 30s, rerun passed; increased isolated child safety timeout to 60s.
- `mise exec -- node scripts/mise-run.mjs pnpm architecture:check --changed`: OK, 0 violations; services module context read (unmanaged); owners: native SDK child constructs HTTP; fake endpoint only observes; no mutable product state or replay/event sequencing.
- `mise exec -- node scripts/mise-run.mjs pnpm exec oxfmt --check <three owned spec/test files>`: pass. Root `pnpm fmt:check`: fails 91 existing/unformatted files on initial run (including owned files, then formatted owned files); no repository-wide formatting performed.
- `mise exec -- node scripts/mise-run.mjs pnpm lint`: exit 0, 70 warnings elsewhere (0 errors).
- `mise exec -- node scripts/mise-run.mjs pnpm typecheck`: **not passing**; unresolved `@zcode/adapters/*` and `@zcode/contracts` across preexisting service sources plus missing `admission` wiring at `packages/services/src/node.ts:2683`; process timed out at 240s after displaying these failures. None in this lane's files.

## Blocker / next interface
Native zero-beta trace and supported removal control are absent for this pinned version; production Claude Messages profile remains unsupported. Reconsider only after a documented native control and measured zero-beta request with disabled features confirmed, then actual real Gateway/Model fake-upstream two-turn deny/allow/cancel. No other micro-wave lane is needed to close this negative result.
