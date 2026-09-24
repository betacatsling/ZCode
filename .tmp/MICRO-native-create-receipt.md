# native-create-receipt-1 — CLI original-ID primitive

## Gate (scoped proof vs aggregate resource limit)

`NATIVE_CREATE_RECEIPT_GATE: FAIL` for aggregate acceptance: mandatory root `pnpm typecheck` ran once under the shared 2GiB cap and exited 134 (`FATAL ERROR: Ineffective mark-compacts near heap limit`). Do not claim it passed; no cap increase or unchanged retry. CLI dependency builds, adapters/bootstrap scoped typechecks, the receipt crash/stdio regressions, architecture and root lint **passed**. Root typecheck must run in a separately reviewed resource budget before aggregate certification. Do not enable Core native-create admission based on this note alone. No paid/live calls or other-worktree edits.

## Public contract / owner

- CLI `CommandInbox` serializes the global create command. Its native bridge materializes the original CLI session ID; CLI `SqliteSessionStore.commitNativeCreateReceipt({commandId,workspaceScope,intentFingerprint,hasFirstInput?,session})` atomically persists that same session row and an immutable receipt (`pending`) before applying config, sending first input, or ACK. `completeNativeCreateReceipt(commandId, originalSessionId)` marks it `completed` after handler admission. Raw payload is not stored in the receipt: SHA-256 fingerprints canonical parsed payload, including workspace, config, model, first input, MCP flags and attachments; transport client ID, timestamp and subscription delivery excluded. Same ID/different intent or workspace rejects before effects. SQLite unique command ID and session ID ensure exactly one original.
- `SessionStorePort.getNativeCreateReceipt(commandId)` is a typed fact read. V4 global `commands/query` with `sessionId:null` returns original ID for completed retry; `pending` and unpromoted or interrupted input return original ID **with failed/pending**, never a false input-completed ACK. A live admitted input stays admitted after a query; only actual cold-start/session recovery may discard. In-flight conflicts are rejected even before SQLite commit. Maintenance freeze still permits duplicate/query.
- `ReadonlyNativeSessionMetadataView(resolvedAbsoluteDbPath).readCreateReceipt(commandId, workspaceScope)` returns `{commandId,originalSessionId,workspaceScope,intentFingerprint,hasFirstInput,status:'completed',nativeDatabasePath}` for supported schema, matching real session scope, and (if firstInput) verified promoted input row. Missing DB, unsupported schema, pending, ambiguous input or wrong workspace is `undefined`. It does not spawn CLI, migrate, read transcript, or write. Core owns Target/binding/generation validation and a **separate** verified native mapping; no Core allocator, UI/Model/NodeCore change or fabricated legacy-backup mapping.

```
caller(desktop continuous | mobile replayable)
    -> CLI CommandInbox key gate -> materialize original ID
    -> SQLite BEGIN IMMEDIATE -> session + receipt(pending) -> COMMIT
    -> config / optional firstInput admission -> receipt(completed) -> ACK
    -> retry/query -> immutable receipt + input status (read only)
    -> absent worker -> READONLY metadata + explicit DB/scope; Core verifies Target separately
```

Post-COMMIT/pre-completion failure intentionally leaves a pending original ID: caller must not re-run input or turn this into a writable mapping. Runtime draft stays deferred (no user turn); original session row now exists in SQLite by design. Legacy fork/edit/side-session ownership unchanged. Ordinary admission errors before commit dispose the uncommitted live record. Existing config best-effort policy is unchanged (requested config not guaranteed if its application fails).

## Real evidence

- Existing CLI private fake-Registry stdio child (`native-bootstrap-subprocess.test.ts` child mode), disposable HOME/XDG/SQLite and local fake HTTP server: two simultaneous duplicates return the same original ID; SIGKILL + real worker restart + global query + retry via different desktop/mobile client IDs return the original; wrong model and wrong workspace rejected; exactly one SQLite session for draft and zero HTTP requests. First-input create uses the same real stdio path, live query does not discard accepted ledger, SIGKILL/restart retry never makes a second session or an extra Model request. No `--live` call.
- Real SQLite injected faults before transaction, after inserting session, after receipt insert (both roll back), and after COMMIT before ACK (reopen retains one original `pending` fact); exact-count assertions. Read-only wrong scope, pending, missing and unsupported DB checks. `13/13` tests (10 new + 3 relevant existing), Node/tsx `--test-concurrency=1` through global heavy slot.
- `pnpm -r --workspace-concurrency=1 --filter '@zcode/bootstrap^...' --filter '@zcode/bootstrap' run build` passed; adapters/bootstrap `typecheck` passed; `pnpm architecture:check --changed` 0 violations; `pnpm lint --threads=1` root passed 0 errors / 76 existing warnings; targeted CLI lint custom config with existing max-lines baseline disabled passed 0 errors / 7 unrelated warnings. The package lint aliases see zero files because repository root `.oxlintrc.json` ignores `apps/zcode-cli`; they returned 1 and are NOT counted as passed.
- Root `pnpm typecheck` failed at 2GiB OOM. No retry or heap bypass. Review limitation: after-COMMIT/pre-ACK process-level SIGKILL is represented by real SQLite fault/reopen plus independent real stdio SIGKILL after ACK; process-kill at the exact instruction boundary is not proven. The public primitive should not be advertised as aggregate-certified before that stronger test and root typecheck have been reviewed.

Changed module `zcode-cli` (contracts/bootstrap/adapters), spec `docs/native-create/RECEIPT.md`; no other managed modules changed. Net changes before commit can be inspected with `git diff --stat` and `git show --stat`. Handoff also in `.tmp/interface-handoff.md`.
