# core-factory-2 worktree handoff

CORE_FACTORY_GATE: FAIL

Commits: `74f0a62` (spec + direct public-factory red regressions + early interface handoff), `91c28a5` (Core storage bootstrap and resident-worker stale-activity fix). No push or paid calls. The public `@zcode/services/node.createCoreAuthority` and default `runServerCore` caller were already mounted by earlier lane commits; neither test substitutes a CoreAuthority/native index/activity fixture.

**New verified factory behavior:** Fresh isolated HOME/ZCODE_DATA_BASE_DIR boots the actual Core and initializes task-index through its migration writer and session DB through the configured-path real CLI storage-startup worker before read-only sidebar projection; rejects a CLI lacking a matching `ready` storage fact. Full real `catalog.sidebarSnapshot()` returns empty rows on a genuinely initialized fresh profile (not on a missing DB). One resident checked-out CLI worker receives native same-epoch maintenance freeze; unfrozen worker activity is uncertain, frozen idle is verified; after that worker is disposed, cached idle is invalidated and stale release rejected. Post-composition startup failure (invalid CLI executable) closes resources and writer lock; a subsequent same-profile public factory call succeeds. Default Core HTTP detach/reconnect, duplicate writer, clean restart and repeated disposal remain tested. This is **not** a durable native create/restart proof.

From worktree root, all heavy commands through the absolute shared slot, internal concurrency 1 and Node old-space 2GiB:

```
python3 /Users/ykzheng/Desktop/Projects/Zcode/.tmp/multi-harness-5be7ed74/heavy-slot.py mise exec -- node scripts/mise-run.mjs pnpm --filter '@zcode/cli^...' -r --workspace-concurrency=1 build
python3 /Users/ykzheng/Desktop/Projects/Zcode/.tmp/multi-harness-5be7ed74/heavy-slot.py mise exec -- node scripts/mise-run.mjs pnpm --filter @zcode/cli build
python3 /Users/ykzheng/Desktop/Projects/Zcode/.tmp/multi-harness-5be7ed74/heavy-slot.py mise exec -- node --import tsx --test --test-concurrency=1 packages/zcode-server-cli/src/server-core/coreProductionFactory.test.ts
```

Result: dependency + CLI bundle build succeeded; subprocess test **1 passed, 0 failed** after format. Prior red test first failed `unable to open database file` on fresh sidebar, then after boot init a second actual red test observed stale frozen idle after worker exit; both fixed. `pnpm architecture:check --changed` **0 new/baseline violations**. `pnpm lint --threads=1` **exit 0**, 76 existing warnings, 0 errors. `pnpm typecheck` **FAILED**: existing Codex TS2416 V1→V2 create/attach errors, followed by Node 2GiB heap OOM (exit 134). Per memory safety, no unchanged retry or heap increase. One formatting job timed out **waiting** on global gate, then later acquired and completed; no bypass. No whole-app/SSH/load claims.

**Still blocking scoped acceptance 1–4:**

1. `packages/services/src/coreAuthority.ts` native runtime `create()` and `capabilities()` still throw; `certifiedCreate` is not set. No real CLI draft-create, native options, stable ID or read-after-worker-restart proof. CLI missing protocol primitive: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts:310-324` admits no input for draft create, `.../zcode-protocol-v4/create-session-command-fact.ts:9-46` reconstructs only from input queue ID; global query after worker restart cannot retrieve original native ID. MAIN must assign CLI-owned durable commandId + intent + original-ID fact before ACK, query/retry across restart. The migration `native-migration/mapping.json` is backup-verified legacy provenance and cannot be misused as a new-ID sidecar; add verified new native mapping writer/join before enabling create. Exact contract and owner/event order in `.tmp/interface-handoff.md`.
2. Factory test does **not** cover a valid Git project/workspace or successful creation, stored same native original ID after Core restart, timers/automatic ingress during freeze, or reconciliation-fault read-while-new-admission-refused. `createLocalServices` synchronous failure before returning its collection can still leak allocated resources; tested failure is **after** collection construction. A second Core with a different config root but the same native DB path is not locked out by the config-root lock; CLI outside Core is likewise not fenced by that lock. Crash-stale profile lock needs operator recovery; clean stop/restart alone is tested.
3. Supervisor replacement generation transfer, GUI, SSH and sustained load are separate full-goal gates, not silently accepted here.

Safety: production native create remains fail-closed; missing/uninitialized native DB never returns invented empty history. New fresh-profile empty read is possible **only after both real writer startup proofs**. Partial failure closes the collection if already returned, and worker enumeration/epoch check refuses unknown. This does not warrant `CORE_FACTORY_GATE: PASS`.
