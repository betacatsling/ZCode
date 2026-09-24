# Accepted controls at an external target

## Owner and contract

`AgentHostTargetService` owns routing between workspace admission and an already mounted `SessionHost`; only `SessionHost` owns accepted commands, runtime epoch/turn, approvals and receipts. `WorkspaceAdmissionPort.verify/withAdmission` remains the **new execution** gate, including archive, freeze, actual Git generation and contained cwd. No second command queue or speculative owner is introduced. The public `IAgentHostService` command/read signatures do not change.

## Rules

- `create`, `attach`, `send`, `resumeExecution`, and an approval `allow` require the live workspace admission gate; stale/removed/rebuilt scopes cannot execute a new turn or tool. Identical completed create retries are answered from the durable creation journal before admission, including when the feature flag is off. Conflicting/unknown receipts never execute.
- `cancelTurn` and `resolveInteraction: deny` for an already mounted, persisted exact session bypass **only** the new workspace admission check. They still require the target, complete stored spec, attached Host ownership, and Host journal validation of command ID, epoch, turn and interaction; no cold start or adapter attach from a control request. Archive/freeze/removed worktree must not strand a pending denial or cancellation. `detach`, `viewHistory`, `terminateSession` retain exact persisted owner checks; `allow` remains admission-gated.
- History/snapshot/rows/events/command query are read-only and never call workspace admission or launch an adapter, including after feature-off and path replacement. The lazy wrapper must not initialize a worker merely to answer a control/history request while the feature is off.
- No capability advertisement for a removed/archived scope as writable. A mounted Host owns its epoch; an unrelated caller cannot forge a new Host binding via the control path.

## Event order / acceptance

```
accepted send -> durable command -> mounted Host turn/approval
archive or remove -> new admission denied
control request -> target+persisted spec+mounted owner -> Host durable command -> epoch/turn/interaction check -> adapter deny/cancel
allow request -> live workspace/Git generation gate -> Host durable command -> adapter allow
```

Desktop continuous events and mobile replayable events share this Host journal; neither control nor history spawns a separate worker. Tests cover archived running and waiting, stale turn, missing/rebuilt tree, cold control rejection, and feature-off history/identical create retry without worker initialization.
