# Codex 0.156.1 raw app-server transport (foundation)

This is a target-local JSON-lines RPC client, **not** a HarnessAdapter or a certified model route. The executable must report exactly `codex-cli 0.156.1`; all other versions fail before app-server launch. No TUI, UI registration, shared contract or implicit Provider login. Protocol reference: `codex app-server generate-ts --out <isolated temp dir>` on 0.156.1, especially `v2/{ThreadStartParams,ThreadResumeParams,TurnStartParams,TurnInterruptParams,CommandExecutionRequestApprovalParams,FileChangeRequestApprovalParams}*.ts`; the opt-in fixture `packages/services/test/fixtures/probeCodexAppServer.mjs` records a fake Responses exchange.

## Owner and interface

`CodexTransport` owns one child process, RPC request IDs and pending calls, native thread/turn associations, outstanding backend approval requests, and the ordered write queue. Its caller owns the absolute target cwd, a private per-session home directory (must not be the ambient HOME or cwd), Gateway loopback URL/token/model alias, and durable approval decisions. The token is passed only via environment, never argv or logs. The launch overrides `model_providers.zcode` (responses wire API, env key), `model_provider=zcode`, and isolated HOME/CODEX_HOME, using `--strict-config`. The caller must issue/revoke Gateway credentials independently. No automatic writes to global configuration. No cross-process session resurrection is promised: native history depends on retaining the private profile; `resumeThread` is the pinned native RPC on a live client.

`createCodexTransport(options)` initializes before returning. `startThread`, `resumeThread`, `startTurn`, `interruptTurn`, `replyApproval`, `close` are raw controls. `onEvent` receives structured method/params for notifications and backend approvals (not canonical host events); approval responses are keyed by transport-owned opaque callback keys plus native `approvalId` if present. Only `accept`/`decline` are exposed for command/file approvals. Unknown backend requests receive a method-not-found error, never authorization. The transport has no durable host journal: the higher host must persist an acceptance _before_ calling `replyApproval`. Raw events are not persisted by this layer.

## Sequence and safety

```text
caller → version probe → spawn isolated app-server → initialize → initialized
       → thread/start or thread/resume → turn/start → structured notifications
server → approval request (held by transport) → caller persists decision → replyApproval → server
caller → turn/interrupt(threadId,turnId) → server; close/exit → fail pending calls and approvals
```

Each request ID is correlated exactly once. Each approval callback also binds its original thread, turn and item; after `turn/completed`, interruption, process failure or close, approval replies are stale and rejected. A callback without a matching active turn is declined. Unknown/duplicate reply IDs are ignored. JSON-lines are UTF-8 with a 1 MiB frame and 4 MiB buffered-write ceiling, maximum 128 pending RPCs and 128 outstanding approvals; malformed/oversized frames terminate the transport and fail all pending requests. Bounded frame parsing and stdin drain enforce transport backpressure. Server stderr is never surfaced (it may contain private prompts or credentials). Async writes have explicit error propagation. Turn identity and notifications are native opaque data: higher layers still need host epochs, approval durability, replay and capabilities. No claim that sandbox/approval policy intercepts _all_ tools: this layer handles actual observed backend callbacks only.

## Acceptance scenarios

Fake child: interleaved thread/turn calls maintain ID association; malformed or oversized frames and process exit reject pending requests; command/file approval denial returns exactly the native decision and late/duplicate replies fail closed; interrupt invalidates approval; closed transport refuses new commands. Opt-in isolated CLI smoke must exercise initialize, a fake Responses turn and structured completion only; it is not model routing certification. Unknown versions fail closed, not as a best-effort parser.
