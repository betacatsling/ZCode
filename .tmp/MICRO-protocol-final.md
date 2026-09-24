# protocol-final-1 scoped handoff (not full product/native Claude certification)

Base 15e5b682. Owned files: services Codex adapter/transport/provenance and tests, Claude SDK-shaped fixture→production transport→V2 Host test, agent-host specs. No CoreNative, Host business/projector, UI, Pi, Gateway or Supervisor changes. No credentials, --live, paid Provider calls, global config, push or other-worktree writes. Offline install + generated CLI prerequisites stayed inside this worktree; pinned Node 24.14.0; all heavy checks serialized via shared slot at 2 GiB, tests concurrency=1, lint/format threads=1.

## Ownership and sequence

```text
Host V2 accepted command/journal/snapshot ──> Codex adapter provenance + per-turn lease
adapter create: new private profile → fsync never-started → Host binding receipt
send: verify provenance/canonical cwd → fsync starting → spawn/thread/start
valid native ID → fsync marker + established → turn/start → matched events → terminal → revoke
reopen: exact V2 binding/spec/cwd + state/marker → thread/resume ONLY
unknown/missing/starting → refuse execution; Host history remains readable; no prompt replay
```

`sequence > 0` is not used as thread-start evidence. A lost whole profile, lost marker after committed history, ambiguous starting record, stale spec/cwd/binding fail closed; draft with session-created event but never native-started can reopen. Test demonstrates established resume using the original pinned CLI, then deletes marker, confirms Host.open refuses and committed Host snapshot still reads. Atomic file replacement and sync before acknowledgment, no prompts/approvals in provenance. Adapter limits pre-ACK pending event+completion aggregate to 1 MiB and count 128; transport limits stdout aggregate input to 1 MiB before split, approvals and pending completion/seen IDs to byte and count limits; overflow reaps child, rejects send/marks unknown. A caught already-finished send no longer revokes token twice.

Actual Git/catalog/Target Host admission matrix refuses foreign target, workspace ID/identity/path/generation/cwd escape before native lease; stale epoch control rejected. The same real Git/Target Host fixture positively dispatches one turn through actual pinned CLI + Gateway + existing Model SDK to local fake Responses upstream: exactly one lease, canonical `sub` cwd and exactly one synthetic upstream request. The additional pinned CLI V2 Host/Gateway fixture checks canonical `sub` cwd for four child launches, approval allow/deny, cancel, resume and read-only reopen. Exact production user-facing Host Model switching remains unproved (Host selection immutable in these fixtures).

Pinned CLI 0.156.1 actual emitted families (before stale reinjection, four turns): explicit params.turnId item/started 9/9, item/completed 9/9, item/agentMessage/delta 3/3, thread/tokenUsage/updated 9/9, command approvals 2/2; turn/completed nested turn.id 4/4. Thread/status/rate-limits unscoped and omitted, not proof of complete usage. Bounded test reinjects verbatim old pinned bytes (item/text/usage) on next live child during approval; asserts old text not projected; pre-ACK old families also have direct fake-process tests, **not** a full real-CLI before-ACK delayed proxy.

Claude production transport `ClaudeCodeTransport.run` consumes injected SDK-shaped init/delta/final/result through V2 Host snapshot/replay; this is a fake-native SDK/Host fixture with overridden unsupported probe, NOT actual CLI Gateway qualification. Separately prior pinned SDK/CLI fake endpoint adapter two-turn and resume tests pass. Pinned CLI beta incompatibility with Messages Gateway remains; no beta stripping/opaque passthrough or production Claude support claim.

## Verification (actual)

- `pnpm exec tsc -b packages/services`: PASS after offline prerequisite dynamic-workflow generated libs/contracts/adapters build. Initial prerequisite-free scoped check failed missing CLI declarations; prerequisite build later passed.
- `pnpm typecheck`: FAIL exit 2: pre-existing unrelated `packages/ui/src/app-shell/WorkspaceShellLayout.tsx:1693` native MountedSessionOwner missing required `historyOnly` for SessionOwner. No UI edits; no OOM in this run.
- `pnpm lint --threads=1`: PASS 0 errors, 76 warnings. Changed-file `oxfmt --check --threads=1`: PASS. `pnpm architecture:check --changed`: 0 new/baseline violations; `git diff --check`: clean.
- Focused 6 files with `ZCODE_CODEX_ADAPTER_JOIN=1`: 43 pass, 1 opt-in skip, 0 fail. Actual pinned Codex/Target tests 2 pass; pinned Claude fake endpoint tests within combined focused suite pass. Real Provider request count 0, paid Model call count 0. Earlier red tests and formatting issue were fixed and rerun, not counted as pass until green.

Still open for MAIN: full before-ACK delayed native proxy, complete usage accounting, native Claude beta acceptance, production Host Model change and root UI typecheck. No reviewer or full product/live qualification implied.
