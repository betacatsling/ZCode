# Luna completed-repair race closure — bounded handoff

**Current source:** `3e2b1b8d0a7c5934153c950524bfa99604242b72` (`fix(core): serialize completed repair with catalog lifecycle`) on `goal/5be7ed74-core-native-mount`. Runtime: Node 24.14.0 via the absolute private pnpm and shared `heavy-slot.py`; local Node heap cap 2048 MiB, test concurrency 1. The historical Sol filename is retained for observer compatibility; this is the current Luna handoff.

## Change and ownership

- Updated `packages/services/src/workspace-hierarchy/SPEC.md` before implementation: the lock order is maintenance admission → existing Catalog serial owner → Target exclusive lease. Reuse the Catalog queue; no parallel business queue.
- Added a callback-scoped `ProjectCatalog.withNativeReferenceAdmission()` lease. Its local snapshot/reference writer avoid re-entering the Catalog queue while it is held; lease callbacks expire after return. Native completed-only repair and native create now keep Catalog → Target ordering through source certification, mapping/reference fsync, and final verification.
- Hierarchy repair uses the lease-local Catalog facts and Target lease-local real Git/receipt recheck. A competing admitted archive serializes behind repair. Disposal drains already-admitted repair. External replacement of the temporary repository’s Git admin inode fails before mapping/reference commit.
- Added trusted Node-only fixture observers for the real certificate boundary, actual native-fence acquisition, and actual maintenance admission. They cannot skip/change admission and are not RPC or environment bypasses. No protocol/RPC schema, Desktop, Phone, boot lifecycle, CLI business owner, or production Native enablement was changed.

## Executed evidence

- **Actual RED before the lock-order fix:** `.tmp/coreCompletedRepair-race-red.log` (SHA-256 `dc7a889dd9b50911fa9da6f222fbcbff11cfdcde603b726bf1e6d309484b949c`). Starting source was `d539f39009cf49bb6d5d090f29a67b3e42f42963` plus the trusted test observer/fixture. The real public Core + CLI + SQLite + Catalog + Target archive-during-repair case timed out at its finite 8-second test-only deadlock watchdog; the child exited nonzero and was reaped. This was an executed failure, not a queued job.
- **Final source SHA 3e2b1b8d…: 6/6 actual targeted tests passed** in `.tmp/coreCompletedRepair-final-actual.log` (SHA-256 `2a029369f311bff93fc2f0c583365fd8760449fe0ce390b0974154b9fa4aa790`): public factory `coreCompletedRepair`, legacy `coreCompletedRetry`, `coreCompletedArchiveDrain`, `coreCompletedGitSwap`, `coreCompletedDisposeDrain`, and the real Target lease-proof expiration case.
- The archive/freeze case pauses after the actual completed SQLite source certificate and before Core mapping. A real archive request is observed after entering maintenance admission; the actual CLI fence is acquired. No repair/archive/idle-grant completion is observed until the barrier opens. The test then asserts repair and archive both complete before the maintenance idle lease, with one mapping and one Catalog reference.
- The Git-swap case renames and reinitializes only the isolated test repository while the certificate barrier is held; repair rejects before mapping/reference writes and compares actual file bytes. The disposal case invokes Core disposal at the same boundary and asserts repair completes before disposal, with one reference and no deadlock. Parent test cleanup owns, kills/reaps, and removes only its temporary profile.
- Existing actual held-boot and ordinary-maintenance cases compare mapping/Catalog bytes before and after refused explicit/legacy repairs. After release with new Native creation disabled, the same original CLI ID is repaired once; parallel explicit/legacy retry remains idempotent. The factory tests assert no additional SQLite session allocation and zero fake Model HTTP calls.
- Real Target callback expiry regression: `.tmp/coreCompletedRepair-target-final.log` (SHA-256 `cbd464e0fb96312c8d133624f263f1a3086995e07313a43975ba2f0bfd00105f`).

## Verification and remaining boundaries

- `pnpm architecture:check --changed`: pass, 0 violations. `git diff --check`: pass.
- Owned 10-file `oxfmt --check --threads=1`: pass (`.tmp/coreCompletedRepair-owned-fmt.log`). Root `pnpm fmt:check --threads=1`: fails on 110 repository-wide pre-existing formatting files; none of the owned files are listed.
- Root `pnpm lint --threads=1`: exit 0, 76 warnings / 0 errors (`.tmp/coreCompletedRepair-root-lint.log`).
- Root `pnpm typecheck`: exit 1 at unchanged, out-of-scope `packages/ui/src/app-shell/WorkspaceShellLayout.tsx:1693` TS2322 (`MountedSessionOwner` missing `historyOnly`). Services and server-CLI project checks completed before the failure. UI source was not changed (`.tmp/coreCompletedRepair-root-typecheck.log`).
- No phone end-to-end was run, per user scope. No 100k history rerun. This closes the bounded actual repair race path only; it does not certify the overall refactor, authenticated remote same-path join, production Native creation, packaged release, live provider, 8-hour load, or phone/SSH end-to-end.
- Owned fixture processes exited/reaped. A post-test process scan found separate `heavy-slot.py ... pnpm typecheck` and `... pnpm lint` commands writing `/tmp/luna-*.log`; they were not launched or owned here and were left untouched. No own test/build process remained.

Unrelated dirty `.tmp/REVIEW-core-native-mount-1.md` was preserved and not staged. No reset, cherry-pick, remote build, push, user data, credentials, paid provider, or global service access.
