# Sol native-create fence handoff interface

Committed cherry-pickable source `18f33da0cb4867145e6f7b3f86f7ad72684a75d4` on `goal/5be7ed74-core-native-mount` (parent `bd1a037`; dependency includes repair `3e2b1b8`). Read `.tmp/MICRO-sol-resume-repair.md` final addendum and absolute-root `sol-native-create-{red,final,final-typecheck,final-lint,final-fmtcheck,arch}.log`. No uncommitted product changes; unrelated dirty `.tmp/REVIEW-core-native-mount-1.md` untouched.

Internal Node native-create contract: `NativeHierarchyPort.create(input, beforeWrite)` → `NativeRuntimeFactsPort.create(input, beforeWrite)`; callback is valid only inside one existing maintenance → Catalog → Target admission and rechecks real Git/generation + Catalog binding. Core calls it pre-effect and inside both `NativeCreateJournal.complete` paths. Hierarchy rechecks before Catalog reference. Original command/model/cwd/source fingerprint unchanged. Only test-only observers after actual CLI attempt and after mapping; they cannot forge completed receipts or admission. Production Native OFF.

Executed final 9/9 public factory checks pass. Root typecheck exit 1 due existing UI TS2322 at 1693; root lint/owned format/architecture pass. Integration must verify combined candidate; do not attribute these checks to later assembly, change boot hunks, or claim cross-process atomic exclusion after final Git check.

Final handoff HEAD `d3db611` adds only explicit Catalog lease-expiry regression (1/1 actual pass); product source remains `18f33da`. Final root typecheck/lint rerun on HEAD: same UI TS2322 / lint exit 0. Local dirty state only unrelated `.tmp/REVIEW-core-native-mount-1.md`.
