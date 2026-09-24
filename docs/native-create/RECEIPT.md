# Native V4 create receipt

Owner: CLI CommandInbox admits global `createSession`; CLI SQLite session store owns the immutable original native session ID and the create receipt. A caller's connection/client ID, issuedAt, and delivery mode are transport metadata, not create intent. The canonical fingerprint covers parsed workspace identity and every immutable payload field (including config, model, MCP, first input and attachments); raw intent is never copied into the receipt. A command ID reused with another fingerprint or workspace is rejected before executing a second create. Query has no intent and is read-only; callers must validate target binding/scope independently before mapping it.

```
V4 command → CommandInbox global key gate → materialize CLI record
  → SQLite BEGIN IMMEDIATE → session row + immutable command receipt → COMMIT
  → config → first-input admission/promotion → ACK
retry → lookup immutable receipt → same original ID (never execute again)
query → immutable receipt + input state (no mutation)
Core absent-worker recovery → read-only SQLite metadata view → validate DB/scope → original ID
```

No-input creates must not synthesize a user turn. A committed create with first input but no promoted input is *not proof of input completion*: distinguish `inputPending` and `inputPromoted`; no blind retry of the input. An admitted input is discarded only in explicit CLI startup/resume recovery, never on commands/query. Existing fork/side-session facts remain separate. Before transaction failure leaves no receipt/session; after commit before ACK returns the same ID. Ambiguous/partial/missing schema/database/scope yields unknown to read-only callers. Desktop continuous and mobile replayable callers share the same CLI fact, independent of transport IDs. No read-only access migrates or creates a database.

Acceptance: real SQLite transaction fault before commit; committed retry and conflicting intent; CLI stdio process restart after lost ACK; firstInput live query cannot cancel input; restart query cannot report pending as promoted; session count one; read-only metadata under wrong scope fails; no model/tool call on draft-only create. Root gates typecheck/lint and public package builds.

## Recovery boundary

The receipt is initially `pending`. After runtime configuration and first-input admission the CLI transitions it to `completed` before returning ACK. Crashes during the non-atomic runtime/config/input portion leave a pending receipt and original row: retry/query must expose the original ID with an explicit pending failure, **never** re-run first input. The read-only metadata view returns unknown for pending receipts and for completed receipts whose first input has not been promoted. Config failure follows existing best-effort policy (default model remains); it is not a claim that the requested model was applied. A draft-only create now has a persisted session row by design, even while the runtime/publisher remains deferred; cold-index consumers must not interpret existence as evidence of a user input. A query in a live worker must not discard admitted input; on a cold worker admitted input is pending/unknown until actual startup/session recovery discards it via its existing owner.
