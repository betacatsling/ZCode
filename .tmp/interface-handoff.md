# convergence-assembly — early combined checkpoint

Clean source checkpoint: `a39d454` (before this handoff commit). Base `f4dc246`; no paid calls or production profile enablement. This is an integration staging point, **not acceptance**.

Native admitted components now equivalent to source `52ae67e/7c2f75e/3c2465d/9c352c3/a7f5542/0ae733d` as `c5e45de/4d7f9ba/b8221b3/9dbdbe3/24d44e4/bba3805`; bootstrap `79f5be3/1cf36ac/47a084e` as `f3fb265/d287ad8/8c75562`; mutation fence `895119b/8e1c597/10aac8b/aae60c2/c2ba291` as `176395c/0710011/5f2614b/512ac5b/8cc3d8d`; CLI role compatibility `a33489d` as `a39d454` (developer instructions through interleaved compaction still unresolved, owner native-live-effects). Native composition prerequisites `7195d35/7c8d524` were empty against existing equivalent `d225d0a/d1bb2d6`; skipped, not silently discarded.

Typed joins inherited from base: `createLazyWorkspaceComposition({root,target,registry,identity,newAdmissionsEnabled,...})` returns `agentHost/catalog/hierarchy/maintenance/dispose`; `connectTargetHostRpc(ticket)` returns `{services,dispose}`. Native control port comes from `getNativeMaintenanceControlPort(realAgentService)`; `createNativeAdmissionFence` and `createNativeProductionBridge` are available but not yet production-mounted. Core authority needs required `createCoreAuthority(...)` and ready/reconciliation (service-boot/core-boot sources pending). Legacy local path must not be silently interpreted as certified Core.

Owner/order: CLI CommandInbox owns native accepted mutations; CLI lease and real activity must be verified before Core's automatic maintenance admission. Target owns Git correlated receipts → Catalog reconciles before NEW admission → Host owns accepted external turns; desktop continuous/mobile replayable read one Host owner. No second queue or path-only binding. No schema/profile gate was relaxed. Negative Claude native beta result and experimental ACP guard remain unchanged.

Pending picks: target receipts; service/native facts/lease/core; controls/hierarchy/desktop/SSH/UI; canonical Pi/question/projection; ACP and Responses; bounded load candidate. Protocol-terminal writer owns Codex/Claude terminal fixes; do not substitute old unsafe Claude or early Codex ACK behavior. No root aggregate gate run at this checkpoint; next stage will run via global heavy slot with workers=1 and report failures as failures.

---

# protocol-v2-closure early public API handoff

Base 6456283 already supplies Host V2 and shared `SessionSpecV2`/`BackendBindingV2`. This lane owns `@zcode/services/agent-host/codex` and `/claude` public trusted factories, not a replacement Host. Codex V2 adapter will reject V1 writes, bind target/workspace/generation, use verified relative cwd and fence all native events by turn ID. Claude final assistant is authoritative over partial text. No paid calls; native fake plus Host replay tests required before certification. No production enablement implied.

---

# protocol-final-1 early boundary (base 15e5b682)

Owned: services Codex/Claude adapters, adapter-local provenance, tests/spec. Host/Target/Git read-only subjects, no Host business edits. Codex adapter persists immutable V2 binding + never-started/starting/established; missing/unknown fails attach, Host history remains readable. Byte-bounded pre-ACK/stdio; pinned CLI/Git and SDK fixture evidence remains scoped. No public seam requested. No paid calls or credentials.

# protocol-final-2 early seam (HEAD f2c6259)
Owned: adapter catch normalization and pinned CLI Host fixture only; spec updated before implementation. No Host/Core/UI/Target/Git/Gateway writes or new public seam. Independent Host/adapter reopen must send on original native thread; child-death accepted send must return execution-unknown, revoke once and never replay. Before-ACK genuine byte proxy remains separately scoped if not proven; no Claude production beta claim. Global heavy slot required for tests/builds.

---

# sol-resume-codex transport handoff (source f34a5738d26c4f901ecca7a5e29c2fc721f2b6df)

No new public API. `CodexTransport.close()` now treats an already signal-reaped native child as exited (`signalCode` non-null even when `exitCode` null). Unique opt-in OS-child test captures genuine native `turn/start` ACK, kills actual pinned process (PID 21410 on final run), observes one child and two bounded closes; executed RED timeout pre-fix, GREEN 1/1 post-fix. See `.tmp/MICRO-sol-resume-codex.md` and `/tmp/sol-codex-{red,green-final}.log`. This proves transport cleanup only, not Host durable unknown/reopen, lease count, actual oversize, per-turn Host Model switch or full route/usage. No Host/Core/Gateway/shared changes; no new dependency for parallel owners. Offline missing `border-beam` blocked install and mandatory root type/lint/owned format; arch 0 new. No ongoing owned process; no paid/live call.

