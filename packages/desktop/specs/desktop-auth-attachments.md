# Authenticated desktop attachments (pass 2, staged; phone transport not implemented)

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

## Pass 2 consent authority and failure matrix (staged state machine; no production Main caller yet)

Main is sole owner of ephemeral challenge, device credential, authorization records and active view leases. A desktop-initiated consent action (never a phone-initiated approval) binds a single existing window ID, its current Host process identity, exact workspace path and `identity?.trim() || path`, and a fixed allowed browser Origin. Pair challenge is one-use, expires after 2 minutes, and fails closed after 5 failed attempts. The challenge is shown only on the consenting desktop, never in a URL or log. It is exchanged over a body-bearing same-Origin channel; successful exchange returns a revocable opaque device secret to the browser (memory only). Subsequent attach uses an Origin-bound proof in the request body/header, not query parameters or cookies. Main checks both credentials and _current_ Host identity immediately before creating each attachment. Credential rotation invalidates old leases and challenge. Revoke and window/Host close tear down live ports, without stopping Core work. Default startup OFF; never bind non-loopback HTTP unless TLS/WSS is configured, no anonymous fallback.

```text
Desktop consent → Main challenge [window, Host, path, identity, origin]
 phone proof → Main principal/credential → Main validate again → Host AttachServicePort(local, web-remote-replayable)
 Host → existing Core-owned journal/queue; browser reconnect → fresh scoped view/snapshot + gap repair
 revoke/Host change → close active view/credential; Core task still runs
```

The consent state machine is deliberately NOT wired to any user-facing command or browser endpoint yet. Main does not call `beginConsent` and no scoped service port is created for it; this isolated validator is not an authorized phone connection. Existing Host local service channels are window-wide and do not yet enforce per-workspace restrictions for every RPC method. A browser bridge must not be enabled until this boundary is enforced at Host and the production desktop approval UI supplies the trusted window/workspace facts.

RED cases: disabled refuses; wrong origin/challenge/window/identity/Host/expired/replayed attempts reject before `AttachServicePort`; valid pair returns same window Host; credential rotation and revoke terminate current view and future attach; path collision with distinct identities rejects. These are security-unit tests only. The full joined phone/browser/Core acceptance additionally requires real browser transport, desktop consent UI, held producer/replay, and A/B/C regression; unit tests must not be called joined acceptance.

## Trusted remote create view route (Host-only)

On a remote-scoped Host attachment, hierarchy create is dispatched using that attachment's captured registry generation, exact path/identity/session and _current_ target `ServiceCollection`. `remoteWorkspaceServiceCollection` must register the target accessor's existing public hierarchy channel, never local `activeServices` or a newly constructed remote Host. Only the target's own hierarchy factory may allocate, using its local CLI. The remote connection registry must validate before the effect and after its await; if generation changes or the effect throws after attempted admission, return an uncertainty error, not a new command. A committed result must match the requested workspace ID and current attachment's path, identity and session; a foreign result is uncertain, not writable. The UI retains its stable command ID for explicit read-only recovery; do not replace it with remoteSessionId. Scope and generation are never accepted as renderer authentication. Existing local hierarchy is unchanged. This routing guard is not proof that the Services owner has implemented the optional scope contract or that Native creation works on remote Core; independent actual factory/CLI evidence remains mandatory.
