# protocol-recovery-writer — same-protocol recovery candidate

Source commit `f8b70c472210ec8c8fddecefaba778f704e9d91e` (parent `f2c6259dadae41df3e6737b5ddf97294894f645e`). Preserved five WIP files, added exclusive-profile normalization and separate Codex ownership/Host races within adapter/tests/spec ownership only. No review verdict for this new SHA yet; prior `.tmp/REVIEW-protocol-final-2.md` FAIL applies to the prior WIP, not to this candidate. No paid Provider calls, actual credentials, global config, push, subdelegation or other worktree writes.

## Ownership / event ordering

```text
V2 Host command journal → accepted send → adapter durable native ownership → Codex child
                                           ├─ per-turn lease (Gateway Model captured)
child native ID + start ACK → adapter turn-ID fence → Host event journal / receipt
child death / byte overflow before ACK → unknown → single revoke + owned child close
new Host/adapter instance → exact provenance → original native thread/resume → next send
```

Desktop continuous and mobile replayable read the same Host journal; neither is an adapter queue. The actual Git/Target verified negative create matrix + stale epoch cancel and positive pinned CLI canonical subdirectory test are unchanged; independent reopen still sends on the original thread with exactly one additional synthetic upstream HTTP request and prior tool context. No real Provider or native Claude production Gateway qualification is claimed.

## New evidence and gates (pinned Node 24.14.0, global heavy-slot, 2 GiB old-space, concurrency 1)

- Exclusive `mkdir` EEXIST now becomes ownership-unknown without overwriting existing record/marker. Negative `starting`, missing marker and missing whole profile cases each execute independently after a completed first turn. Draft with session-created event remains attachable through original binding, not replacement create.
- V2 Host tests: accepted child death before `turn/start` ACK, fragmented unterminated stdout-tail overflow, and aggregate pre-ACK early-event overflow. Each has persisted `execution-unknown` receipt after close/reopen, one revoke, owned fake-child exit and no duplicate/retry replay. Fake child proof, not PID-only reaping claim.
- Actual pinned Codex CLI 0.156.1 → V2 Host → Gateway → SDK → local synthetic Responses upstream: bounded stdout interception holds genuine next `turn/start` ACK after independent reopen. Verbatim old item, text, *command tool*, token usage and completion bytes are delivered first. Host event set remains unchanged, accepted send remains unsettled, no new lease revoked. Releasing ACK yields one terminal and one new synthetic upstream effect. Scoped frame inventory has explicit turn IDs for item/text/tool/usage/approval and nested completed turn ID; unscoped frames are omitted, not complete usage accounting. This is controlled stdout proxy and fake upstream, not live native Provider proof.
- Opt-in six-file suite (`ZCODE_CODEX_ADAPTER_JOIN=1 pnpm exec tsx --test --test-concurrency=1`): **49 pass / 1 optional skip / 0 fail**. Services `pnpm exec tsc -b packages/services`: PASS. Mandatory root `pnpm typecheck`: FAIL TS2322 at unrelated `packages/ui/src/app-shell/WorkspaceShellLayout.tsx:1693` (`MountedSessionOwner` native variant lacks `historyOnly`); no UI edit. The separately reviewed `4719b11` root build-only dependency is available but not joined here; no root pass claimed. `pnpm lint --threads=1`: PASS 0 errors/76 warnings. Own changed-file `oxfmt --check --threads=1`: PASS. `pnpm architecture:check --changed`: 0 baseline/new. `git diff --check`: clean.

Remaining whole-Goal limits: unsupported pinned native Claude beta at production Gateway, real Provider/live and complete usage attribution, production Host user-facing Model switching, UI root typecheck and broader desktop/mobile runtime qualification. Fresh independent reviewer must assess this new SHA; this writer does not self-certify `PROTOCOL_FINAL_GATE`.
