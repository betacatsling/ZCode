# pi-mount-final-1 — scoped Pi correction receipt

Base `a192f963c3151d9c84073f8d8fee3fe43446d72c`; commit SHA: see final git log after commit. Only Pi adapter/worker/broker/tools, their spec/tests, and this worktree's `.tmp` handoff/receipt. No delegation, cross-worktree writes, paid calls, credentials/config reads, global changes, push or product enablement. Node via `mise exec -- node` = 24.14.0 (`/Users/ykzheng/.local/share/mise/installs/node/24.14.0/bin/node`); SDK installed from frozen lockfile = 0.87.1. Heavy commands used the absolute shared `heavy-slot.py` with 2 GiB Node heap, internal concurrency=1.

## Owner/order and proofs

```text
Host accepted send → Pi adapter owns worker + parent effects → worker SDK tool loop
  → worker prepares immutable call/turn → parent broker child pins ancestor cwd/leaf FD
  → approved Write/Edit/Bash (Read needs no approval) → native SDK definition/operations
  → parent child FD or parent SDK local Bash operations → SDK result → Host event
worker unexpected exit → adapter terminates worker, aborts SDK Bash, closes/reaps
  broker ChildProcess by actual exit event → drains accepted requests → Host unknown
```

- Native-valid existing 0200 Write now opens write-only before permission with no preapproval truncate. SDK's `fsWriteFile` semantics are retained on the same FD; Edit still opens read/write, Read read-only. Host/real worker/SDK/fake Model test first denies and checks original bytes, then allows shorter Write and checks full truncation plus outside sentinel. UID 501 on this macOS run; root discretionary-permission bypass must not be sold as evidence on another machine. The actual mounted test **RED** with original `O_RDWR` (no approval, `0 !== 1`, exit 1), **GREEN** with `O_WRONLY` (exit 0). Red was reproduced after building the test fixture; it is not represented as a chronological before-any-implementation run.
- Real Read pauses after the actual broker `open/init` and immediately before SDK `definition.execute` calls installed `resolveReadPathAsync`. Hook observes `/dev/fd/<worker-root-fd>` alias, renames the original leaf, installs outside symlink, resumes deterministically. Installed SDK `read.js`/`path-utils.js` sources are asserted in test (resolver probes supplied alias, not original path). Model next request contains original line-two (with native offset=2/limit=1), never outside secret; outside sentinel unchanged. No timing-window helper substitution.
- Real worker test crashes from a Node-only guarded message while **new Write approval is pending**. Parent transport owns broker ChildProcess and observes actual `exit`; Host accepted command settles `execution-unknown` after broker cleanup, not `idle`; no new file, broker/requests count zero. Parent retains closing entries until exit and uses bounded TERM→KILL / 1.5s failed-reap error; late exit also clears an uncertain closing entry. Already-in-flight FD writes cannot be rolled back.
- Parent owns SDK `createLocalBashOperations` via pinned SDK `createBashToolDefinition({operations})`; SDK still runs its native shell semantics and tool loop. Test runs a harmless marker+sleep child, crashes worker and awaits SDK abort/child-wait settlement; trailing effect absent, pending effects/requests zero. Bash approval is separate, **not** a filesystem/process sandbox; arbitrary subprocesses may escape SDK process-group behavior. Parent limits SDK Bash settlement wait to 1.5s on crash and reports uncertainty on timeout rather than false successful cleanup.
- Mounted model descriptions/guidelines correctly state regular text <=4 MiB, existing parent/worktree, no images or auto-mkdir, separate approval, and Bash not sandboxed. No unsupported params silently ignored. Existing signed/opaque reasoning, usage presence, follow-up Read, stale/deny/cancel, root/parent/leaf/absent races and FIFO tests retained.

## Exact verification (all heavy jobs via `python3 /Users/ykzheng/Desktop/Projects/Zcode/.tmp/multi-harness-5be7ed74/heavy-slot.py mise exec -- node scripts/mise-run.mjs pnpm ...`)

- `pnpm install --frozen-lockfile --ignore-scripts`: pass; `pnpm -r --workspace-concurrency=1 --filter '@zcode/adapters...' build`: pass (scoped prerequisites); `pnpm exec tsc -b packages/services`: pass.
- `pnpm exec tsx --test --test-concurrency=1 packages/services/test/piMountFinal.test.ts packages/services/test/piPortableFileTools.test.ts packages/services/test/piWorkerMountRace.test.ts packages/services/test/agentHostPiToolLoop.test.ts packages/services/test/agentHostPiV2.test.ts packages/services/test/agentHostPiWorker.test.ts packages/services/test/piFileTools.test.ts`: **22 pass, 1 pre-existing Linux-only skip, 0 fail** on macOS after parent-effects extraction. After final alias/diagnostic assertions, focused `piMountFinal.test.ts` rerun **4 pass / 0 fail**. No live provider calls.
- `pnpm lint --threads=1`: pass (76 repository warnings, 0 errors); `pnpm architecture:check --changed`: 0 violations; `pnpm exec oxfmt --check --threads=1` on all touched files: pass; `git diff --check`: pass.
- Mandatory `pnpm typecheck`: **FAIL exit 2** after necessary builds, at `packages/ui/src/app-shell/WorkspaceShellLayout.tsx:1693`: `MountedSessionOwner` native missing `SessionOwner.historyOnly`. UI/Core separately owned; no fix here, no green claim. Earlier wave had 2 GiB OOM; this new-source run reached and reported the UI type error without OOM. No unchanged retry or heap increase.

## Limits / handoff

No independent reviewer run in this no-delegation task. Linux runtime unexecuted (legacy Linux-only test skipped on macOS); Windows gated unsupported and unexecuted. Mac-only fake Model/local temp fixtures do not certify a paid/live provider, isolation against another actor modifying a held inode, Bash sandbox, package distribution, 8h soak, or root UI/Core typecheck. MAIN owns integration/acceptance; outstanding root UI/Core type mismatch is in `.tmp/interface-handoff.md`. No claim of product PASS.
