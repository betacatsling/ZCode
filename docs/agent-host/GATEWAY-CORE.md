# Gateway core hardening (P5 boundary)

The gateway owns only loopback HTTP transport and live per-token state, not the Host turn, catalog or model registry. The caller supplies a **prepared Host-turn Model** through `resolveModel(binding)`; `issueToken(binding): Promise<string>` awaits it once, validates providerId/modelId and the effective reasoning option, and stores that exact instance and its bound `streamText` method with the token. Request handling never consults the registry. If issuance races shutdown or expiry it fails without issuing a credential. A revoked token cannot run queued or active work.

`GatewayTokenBinding` adds positive `maxGenerationTokens` (aggregate reservation budget) and `maxOutputTokensPerRequest` (hard per-call ceiling). Both are required. Every authenticated POST to a permitted route consumes one `maxRequests` admission synchronously before any body read, even if JSON, alias or size validation fails. Concurrent limit rejects do not consume request admission. An explicit client `maxOutputTokens` must be a positive safe integer no greater than the per-call ceiling and remaining aggregate; omission gets the bounded minimum of both. Reservations happen synchronously before model invocation, never refund (including errors/cancellation), so concurrent calls cannot exceed aggregate generation allowances. Bytes remain an independent serialized-SSE aggregate cap. Clients cannot change bound reasoningLevel or model identity. Model execution receives the fixed reasoningLevel and reserved maxOutputTokens through existing `ModelRequest.options`.

`GatewayProtocolAdapter.allowedQueryParameters?: Readonly<Record<string, readonly string[]>>` declares exact allowed key/value pairs per protocol (for example Messages `beta=true`). Raw `IncomingMessage.url` pathname must exactly match a registered path; no URL normalization, duplicate params, unknown params, fragments, credential-like params, or alternate routes. Existing request headers pass unchanged to codec validation. Unspecified HEAD and auxiliary endpoints fail closed.

```text
Host prepared turn → issueToken awaits Model and freezes binding/identity/options → live token
POST → raw route + auth → concurrency slot + atomic request reservation → bounded body + codec
     → alias/options validation + atomic generation reservation → stored Model.streamText(signal)
     → codec iterator + bounded SSE/drain → slot release
revoke / expiry / drop / close → abort signal + destroy response + iterator return → release
```

A cancelled or failing codec/model must not leak upstream errors, request body, or secrets. Pending body reads and streams share the same controller. The gateway never persists/replays: desktop continuous and mobile replayable ownership remain in Host. Acceptance uses real local HTTP delayed chunked bodies, aggregate concurrent reservation, identity/options drift, exact query acceptance/rejection, invalid-body budget, backpressure and teardown; no live Provider or real credentials.
