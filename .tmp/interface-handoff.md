# pi-mount-final-1 — Pi-only interface handoff

Scope: Pi adapter/transport/worker/broker/custom tools/spec/tests. No Core/CLI/UI/Model writes, paid calls, production configs or push. Pinned Node 24.14.0, SDK 0.87.1, actual Host+worker+fake Model.

```text
Host → Pi adapter [worker lifecycle, broker ChildProcess exit receipts, SDK Bash operation]
  → Pi worker [SDK loop, immutable call+turn admission, approvals, read FD alias]
  → parent broker owner [<=8 fixed-code children] → broker [pinned cwd+leaf FD]
  → parent SDK createLocalBashOperations [separately approved, NOT sandboxed]
worker unexpectedly exits → parent aborts SDK Bash, closes/reaps every broker,
  awaits worker/Bash/broker settlement → rejects accepted send as execution-unknown
```

The parent/worker transport uses typed per-request IDs and the parent rejects late messages after failure. Existing Write opens `O_WRONLY|O_NOFOLLOW|O_NONBLOCK` without truncation before approval (Edit still `O_RDWR`, Read `O_RDONLY`); effect writes/truncates the held FD. SDK Read resolver probes only the worker-held root `/dev/fd/N` alias; broker Read uses the already-prepared leaf FD. Native Read offset/limit preserved. Model-facing file descriptions explicitly exclude images/new directories/special files and disclose 4 MiB/regular-text/existing-parent limits. Bash remains SDK native shell operations, now parent-owned for abort + SDK wait-for-child receipt; this does not sandbox Bash or guarantee arbitrary detached grandchildren cannot escape SDK process-group control.

Node-only test hooks (never passed by the production factory) pause at actual prepared Read→SDK resolver and abruptly exit the actual worker. Crash fixture checks parent ChildProcess `exit` callback, drained requests/effects, pending new file absent and Host command execution-unknown/not-idle. Bash fixture starts an actual marked SDK shell, crashes worker, waits SDK operation settlement, and checks trailing effect absent. See `packages/services/test/piMountFinal.test.ts`.

**External blocker (not edited here):** root `pnpm typecheck` after dependency builds fails at `packages/ui/src/app-shell/WorkspaceShellLayout.tsx:1693`: UI `MountedSessionOwner` native lacks Core/Services `SessionOwner.historyOnly`. This is UI/Core-owned; focused services `tsc -b` passes. No claim root typecheck green.

Local macOS evidence only. Linux runtime not executed, Windows unsupported/unexecuted. Root/UI integration, live provider, packaging and long soak remain outside this Pi-only receipt. This handoff is not an independent review or product acceptance.
