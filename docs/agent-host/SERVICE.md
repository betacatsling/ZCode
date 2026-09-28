# Target-local AgentHostService admission contract

External sessions use a separate opt-in RPC service in the target's existing service process. A fixed host target identity, workspace realpath and worktree are checked before accepting create/attach/commands; the renderer cannot supply an arbitrary target ID or ask the native ZCode CLI to take over external state. The process registers only verified Harness adapters. A composite `(targetId, workspaceIdentity.trim() || worktreePath, harnessId, hostSessionId)` key prevents cross-workspace collision. Reopening a stored session loads its journal and native backend binding but never resends accepted commands; an uncertain command is visible as `execution-unknown`. The target-scoped `listActivityIndex()` enumerates every stored external manifest independently of Project/Worktree UI membership and the native CLI sessions index. It reads bounded manifests and atomic activity projections with epoch/sequence fences; missing, invalid, or unmounted busy entries are `unknown` and count as busy. This index does not read event/transcript journals or command payloads, start a worker, load a Harness adapter, or call a Provider. History remains available without credentials, adapters, workers, or the original worktree path. Terminated sessions remain readable after a process restart.

The target advertises a runtime availability view (stable target ID, platform/kind and whether new Pi sessions are enabled) through its service channel; the UI never guesses a remote target ID or assumes that a channel exists on an older host. Enablement controls **new admission**, not ownership of existing sessions. A client disconnect only unregisters its event subscription. Server core must expose the RPC channel only under trusted host capability or an equivalent authorized scope; the unauthenticated generic web websocket must not gain write access. Host shutdown/upgrade must retain the durable journal and treat an interrupted active turn as uncertain until reconciled, not fabricate completion. Native V4 service and its persisted data are not modified by this service.

## Admission ownership and concurrency

The target service is the single in-process owner of external session admission. Its durable session identity is the composite `(targetId, workspaceIdentity.trim() || worktreePath, harnessId, hostSessionId)`. The manifest and journal paths use that composite identity. The adapter interface still addresses a live backend by `hostSessionId`, so one target service keeps a host-session ID under one owner lease: the same ID cannot be admitted for a second workspace or Harness while the first owner is mounted.

`create` and `attach` run through one serialized admission lane per `hostSessionId`. The lane is reserved before asynchronous worktree verification, model planning or worker startup. A successful operation commits the owner only after its `SessionHost` is mounted; any verification, planning, backend or journal failure releases the lane and leaves no owner entry. An `attach` that follows a successful `create` returns that mounted host instead of starting another backend. Concurrent creates therefore yield one owner and a deterministic duplicate/ownership error, including when their workspaces differ.

```text
create/attach
      │ reserve hostSessionId lane
      ├─ verify target + realpath + worktree
      ├─ create/open SessionHost and backend
      ├─ mount composite identity ──> owner lease committed
      └─ failure ───────────────────> reservation released; no owner

close ──> reject later admissions
       └─ wait existing lanes ──> shut down adapters ──> close mounted hosts
```

`close` marks the target service as closing before waiting for already admitted lanes. An admission that started first is allowed to settle and is then closed; a later `create` or `attach` is rejected. Closing never replays or cancels a command and never transfers a mounted owner. Pi applies the same rule inside its adapter: a per-`hostSessionId` in-flight start reservation is installed before asynchronous worker spawn, cleared on failure, and a concurrent direct `attach` receives an explicit "already starting" rejection instead of starting or joining a second worker. A stale completion after shutdown cannot become a live session.

This lane is an in-process admission guard for one target service instance. Durable process-crash recovery and cross-process owner fencing remain a P4 requirement; the lane must not be presented as a distributed lock.
