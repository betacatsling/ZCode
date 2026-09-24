# claude-repair completion

Own commits: `b44b7ea785df079e2ebfa70b6c18e1617cb86673` (spec + early interface), `308cb49` (handoff SHA), `37cefa244aa8f67c338e0b9a6d9e4b383c5ba4b5` (implementation/tests). Base `ffc9564`. No cherry-picks, pushes, paid calls, global config, user state or other worktree edits.

Files: `docs/agent-host/CLAUDE-ADAPTER.md`, `packages/services/src/agent-adapters/claude-code/{claudeHarnessAdapter,claudeTurnLifecycle,contract}.ts`, `packages/services/test/agentHostClaudeAdapter.test.ts`, `.tmp/interface-handoff.md`.

Owner/event order: Host admits/persists command; adapter synchronously reserves turn + lease before durable intent await, emits `turn.started` then user `message.finished`, writes exclusive inflight intent, checks owner, starts transport, verifies native result and zero exit, writes committed receipt, emits assistant terminal `message.finished` (same ID as deltas) then success and revokes lease. Shutdown during write revokes once and emits unknown while Host listens; pending send can never spawn after owner removal; late source events and success are fenced. Desktop live and mobile replay read the same Host journal. Unknown receipts never auto-replay native request. Test-only write barrier is not used by production. Native Gateway beta remains unsupported.

Executed:
- `mise exec -- node scripts/mise-run.mjs pnpm exec tsx --test packages/services/test/agentHostClaudeAdapter.test.ts`: 8/8 pass, including real pinned CLI fake endpoint/two turns, denied Edit no effect, SessionHost snapshot and historical replay, controlled deferred inflight shutdown and Host execution-unknown receipt after restart.
- `mise exec -- node scripts/mise-run.mjs pnpm architecture:check --changed`: OK, 0 violations (module `services`, owner adapter); no new cross-module edges.
- `mise exec -- node scripts/mise-run.mjs pnpm exec oxlint packages/services/src/agent-adapters/claude-code/{claudeHarnessAdapter,claudeTurnLifecycle,contract}.ts packages/services/test/agentHostClaudeAdapter.test.ts`: 0 warnings/errors. Changed files format check passed; diff check clean.
- Root `pnpm lint`: exit 0, 70 existing warnings, 0 errors.
- Root `pnpm typecheck`: exit 2, pre-existing/unowned `@zcode/contracts` / `@zcode/adapters/model` missing module output, `anthropicMessages.ts` cacheControl shape, and `services/src/node.ts` missing admission injection. No Claude-specific TS diagnostic. Did not edit other owners to mask failure.

Net implementation diff: 4 files, +458/-94 (new private lifecycle helper 93 lines); spec/handoff committed separately. Remaining dependency: owner of shared build artifacts and service boot must restore root typecheck; production Claude profile stays blocked until independently certified native Gateway beta wire compatibility. Source mechanics alone are not production support.
