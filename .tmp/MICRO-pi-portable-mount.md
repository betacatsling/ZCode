PI_PORTABLE_GATE: PENDING_INDEPENDENT_REVIEW

# pi-portable-mount wave 2 — local macOS scoped candidate

Source commit `1e62cb6ed8f6f9abd7f63cdb898791e6dec5d693` on `goal/5be7ed74-pi-portable-mount`. Base candidate `a14dd4b`, earlier handoff `73e5010`. Scope: Pi worker/broker/file tools, Pi target support extraction, spec, focused Host tests and `.tmp/interface-handoff.md`. No delegation, paid calls, global settings, push, other-worktree writes, new dependencies or background services. No Core/CLI/UI/Model change.

## What changed / ownership

Pinned SDK 0.87.1 still owns the native tool loop (`createAgentSession` custom read/write/edit definitions overriding builtins); the worker owns per-turn call/input approval; the broker holds verified ancestor cwd and regular-file FD before approval, creates an absent leaf only with `O_EXCL` after allow. Native Bash requires its *separate* approval and remains unsandboxed. Wave 2 extracts adapter target gates so `piHarnessAdapter.ts` passes max-lines; Windows remains unsupported. Interaction summary now derives from the *prepared* entry: bounded relative path, serialized input length, ephemeral HMAC-SHA-256 fingerprint (no raw content). Unreviewable paths fail closed; filenames and opaque fingerprints are stored in authorized interaction journals, not secret from journal readers. SDK Read pathname-existence resolution receives the worker's held root descriptor alias `/dev/fd/N`, while injected operations use the broker's pinned leaf FD. It cannot probe the original swapped leaf via the SDK resolver. Broker close has finite TERM/KILL escalation and explicit failed-reap outcome; disconnect limits orphan lifetime.

```
Model → SDK tool_call → worker turn/input admission → broker parent cwd + existing leaf FD
                               → review event → matching resolve → SDK custom tool → broker FD effect
                               └ deny/cancel/terminate → close/reap; worker crash → IPC disconnect → broker exit
```

No stale turn can execute a prepared tool; absent creates never occur on deny/pre-effect abort. An in-flight write cannot be rolled back. No image reads, new parent directories, nonregular files, >4 MiB inputs or Windows file tools. Linux implementation follows the same source path but **was not run on Linux in this wave**; do not certify Linux runtime. Root/parent generation after pinning operates on the held inode rather than a replacement path. OS actors may still mutate an approved inode concurrently; not an isolation sandbox.

## Executed evidence (all heavy commands through global 2 GiB slot; internal test concurrency 1)

- RED first: actual Host/SDK fake Model `agentHostPiToolLoop.test.ts` failed before fix: generic summary did not match scope/payload fingerprint; approval event existed but assertion prevented progression. After fix: passes, two differently prepared writes distinguishable without raw content.
- `pnpm exec tsx --test --test-concurrency=1` with `piPortableFileTools`, `piWorkerMountRace`, `agentHostPiToolLoop`, `agentHostPiV2`, `agentHostPiWorker`, `piFileTools`: **18 pass / 1 legacy Linux-only skip / 0 fail** on local macOS. Real Host/SDK fake Model covers read, denied/allowed write, edit, Bash, later-turn changed read; real-worker races cover approved parent/root/leaf replacement, absent-create symlink or competing existing file, pending cancel, FIFO refusal, unreviewable approval. Helper covers read-leaf substitution and other races. Standalone broker IPC disconnect test awaits actual child `exit` event and asserts no pending create; Host shutdown-pending test asserts no replay. No paid Model calls.
- `pnpm exec tsc -b packages/services`: **pass** after changes. `pnpm lint --threads=1`: **pass, 76 repository warnings / 0 errors** (max-lines blocker removed). `pnpm architecture:check --changed`: **0 violations**; `pnpm exec oxfmt --check --threads=1` on touched files: pass; `git diff --check`: pass. Net change: +364/-51 lines across 10 source/spec/test/handoff files.
- Root `pnpm typecheck`: **NOT PASSED**. Earlier wave attempted twice under the same 2 GiB cap, second after dependency preparation failed V8 OOM (exit 134); root unchanged resource budget and no identical OOM retry per memory-safety instruction. Focused services TypeScript is green, not a substitute for root gate.

## Independent-review limits

This worker has not conducted an independent read-only acceptance review; MAIN decides. The SDK read-probe guarantee is based on pinned SDK source plus actual mounted read/symlink-denial tests, **not** a deterministic real-worker swap exactly between Read preparation and SDK resolver; helper read-leaf swap passes. The actual Host worker unexpected-crash path has no externally observable broker-child `exit` receipt; standalone broker IPC-disconnect test does, and pending Host shutdown passes. No Linux/Windows execution, full release, remote package, process sandbox, or long soak is claimed. These distinctions must remain explicit in any acceptance verdict.
