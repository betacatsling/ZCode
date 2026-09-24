# hierarchy-actions — completed bounded patch

## Commits

- `0d8863dd70cf58110052624b2011e09d9133922d` — spec + early public `IWorkspaceHierarchyService` DTOs; `.tmp/interface-handoff.md` published before implementation.
- `f84bf62` — server owner fencing, server removal preview, read-only recovery query, fail-closed sidebar confirmation, unit/integration + desktop/mobile E2E.

## Files / ownership

Only `packages/services/src/workspace-hierarchy/{SPEC.md,serviceContract.ts,hierarchyService.ts}`, `packages/services/test/workspaceHierarchy.test.ts`, `packages/ui/src/project-sidebar/{SPEC.md,types.ts,ProjectSidebar.tsx,SidebarDialogs.tsx}`, `packages/ui/e2e/{hierarchy.fixture.tsx,hierarchy.spec.ts}`, and own `.tmp` handoff/report. Net +~706 lines against base, including formatting of previously unformatted owned files.

Target/Catalog own persistent worktree, repository and Git authority; Host/native own session provenance; hierarchy only resolves and returns read-only navigation/preflight. Event sequence: workspace ID + generation → target-scoped catalog/binding → Target live preview → user confirmation → existing Catalog remove → Target frozen recheck. No UI execution facts sent to Target, no second Git path or mutation during recovery inspection. Preview is not a lease: stale/unknown/unsafe facts fail closed, rejected command keeps dialog open. Native provenance lacking original generation/binding is history-only. Old external spec resolves history-only at rebuilt same path/new generation or mismatched project/binding; Host/Target admission still independently checks execution.

## Executed evidence

- `node scripts/check-workspace-freshness.mjs`: fresh (ahead 42, behind 0 at start).
- `mise exec -- node scripts/mise-run.mjs pnpm exec tsx --test packages/services/test/workspaceHierarchy.test.ts`: 1/1 pass; real Git+Catalog+Target+Host, main/linked/untracked/live activity, stale generation, mismatched binding, native legacy/matching/rebuilt provenance, recovery unresolved.
- `ZCODE_E2E_CHROMIUM_PATH=/Applications/Chromium.app/Contents/MacOS/Chromium mise exec -- node scripts/mise-run.mjs pnpm exec playwright test --config .tmp/hierarchy-playwright.config.ts hierarchy.spec.ts --workers=1`: 6/6 desktop+mobile pass. The disposable config only selected port 4188 because another worktree occupied 4179; disposed afterward. Tests include dirty, unknown, main, untracked, submodules, Git/worktree locks, running/offline, successful removal and rejected frozen recheck.
- `mise exec -- node scripts/mise-run.mjs pnpm lint`: exit 0, 70 pre-existing warnings, 0 errors.
- `mise exec -- node scripts/mise-run.mjs pnpm architecture:check --changed`: OK, 0 baseline / 0 new violations.
- `mise exec -- node scripts/mise-run.mjs pnpm exec oxfmt --check` on owned files: OK. `git diff --check`: OK.
- `mise exec -- node scripts/mise-run.mjs pnpm typecheck`: exit 2 (not passing). 15 TS2307 errors from unresolved `@zcode/contracts` and `@zcode/adapters/model` in other packages; same errors before/after patch. Not changed or suppressed here.

## Integration seams / blockers

- `create-options` owns `useMountedProjectSidebar`: forward `SidebarActions.onPreviewRemoval(id, expectedGeneration)` to `IWorkspaceHierarchyService.previewRemoval({workspaceId: id, expectedGeneration})`; missing callback deliberately disables confirmation. No hook touched here.
- `native-facts`/service-boot must supply trusted native original `worktreeGeneration` and `repositoryBindingId` to `NativeHierarchyPort.resolveOwner` (or native remains history-only). Neither Core mount nor production sidebar mount asserted by these isolated tests.
- `target-receipts` has not supplied a durable recovery proof to this lane: `pendingRecovery` explicitly returns only unresolved/inspect; **no adoption or Git retry**, no writable recovery action. Receipt-backed reconciliation remains another lane.
- UI E2E uses deterministic sidebar fixture, not production desktop connection. Existing Target frozen removal recheck reused, not reimplemented here.
