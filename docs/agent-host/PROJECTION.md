# External session V4 projection (incremental implementation contract)

The target host alone persists canonical events. Projection is a deterministic read model rebuilt from a contiguous, de-duplicated epoch journal; it never sends commands or executes tools. A `message.finished` replaces earlier deltas for the same message ID. Tool input is displayed as uncommitted text until a structured terminal tool event proves a complete value. A pending approval is displayed only after the adapter has installed a real execution-blocking gate, and is removed on the matching resolution/turn completion. A new turn must not inherit a previous turn's interaction. Unknown/unsupported actions are server-rejected as well as disabled in UI.

The native V4 transport and native projection remain unchanged. External snapshots use additive `agentHost` metadata and stable `logEpoch`/`seq`, expose a bounded `rows.window`, and paginate older rows from host records. Canonical event replay must not prompt, approve or write files. UI streaming and resync use the same authoritative journal cursor, never a renderer-owned transcript. First integration covers text, tools, approval, usage and control; richer rows are gated by separately certified capabilities.

## External ConversationTransport seam (P2/P3 implementation slice)

The external transport reuses the existing V4 `ConversationTransport` barrier and
wire assembler. The target Host remains the only owner of canonical events,
projection, command admission, and command receipts. The renderer receives
typed wire frames and never reconstructs a transcript from `AgentEvent`.

External creation is a separate typed service operation. It returns an explicit
session locator and the first Host snapshot; the native `createSession` command
continues through the native transport. External metadata is not added to the
native command payload, where an older schema could discard it.

```text
externalCreate(SessionSpec)
  → target Host admission / owner reservation / adapter create
  → { locator, snapshot }

subscribe(locator + SessionSpec, base?, runtimePolicy=existing-only)
  → Host journal snapshot; only an explicit `start-if-needed` attach may start a worker
  → ACK(subscriptionId, mode=snapshot)
  → initial complete wire frame(snapshot, logEpoch, seq)
  → renderer activate(subscriptionId)

Host event
  → Host authoritative snapshot/seq
  → online complete wire frame

resync(subscriptionId, base)
  → Host journal/history snapshot (same subscription, even when `snapshot.seq` is unchanged)
  → recovery complete wire frame on the same subscription

unsubscribe/detach
  → remove only the renderer subscription
  → keep SessionHost/worker alive
```

The first bridge emits complete snapshot frames for external events. This keeps
canonical projection and sequence ownership in the Host while reusing the V4
assembler; it is bounded by the Host snapshot window and is not a claim that
external streams have native delta efficiency. A future optimization may emit
typed deltas only after an explicit event-to-delta contract is proven.

`rowsRange` is a Host history query, not a slice of the current tail window. The
Host reprojects the complete journal with an exclusive `beforeRowId` cursor and
returns a bounded page; live and cold reads therefore share row IDs, ordering and
`hasMore` semantics.

Subscription ownership is registered before the initial snapshot is built. Events
observed during that await are coalesced into a catch-up snapshot after the
initial frame, so the registration/snapshot race cannot lose a sequence. Every
resync emits a recovery frame with `force` semantics; the `seq <= lastSeq` live
deduplication rule cannot suppress an explicit recovery. Unsubscribe removes the
frame listener only and disposal releases the upstream emitter, decoder and
assembly barrier.

`sendText` maps to one Host `send` command; the V4 `commandId` is the idempotency
key and the bridge generates a Host turn ID once for that command. `stop` carries
the caller's exact `expectedForegroundExecutionId` and `baseLogEpoch`; it never
substitutes the latest turn. `resolveInteraction` first proves the pending
interaction and then carries the caller's epoch; a stale interaction is rejected.
`queryCommands` reads Host command receipts and reconnect never resends a prompt.
`rowsRange` reads the Host snapshot/history projection. Plans, workflow detail,
file rewind, attachments, queue editing, model switching, and other uncertified
advanced operations return an explicit unsupported error before dispatch.

`desktop-continuous` and `web-remote-replayable` retain their existing delivery
profiles, independently of worker admission. A read-only subscribe defaults to
`existing-only` for both modes, including a cold terminated session; an explicit
new-session or attach action may request `start-if-needed`. Desktop receives
live online frames when a Host is already attached, while replayable clients use
snapshot/recovery frames and gap repair. Both profiles still use the same decoder
and authoritative sequence; they do not create a second transcript owner.
Offline or stale state is never converted into completed state. Capability and
target checks are performed by the Host before admission; the transport only
routes typed results.

A `session.error` or `send` receipt may carry the key-free `AgentModelFailure`
(for example `provider-reconfigure-required` after a 401). The projection copies
it into `control.lastError.failure`, and the V4 `CommandAck` has the same
optional `failure` field for the receipt. Both reuse the shared strict schema;
older servers omit the field and older clients drop it. An untyped error leaves
`lastError` unchanged with no `failure` key, and a later untyped error replaces
an earlier typed one. Because the projection is rebuilt from the journal, cold
reads return the same `failure` as live reads.
