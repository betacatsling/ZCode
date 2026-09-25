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
