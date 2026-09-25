# Luna checkpoint — `luna-sprint-supervisor`

Model: fresh `openai-codex/gpt-6-luna`, thinking=max. Scope excludes PHONE END-TO-END. MAIN remains planner/acceptor; this is a bounded source/evidence handoff, not whole-refactor acceptance.

## Owned checkout and result

- CWD: `/Users/ykzheng/Desktop/Projects/Zcode/.worktrees/multi-harness-supervisor-real-process`
- Branch: `goal/5be7ed74-supervisor-real-process`
- Starting HEAD: `1f0037ee93a10a1789fc535a693a78baf17b4263`
- Final tested source SHA256: `packages/zcode-server-cli/src/supervisor/supervisorRealProcessRelease.test.ts` = `12cca3b9937dd4e3615b089efd14ef8b00d95db0126e6a59cbd5561b079312b8`; spec = `c6e9aae79d156e9c4bbab6db42f3ae4d759402b051d914bade675c6c4c4cc8a2`; combined worktree diff = `8dbf32f0371d1112d81abc8ac49abad48e4eda7a353b86c01a679403932094e1`.
- Source changes are limited to `packages/zcode-server-cli/src/supervisor/SPEC.md` and `packages/zcode-server-cli/src/supervisor/supervisorRealProcessRelease.test.ts`. No Supervisor implementation change was required: existing source already preserves uncertainty on rollback release-ACK loss; the missing actual-process regression was added. Corrected a stale WIP assertion so the separate positively acknowledged rollback case expects `ready`.

## Actual evidence

Node v24.14.0; exact current-source test command ran through the shared absolute heavy-slot with 2GiB Node old-space, test concurrency 1. `.tmp/luna-supervisor-rollback-ack-final-test.log`: **1/1 pass, 158.1s**. Test is the existing real installer/staged-release fixture, not mock-only. It stages/installs two local source-paired archives, launches the installed Node/Core/Agent, and exercises the production Supervisor control path. A and B use distinct SHA-checked archives and synthetic labels but identical executable source bytes; not distinct-version compatibility or publisher proof.

The new rollback-open ACK-loss case:
1. Actual installed current B reaches READY; update candidate A is held, deliberately has only its boot-fence declaration removed, fails before READY and is reaped (exit 1).
2. Supervisor restores B and launches actual B as held rollback generation 3. Transport observer suppresses only the real `maintenance` ACK carrying the outbound request/lease ID after the Core effect.
3. Verified `stop-failed`, generation/PID 3, old B process reaped, failed candidate reaped, rollback Core still live; current pointer is previous B, pending absent, update transaction absent, data-root lock active.
4. A fresh `maintenance-begin` and exact matching release sent to that same rollback Core succeeds with native/external zero census, proving its admission is open despite the lost Supervisor ACK. A subsequent ordinary update with a new pending candidate is rejected and does not launch a fourth Core or change current/pending/lock.
5. Only explicit fixture cleanup stops/reaps that owned rollback child; lock/socket close and disposable `/tmp/sr-*` profile removal are asserted.

The same run also passed existing actual candidate post-open ACK-loss, pre-open candidate failure + successful held rollback, default installed CLI A→B update, and clean installed-child environment checks. These are local source/mechanism proofs only.

Logs/checks:
- `.tmp/luna-supervisor-rollback-ack-final-identity.log`
- `.tmp/luna-supervisor-rollback-ack-final-test.log`
- `.tmp/luna-supervisor-typecheck.log`: `pnpm typecheck`, 11-project closure, exit 0 (pinned private pnpm parent and Node v24.14.0)
- `.tmp/luna-supervisor-lint.log`: `pnpm lint --threads=1`, exit 0, 0 errors / 76 warnings
- `.tmp/luna-supervisor-architecture.log`: `pnpm architecture:check --changed`, 0 violations
- `.tmp/luna-supervisor-format.log`: changed spec/test pass `oxfmt --check --threads=1`
- `git diff --check`: clean
- Full installed fixture logs show both owned `/tmp/sr-*` profiles removed and all listed Core PIDs terminal; no owned test/heavy process remained at cleanup.

## Still open — do not claim PASS

- **Not implemented/qualified this sprint:** real accepted native/Host `running`, `waiting` approval/question, and uncertain accepted run after fault, with non-force refusal before stop/spawn/pointer mutation. No fake census is promoted as real activity. This remains the principal Supervisor gap.
- Core preconstructor/autonomous ingress fence remains an independent owner gate; constructor-held fixture evidence is not whole-Core safety proof.
- Local source selection and identical-byte A/B archives are not publisher trust, package/platform qualification or distinct-version compatibility. No SSH/macOS persistence, production-native, live provider, matched 8h load, phone E2E, or full P0–P6/§13 acceptance.
- No claimed queued RED. No new implementation fix was necessary for the rollback-open uncertainty path; the new real-process regression passed on existing behavior.

Latest concise observer report and interface update are also in `.tmp/MICRO-supervisor-real-process.md` and `.tmp/interface-handoff.md`.
