# Supervisor generation — writer pass 2 handoff (not independent review)

Base `0fe2e7c3af4d68d04ed037f698ba86a95c413853`, pass-1 commit `2d92842161d4b746323dcd28a9159ee9b5cf2155`; pass-2 source/interface SHA `38ce74fc30719931022a0be24b2a68856a51ac48`. Owned server-CLI files only. Protected Services factory/node Native owner remains read-only; `.tmp/interface-handoff.md` contains exact typed dependency request.

```text
update -> captured old child/generation + Core freeze -> verify after await -> stop/reap
       -> candidate boot-held (factory lease required) -> transaction commit -> exact-token release
failure -> stop unhealthy held candidate -> restore previous pointer -> previous boot-held
       -> if release request may have opened previous Core but ACK lost: stop-failed,
          preserve previous pointer + child + lock; do NOT stop or restart it
old reply/exit/release -> cannot authorize effects on replacement
stale lock after Supervisor death -> refuse auto-reclaim/uninstall; manual process-tree verification
```

Changes: rollback opening ACK loss now retains the live rollback generation; exact-token Core release retries/concurrency idempotent after underlying success only (new lease invalidates old); removed PID-only stale-lock auto-reclaim and stale-as-released shutdown/uninstall shortcuts. Spec first; Chinese bug rationale in source. Conservative stale lock policy sacrifices unattended crash restart until explicit operator recovery; no automatic recovery protocol is claimed.

Genuine RED before implementation: pinned Node24 test `node --import tsx --test --test-concurrency=1` on `server-core/maintenanceAdmission.test.ts` and `supervisor/supervisorGeneration.test.ts` exited 1 (10/12 pass), rollback generation3 killed and `state='stopped'` after lost ACK; exact-token second release mismatched (`.tmp/pass2-red.log`). Separate `runtime/lock.test.ts` RED exit1, old code reclaimed dead-Supervisor PID lock while a child remained live (`.tmp/pass2-lock-red.log`).

GREEN: final pinned Node24 serial tests on `runtime/lock.test.ts`, `supervisor/{supervisorGeneration,maintenanceRace,supervisor.lifetime,activityGuard}.test.ts`, `server-core/{coreSupervisor,maintenanceAdmission,maintenanceReply,coreAuthority,taskActivityTracker}.test.ts`: **22/22**, `.tmp/pass2-final-tests.log`. Root `pnpm typecheck` **exit0**, 11-project closure `.tmp/pass2-final-typecheck.log`; root `pnpm lint --threads=1` **exit0, 76 warnings, 0 errors** `.tmp/pass2-final-lint.log`; architecture changed check **exit0/0 new**; changed-file `oxfmt --check --threads=1` **exit0**; `git diff --check` **exit0**. All heavy jobs absolute shared slot, pinned Node24.14.0/PATH, 2048MiB/process, one internal worker.

**Not accepted / dependency:** combined serial suite INCLUDING public `coreProductionFactory.test.ts` **18/19**, exit1: real public Core subprocess maintenance begin returns no leaseId (same protected factory failure as pass 1), `.tmp/pass2-tests.log`. In this checkout `packages/services/src/node.ts` has no `admissionFence`/`bootAdmissionLease`; CLI held candidate cannot boot against production factory. Request to protected Services owner remains pending; no synthetic fixture token proves native/Host pre-init fence. Bare ReleaseManager fixture directories are not executable/validated-format release bundles. No real public factory update/rollback/reap, full native autonomous ingress, IPC error+close, actual failed kill/reap/caller cancellation, packaging/SSH/live/8h gate certified. Do not mark SUPERVISOR_GENERATION_GATE PASS until dependency joined, real subprocess/release tests and independent review pass. No actual credentials, providers, service installation or push used.
