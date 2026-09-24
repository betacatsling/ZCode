PI_PORTABLE_GATE: PENDING_INDEPENDENT_REVIEW

# pi-portable-mount (local macOS source candidate)

Source commit `a14dd4b6d65eea000638c8c4e57cd61adb9c6657` (base `15e5b68`). No paid calls, global settings changes, push, or other-worktree writes. Source-only scope: `packages/services/src/agent-adapters/pi/{SPEC.md,piWorker.ts,piHarnessAdapter.ts,piPortableFileTools.ts,piFileBroker.ts}`, tests `packages/services/test/{piPortableFileTools,piWorkerMountRace,agentHostPiToolLoop}.test.ts`, appended `.tmp/interface-handoff.md`. Legacy Linux-only `piFileTools.ts` remains unmounted; its Mac test remains skipped and is **not** portability evidence. No Core/UI/Model changes.

## Actual mount / event order

Pinned SDK 0.87.1: `createAgentSession({tools:['read','write','edit','bash'],customTools:fileBoundary.tools})`. SDK registry starts from builtins and overwrites same-name definitions with customTools (`dist/core/agent-session.js:_refreshToolRegistry`); worker asserts exact active names. Extension `tool_call` prepares by call ID, turn, immutable serialized input **before** user approval. Each broker starts with OS-anchored parent cwd, verifies actual ancestor chain to the worker-held worktree root dev/ino, and holds existing regular file fd (`O_NOFOLLOW|O_NONBLOCK`). Permission denial/abort releases/reaps; allowed SDK tool uses injected operations backed exclusively by the same broker fd. Absent write creates only after allow with `O_EXCL|O_NOFOLLOW`; no pathname SDK write fallback. Edit retains SDK edit/diff/queue behavior; Bash remains SDK native with separate explicit approval and target-user authority, **not a sandbox**. Each broker launches fixed Node module without inherited env or shell; eight pending max, <=4MiB payload, closes child on normal/deny/abort/turn/terminate. Mac and Linux source path shared; Windows probe/capabilities/worker creation fail closed.

```
Pi Model → SDK tool_call → worker active-turn/input admission → broker cwd+existing FD
                                       → approval → SDK custom tool → broker FD effect → result
                                       └ deny/abort/stale/terminate → close/reap (no creation)
```

## Executed proof

- **Actual RED**, baseline worker substituted temporarily and restored with shell EXIT trap: `pnpm exec tsx --test --test-concurrency=1 packages/services/test/piWorkerMountRace.test.ts` failed: outside sentinel changed from `SECRET_OUTSIDE` to `approved` after symlink parent swap **between write approval request and allow**. Fixed worker same test green, writing the original directory inode.
- Memory-slot-wrapped `pnpm exec tsx --test --test-concurrency=1` across `piPortableFileTools`, `piWorkerMountRace`, `agentHostPiToolLoop`, `agentHostPiV2`, `agentHostPiWorker`, legacy `piFileTools`: **10 pass / 1 legacy Linux-only skip / 0 fail** (macOS). Real Host + SDK fake Model: native Read, denied Write (absent), allowed Write, Edit, Bash, later-turn Read of edited content; exact interaction id/turn/summary asserted. Deterministic parent, leaf, root swaps and absent-leaf substitution, FIFO refusal, stale/input mismatch, abort/deny, concurrent cleanup/child reaping and sentinel invariants pass.
- Built declaration prerequisites with serial `@zcode/dynamic-workflow`, `@zcode/contracts`, `@zcode/adapters`; `pnpm exec tsc -b packages/services` **pass**. Compiled JS `dist/agent-adapters/pi/piPortableFileTools.js` + compiled Node broker + pinned SDK write in a disposable fixture **pass**.
- `pnpm lint --threads=1` **exit 0, 76 repository warnings, 0 errors**; scoped oxlint **0 warnings/errors**; `pnpm architecture:check --changed` **0 new/baseline violations**; `git diff --check` pass.
- Required root `pnpm typecheck` executed twice under the global memory gate: initial missing CLI declaration artifacts and then V8 OOM at 2GiB; after serial dependency builds second run still **exit 134/OOM**. No heap raise/unchanged retry; focused services tsc passes, root check is **NOT green**. One oxfmt invocation defaulted to 10 threads (brief and completed); subsequent formatting explicitly used `--threads=1`. No browser task in this scope.

## Limits / review needed

Independent adversarial read-only review has **not** been run by this worker (user prohibits delegation; MAIN owns acceptance). Linux broker proof has **not** been run on remote Linux; source is present but no Linux certification. Windows has not been runtime-tested and is explicitly unsupported. Full-package distribution/GUI/SSH/paid provider/product release are not proven. This is a tool-file identity boundary, not a process/Bash sandbox. Other OS actors may mutate an approved inode concurrently; cancellation cannot roll back an effect already in-flight, but no denied or pre-effect-aborted call creates/truncates a file. New parent directories, images, nonregular files, and >4MiB payloads are unsupported. Reviewer should probe actual worker after terminate/crash, stale turn/call payload identity, root-parent-absent-create swaps, broker death/lifecycle, and SDK default-duplicate bypass, not just unit helper behavior.
