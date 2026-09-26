# integration-ready — bounded join, 2026-09-24

## Checkout / commits

Checkout `goal/5be7ed74-integration`, initially clean at `5c7c07f`; early typed handoff committed as `7e3b682` (`.tmp/interface-handoff.md`). Previous clean combined checkpoint `5c7c07f` already contained every requested component as equivalent cherry-picks. Original source SHAs are **not** ancestors; do not repeat the picks. No component-owned implementation files were modified in this continuation, and no other worktree, global config, profile, paid endpoint or remote push was touched. Unsafe canonical `aa621c2`, Claude `ffc9564` and rights-unverified Pi asset `eac1584` were not integrated.

Original → integration equivalent, in dependency order:

- Target `16defea`→`c4ee8ee`, `0f8628d`→`9e94852`.
- Catalog `0692766`→`ba1d7d0`, `c48a340`→`fc987d1`.
- Services `d82e5e2`→`f143cb2`, `8086fc5`→`2608363`.
- UI `bb7beea`→`ad6e835`, `e806aac`→`17a2079`, `a251b5d`→`a27356f`, `a7a3f00`→`bf01089`, `9bf51e6`→`c19b9ba`.
- Runtime `b9b3695`→`84e9ee3`, `228bdb5`→`41a6736`, `8bbeed8`→`3704cc6`.
- Codex `107bee6`→`91316c4`, `727b847`→`d2b1e1a`.
- ACP `5175fd7`→`fb99b68`, `7df8ea2`→`7cc74d3`, `f211240`→`e5239ea`, `b5df276`→`e706e2d` (unsafe pinned profile remains unavailable).
- Local live `62b4449`→`6e39445`; remote preflight `ae2c170`→`5c7c07f` (remote matrix is preflight ONLY, not runtime execution).

## Executed validation

`node scripts/check-workspace-freshness.mjs` passed (no tracking branch, behind 0). Pinned `mise exec -- node scripts/mise-run.mjs pnpm ...`:

- Focused combined `exec tsx --test` for Target/Catalog/Git recovery, hierarchy/maintenance, Codex, ACP guard, public integration exports, mounted owner, desktop child-process RPC detach, Core maintenance, remote preflight: **42 tests, 41 pass, 1 skipped, 0 failed**, ~22.7s. Skipped native pinned Codex CLI fake-upstream E2E remains unproven.
- Root `typecheck`: **FAIL** with three errors: `packages/services/src/agent-adapters/codex/codexHarnessAdapter.ts:125,146` still takes v1 `SessionSpec` rather than current `HarnessAdapter` v2 contract; `packages/services/src/workspace-hierarchy/lazyComposition.ts:116` catalog RPC facade lacks `reconcilePending` and `reconcileArchivePolicies`. These are Codex and service-boot semantic owner files, respectively; not masked with a stub or competing edit.
- Root `lint`: **PASS**, 70 warnings, 0 errors. `architecture:check --changed`: **PASS**, 0 violations. `architecture:context services` and `session` read (an initial mistaken `services/session` module ID failed before correction). No full browser/packaged desktop/SSH E2E run.

## Product mounting gaps at checked-out source (not certifications)

- `packages/zcode-server-cli/src/server-core/entry.ts` calls `runServerCore(generation)` with **no** maintenance port. `core.ts` instantiates Core service collection, but does not inject native index/activity/fence or supply a serialized maintenance lease; `CoreMaintenanceAdmission(undefined)` refuses automatic maintenance. Ownership: core-boot/maintenance-lease/native-facts/service-boot, not an integration stub.
- `packages/services/src/node.ts` registers lazy catalog/hierarchy/Host in server and desktop collections but `workspaceComposition` native index/activity/fence are optional and no real configured-path native facts were supplied here. `lazyComposition.ts` has no boot-time `reconcilePending`/`reconcileArchivePolicies` gate and does not expose those facade methods; target-correlated lookup receipts absent in `project-workspaces/targetBridge.ts`. Thus do not claim crash-safe new admission/production composition.
- `packages/desktop/src/host/targetHostRpc.ts` has authenticated attachment and passing subprocess detach fixture, but search of non-test desktop source found no `connectTargetHostRpc` caller in window Host bootstrap. Actual GUI attachment/quit-reopen is unverified. Desktop `host/index.ts` still constructs `agentHostTargetId: local:<deviceMid>` without a proven Core proxy in this checkpoint.
- Codex adapter not registered by the production node composition and does not currently typecheck against v2. ACP guard tests pass but pin remains unsupported; no Claude repair integrated. UI has scoped `SessionPane` but whole-shell owner mounting, model options/removal and desktop/mobile browser acceptance remain distinct follow-ups. Remote target preflight recorded a StepFun API mismatch and 0 paid calls; no packaged Linux closure or remote four-pair execution.

Owner/event sketch: target durable Git intent → catalog durable binding/ordering/reconciliation → persistent Core Host command ownership; native CLI CommandInbox owns native accepted input. Current local-window service collection must not become a second profile/target writer. Desktop continuous live transport and mobile replayable snapshot both require same owner; no lifecycle proof in this join. Unknown Git outcome cannot be converted to success by path match or replayed creation. This report describes source observations, not P0–P6 completion.
