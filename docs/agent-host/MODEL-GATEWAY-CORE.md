# Model Gateway core seam (v0.3 foundation)

The target-local gateway is an opt-in transport adapter to the existing `@zcode/contracts` Model executor, not a new Provider client or a Harness/session owner. It exposes only injected, fixed protocol routes; codec owners decode/encode native protocol details. This foundation does not certify a native CLI, provider, auxiliary endpoint, remote deployment, or non-stream call.

## Ownership and public interface

`createModelGateway({ protocols, resolveModel, limits, observe? })` owns the loopback HTTP listener, random credentials, immutable turn binding, counters and active cancellation controllers. `start()` returns a local ephemeral `url` and `port`, `issueToken(binding)` returns the bearer string, `revokeToken(token)` revokes immediately, `close()` revokes/aborts and closes the listener. Callers own target/Harness lifetime and supply a resolver bound to the existing Model executor. `GatewayTokenBinding` fixes targetId, hostSessionId, runtimeEpoch, turnId, protocol, requestedModelAlias, effectiveSelection, expiresAt (epoch milliseconds), maxRequests and maxOutputBytes. `GatewayLimits` fixes maxBodyBytes and maxConcurrentRequests; budgets must be positive finite integers. Tokens never contain Provider secrets or upstream URLs. The resolver receives only the server-held binding and must return exactly its effective providerId/modelId. The model alias is a CLI-visible name, not a Provider choice.

Codec contract is `GatewayProtocolAdapter` with `id`, fixed `paths`, `decode(body, headers): { request: ModelRequest; modelId: string; stream: true }`, and `encode(events: AsyncIterable<ModelEvent>, context): AsyncIterable<{ event?: string; data: unknown }>`. These are public `@zcode/contracts` model types. Codec validation errors can carry `statusCode` 400/422 and a stable `code`; only approved status/code are emitted, never raw errors. Core enforces auth, size, route, alias, resolver identity and streaming before invoking Model. Unknown auxiliary endpoints are explicit `unsupported_endpoint` (404); clients cannot provide URL or alternate Provider route through query/cookies/headers.

## Event order and failure semantics

```text
caller freezes selection + epoch + turn → gateway issues server-held token
CLI POST → route/credential/budget admission → bounded JSON decode → alias check
  → resolve existing Model + identity check → streamText with abortSignal
  → codec encode → bounded SSE writes + drain backpressure → release slot
revoke/expiry/client drop/close → abortSignal → iterator return/teardown
```

Per-token request admission is single-owner and increments once after validation, before resolver invocation. Concurrency slots cover read, resolver and streaming. Output limit is a per-token aggregate of actual serialized SSE bytes, not estimated token usage; an over-limit frame is not written, and the core emits a bounded terminal error if capacity permits, otherwise closes the stream. Post-header failures are terminal `event: error` SSE with a redacted stable code; cancellation never emits a success terminator. The transport has no replay or persistence: host runtime retains epoch/turn ownership and revokes stale bindings. Desktop continuous and mobile replayable delivery remain Host responsibilities, not gateway streams. A closed gateway cannot restart or issue credentials.

Tests: real HTTP to injected fake Model/codec for successful route, wrong route/token/alias, epoch-bound revocation, expiry, body/concurrency/request/output limits, client drop/revoke/close cancellation, post-header error SSE and listener teardown. No paid model calls or live SSH in this foundation.
