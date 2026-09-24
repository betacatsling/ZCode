# Authenticated desktop attachments (pass 1)

Default OFF. Desktop user consent, not a renderer claim, creates one expiring one-use challenge with bounded attempts. Successful phone proof creates a revocable principal scoped to one existing window Host generation and exact workspace identity/path. Browser Origin and CSRF/session binding are mandatory. Nonloopback ingress requires TLS/WSS; isolated loopback tests may use HTTP. Pairing credentials must never appear in URLs, process args/env or logs. No fallback to anonymous Core RPC. Revocation/window close/Host replacement closes current view lease and denies subsequent input; it does NOT terminate Core tasks. Main/relay owns authorization and attachment metadata only; Host/Core own accepted commands, journal and replay cursor. A new generation requires explicit reauthorization.

```text
consent -> challenge -> approved principal -> current window Host attachment
                                           -> existing Core session/journal
revoke / generation rotation -> detach view -> deny stale commands; Core task continues
```

Mobile uses `web-remote-replayable` snapshot/gap repair; desktop uses `desktop-continuous`. Accepted command is admitted once by Core. Reconnect must use the same request/ID, never automatically resubmit. Reject unpaired, expired, reused, mismatched origin/window/path/identity/generation before invoking Core; fail closed if Host unavailable. Approval wait is the same request; denial cannot replay it.

Remote Native create: authenticated Host registry must resolve exact remoteSessionId + workspacePath + workspaceIdentity and validate online ready generation before dispatch to that target Core's hierarchy; after await a changed lease is uncertain, query stable command ID read-only, never automatic resend. Remote target Core uses its own local CLI, not SSH to itself. Plain scope metadata crosses public RPC; Services/callbacks stay Node. Two identities with same path must never route into each other; stale provenance is history, not current authority. Native production flag remains OFF until joined evidence.

Acceptance needs actual separate mobile browser → authorized transport → same Host/Core, active-port revoke, replay during continuing producer, A/B/desktopC regressions and two-identity registry tests. A security policy or isolated helper alone is not acceptance. No user credentials, network provider or external relay are used in fixtures.

Build invariant: `ZCODE_DESKTOP_BUILD_PART` unset preserves four normal configs; main|preload|host|scheduler picks exactly one; invalid (including empty) rejects before build. All four parts must be run serially for a complete Desktop build under the shared memory slot. Historic four-parallel build remains unqualified.
