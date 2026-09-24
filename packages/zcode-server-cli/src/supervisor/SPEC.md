# Supervisor generation and update transaction

Owner: Supervisor owns exactly one current child/generation, lifecycle gate, release pointer transaction and maintenance handle. Core's maintenance port alone owns admission/activity; CLI is not a second queue. Services CoreNative owns worker/timer ingress. No GUI detach or SSH loss causes lifecycle work.

```
control -> lifecycle gate -> capture child + generation -> Core freeze -> fresh census
  -> revalidate child + generation + lease after each await -> stop captured child/observe terminal
  -> write update transaction/current -> launch candidate fenced -> generation-ready
  -> complete pointer transaction -> release candidate lease -> admit
failure -> terminate candidate (confirmed OS terminal) -> restore pointer/transaction
  -> launch previous fenced -> generation-ready -> release previous lease
```

Unknown, missing IPC, failed release, waiting and running are unsafe for nonforce. Explicit force may interrupt activity but must still verify lease identity and generation. A stale reply, old release or old restart timer cannot authorize an effect on a new child. A maintenance request racing Core exit never transfers its lease; acquiring it after exit fails closed. A failed stop retains child/lock and `stop-failed`; no new Core may launch without confirmed terminal. If the update pointer transaction has committed but release acknowledgment is lost, do not roll back (the candidate may already have admitted work); preserve committed pointer, lock, child and `stop-failed` diagnostic for explicit intervention. A release retry for the *same* token may be idempotent only after acknowledgment, not globally. Fallback leases cannot be consumed by update/uninstall. `confirm-uninstall` validates under the captured generation before acknowledging background stop; any intervening generation switch rejects. Read-only prepare is advisory, not admission.

During an update decision window candidate and rollback Core must start fenced *before* opening any ingress, including reconciliation and independent native workers/timers. Core `ready` while held is internal only: Supervisor continues to report `starting` until commit and the exact generation's boot lease release ACK; only then does it report `ready` and allow writes. Requires services-owned boot-held API at `@zcode/services/node` (MAIN approved `CoreAuthorityOptions.admissionFence` and `CoreAuthorityResult.bootAdmissionLease`, interface request in `.tmp/interface-handoff.md`). CLI adopts the actual factory lease into the existing CoreMaintenanceAdmission token owner; it does not acquire a second late freeze. Missing public factory boot hold fails candidate readiness closed. Until the services seam is implemented and tested, candidate rollback certification remains blocked. Stable local path fallback remains for no pending release. Release fixtures remain isolated, no external downloads or user service registration.

Acceptance: controlled barriers at maintenance request/reply, pointer-read await and release; replacement death before/after lease; late ready/heartbeat/activity/terminal/restart; busy/waiting/unknown refusal; candidate failure/ready timeout and rollback; failed kill/reap; real subprocess Core and verified-format local releases. Lock survives unconfirmed terminal. Cross-owner native autonomous ingress is a separate FULL_CORE proof, not implied by RPC read lock. Desktop continuous and mobile replayable transports attach to one Core owner but retain their own delivery semantics; neither owns update.
