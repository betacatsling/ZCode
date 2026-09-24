# convergence-assembly — early combined checkpoint

Clean source checkpoint: `a39d454` (before this handoff commit). Base `f4dc246`; no paid calls or production profile enablement. This is an integration staging point, **not acceptance**.

Native admitted components now equivalent to source `52ae67e/7c2f75e/3c2465d/9c352c3/a7f5542/0ae733d` as `c5e45de/4d7f9ba/b8221b3/9dbdbe3/24d44e4/bba3805`; bootstrap `79f5be3/1cf36ac/47a084e` as `f3fb265/d287ad8/8c75562`; mutation fence `895119b/8e1c597/10aac8b/aae60c2/c2ba291` as `176395c/0710011/5f2614b/512ac5b/8cc3d8d`; CLI role compatibility `a33489d` as `a39d454` (developer instructions through interleaved compaction still unresolved, owner native-live-effects). Native composition prerequisites `7195d35/7c8d524` were empty against existing equivalent `d225d0a/d1bb2d6`; skipped, not silently discarded.

Typed joins inherited from base: `createLazyWorkspaceComposition({root,target,registry,identity,newAdmissionsEnabled,...})` returns `agentHost/catalog/hierarchy/maintenance/dispose`; `connectTargetHostRpc(ticket)` returns `{services,dispose}`. Native control port comes from `getNativeMaintenanceControlPort(realAgentService)`; `createNativeAdmissionFence` and `createNativeProductionBridge` are available but not yet production-mounted. Core authority needs required `createCoreAuthority(...)` and ready/reconciliation (service-boot/core-boot sources pending). Legacy local path must not be silently interpreted as certified Core.

Owner/order: CLI CommandInbox owns native accepted mutations; CLI lease and real activity must be verified before Core's automatic maintenance admission. Target owns Git correlated receipts → Catalog reconciles before NEW admission → Host owns accepted external turns; desktop continuous/mobile replayable read one Host owner. No second queue or path-only binding. No schema/profile gate was relaxed. Negative Claude native beta result and experimental ACP guard remain unchanged.

Pending picks: target receipts; service/native facts/lease/core; controls/hierarchy/desktop/SSH/UI; canonical Pi/question/projection; ACP and Responses; bounded load candidate. Protocol-terminal writer owns Codex/Claude terminal fixes; do not substitute old unsafe Claude or early Codex ACK behavior. No root aggregate gate run at this checkpoint; next stage will run via global heavy slot with workers=1 and report failures as failures.

---

# protocol-v2-closure early public API handoff

Base 6456283 already supplies Host V2 and shared `SessionSpecV2`/`BackendBindingV2`. This lane owns `@zcode/services/agent-host/codex` and `/claude` public trusted factories, not a replacement Host. Codex V2 adapter will reject V1 writes, bind target/workspace/generation, use verified relative cwd and fence all native events by turn ID. Claude final assistant is authoritative over partial text. No paid calls; native fake plus Host replay tests required before certification. No production enablement implied.