---

# Luna Codex continuation — source b0d215c2aa58e64cfd5748378268bbcd0650c0b6

Current one-hour bounded Codex checkpoint on `goal/5be7ed74-protocol-final`; tested source commit `b0d215c2aa58e64cfd5748378268bbcd0650c0b6`. This handoff is recorded in a separate docs-only commit; final HEAD has the tested source plus this report, with a clean worktree. No public/interface change requested. Actual `SessionHost` + pinned Codex 0.156.1 + Gateway/SDK fake-upstream two-turn test now retains the immutable first selection, validates per-turn usage snapshots once (`20/4` cumulative), and refuses altered-model Host reopen before lease/spawn. Usage projection emits stable source-scoped absolute snapshots, preserving missing vs explicit zero. Actual Host pre-ACK native SIGKILL PID8505 persisted unknown across independent Host/Adapter reopen with one lease revoke, no child/lease replacement; test counted 0 fake-upstream requests before kill and unchanged after retry, not a no-effect inference. Final focused suite 29 pass/1 opt-in skip; actual native controls/Gateway joins 2/2 pass. Root lint 0 errors/76 warnings; scoped Services typecheck and architecture pass; root typecheck OOM at the mandated 2GiB cap. See `.tmp/MICRO-sol-resume-codex.md` and `.tmp/luna-codex-{targeted,joined-regressions,services-typecheck,root-lint,typecheck}.log`. Actual native OS oversized-stream reaping, live providers, Claude/ACP/SSH/GUI, phone E2E (explicitly out of this sprint), production Native and long load remained open **at b0**. No owned processes or paid/model calls.

---

# Fresh Sol Codex Host byte-fault handoff (source e452596457c19162424e2d077a9419e5f99efca3)

No public seam or production code changed. Existing real Host OS kill/reopen, two-turn usage and immutable Model selection evidence remains attributed to b0. At e452596, actual pinned0.156.1 OS-child Host tests now inject test-origin fragmented unterminated and aggregate >1MiB stdout *after holding a genuine turn/start ACK*: transport fails pending RPC and reaps child (Codex handles SIGTERM with exit0); Host persists accepted-input execution-unknown, revokes exactly one lease, and independent Host/adapter reopen refuses duplicate replay/new input without a second lease/child/upstream request. Real upstream is owned OS-assigned fake HTTP with explicit 0-before/0-after measurement, not an ACK-based inference. Standalone actual-child tests separately prove `frame too large` rejection and no partial injected event dispatch. Final affected suite 30 pass/3 opt-in skip; scoped Services typecheck, root lint 0 errors/76 warnings, owned format and architecture0 pass. Root monolithic2GiB typecheck b0 OOM remains a **current unverified root gate**, not retried unchanged. Full Goal remains incomplete. See `.tmp/MICRO-sol-resume-codex.md` and `.tmp/sol-codex-byte-{targeted,services-typecheck,lint,format-final,arch}.log`. No cross-lane API need, live Model call, phone E2E, push, or lingering owned fixture.

## sol Codex usage omission — demonstrated atomicity defect (2026-09-25)
Executed RED `.tmp/sol-codex-usage-red2.log` on current source with pinned actual CLI/Host, genuine captured `turn/start` ACK, matched native turn ID and test-origin `input=3` then `input=3/output=2` absolute snapshots. Then injected matched `{output=2}` omitting already-known input. Native child did NOT fail/reap within 3000ms (fixture deadline; not a queued job); negative `input=-1` counterpart passed real child reaping, unknown, single revoke, independent reopen, no resend, fake upstream request=1. Source analysis: `usageAccounting.ts:39–42` rejects omission at projection read; `eventJournal.ts:77–84` durably appends structurally valid usage without semantic check; `sessionHost.ts:78–91` does not project/validate on append. Thus invalid omission can poison readable Host snapshot rather than mark execution unknown. Preserved failing test and log. Before changing shared Host/journal/ledger ownership, MAIN please note this precise defect; Sol will attempt narrow fail-closed boundary, no duplicate ledger or public API change.

Sol usage fault follow-up: narrow Codex adapter wire-shape guard now rejects matched-turn omission BEFORE Host append (including empty last); negative/noninteger were already fail-closed. Final actual-child scoped 30 pass/5 opt-in skip, 0 fail; details `.tmp/MICRO-sol-resume-codex.md` and `.tmp/sol-codex-usage-final-{targeted,types,lint,format,arch}.log`. Generic EventJournal admission still does not validate semantic usage across arbitrary adapters; do not claim universal Host atomicity fix. Root monolithic current tree typecheck unverified owing prior 2GiB OOM, no unchanged retry.
