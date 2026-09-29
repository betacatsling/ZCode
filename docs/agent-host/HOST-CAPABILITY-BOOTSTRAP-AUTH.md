# Host capability bootstrap authentication (M2)

Status: implemented for issuance in this cut. Ticket binding and consume-side
hardening are deferred (see "Deferred").

Requirement: `docs/PROJECT-DELIVERY-PLAN.md` §4 M2 risks and the §5 security row
("reject unauthorised Host/Web access"). Before this change, both HTTP servers
issued a trusted Host ticket to any caller that could reach them:

- Server Core `packages/zcode-server-cli/src/server-core/http.ts`:
  `POST /api/rpc-host-capability` called `capabilities.issue()` directly. The
  only guard was the loopback-only listen check, and it reported
  `authRequired: false`.
- Legacy server `packages/server/src/http.ts`: same route. It was protected only
  when `authToken` was configured, and then the browser cookie or `?token=`
  lite token was enough.

A ticket (`{capability, expiresAt}`, 30 s TTL, single use, stores in
`packages/server/src/hostCapability.ts` and
`packages/zcode-server-cli/src/server-core/hostCapability.ts`) upgrades
`/ws/host` to `desktop-continuous` / `trusted-host-relay`. That role gets
`IAgentHostService` and `IProviderProvisioningTargetService`: it can create or
dispatch Host sessions, read history, and write cross-environment Provider
credentials.

## Threat model

Being able to reach the loopback port does not identify the caller. Attackers
in scope:

| Attacker                                                                               | Why loopback does not stop it                                                                                                                                                                            |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Another local OS user or a sandboxed process on the same machine                       | `127.0.0.1:<port>` is reachable by every local user. Core ports are ephemeral, but the scan space is small.                                                                                              |
| SSH tunnel or port forward                                                             | `ssh -L` exposes the remote Core on the local machine's loopback. Anyone who can reach the forwarded port (a shared jump host, `GatewayPorts`, other local users) becomes "loopback" to the remote Core. |
| Browser: cross-origin `fetch`/form POST to `http://127.0.0.1:<port>` from any web page | The browser runs on the same machine. A simple POST needs no CORS preflight, and the JSON response is unreadable, but a side-effecting request would still run.                                          |
| Browser: DNS rebinding (`evil.example` → `127.0.0.1`)                                  | The request becomes same-origin for the attacker's page, so the ticket response can be read, and it carries `Host: evil.example:<port>`.                                                                 |
| Same-site page on another localhost port                                               | `SameSite=Lax` cookies (the legacy `zcode_lite_token`) are sent. Ports do not change "site".                                                                                                             |

Not in scope: an attacker running as the same OS user (they can already read
`~/.zcode`, the provider config and the process memory), root/admin, or a
compromised Desktop main process.

## Legitimate callers today

Found with `git grep rpc-host-capability` / `connectToPersistentTarget`:

1. Desktop, local target. Main
   (`packages/desktop/src/main/persistentDesktopTarget.ts`) spawns the bundled
   `server-cli.js serve --daemon --json`, parses its stdout with
   `serverStatusSchema`, and passes the endpoint to the Host utility process in
   `InitLocal.persistentTarget` (`packages/desktop/src/main/index.ts`, schema
   `packages/shared/src/validation.ts`). The Host
   (`packages/desktop/src/host/index.ts`) calls `connectToPersistentTarget`
   (`packages/server/src/remote/persistentTargetClient.ts`).
2. SSH persistent target. `connectPersistentSSH`
   (`packages/server/src/remote/connect.ts`) runs `... serve --daemon --json`
   over the SSH exec channel, opens a local port forward, then calls
   `connectToPersistentTarget`.
3. `packages/zcode-server-cli/scripts/verify-remote-ssh.mjs`: manual end-to-end
   verification over `ssh -L`.
4. Tests: `runtimeLifecycle.integration.test.ts`,
   `persistentDesktopTarget.integration.test.ts`,
   `persistentTargetClient.test.ts`, and the legacy `hostCapability.wsHost.test.ts`.

No renderer, Web UI, or CLI TUI code calls the endpoint. Every legitimate caller
is a Node process that already has a private channel to the Supervisor: a
spawned child's stdout, or an authenticated SSH exec channel.

## Mechanism

A per-Core-launch private bootstrap secret, presented as `Authorization: Bearer`.

1. **Generation.** `runServerCore` (`server-core/core.ts`) generates
   `randomBytes(32).toString("base64url")` (43 chars) on every Core launch and
   passes it to `createCoreHttpServer({ hostBootstrapToken })`. If the option is
   omitted, the server generates its own secret, so the endpoint never runs
   unauthenticated. A malformed configured secret is refused at startup.
2. **Delivery (private channels only).**
   - Core → Supervisor: in the `ready` message over the fork IPC channel
     (`coreMessageSchema.ready.hostBootstrapToken`, `contracts.ts`). It is never
     placed in the environment, so Agent/tool children spawned by Core do not
     inherit it.
   - Supervisor → clients: `ServerStatus.hostBootstrapToken` (optional). It is
     available through the control socket (runDir `0700`; named pipe on
     Windows) and through `run/status.json`. That file is written `0600` via an
     atomic rename, and the Supervisor now also `chmod 0700`s an existing
     runDir on POSIX. `serve --daemon --json` prints it: to the spawning Desktop
     Main over a pipe, and to the SSH connector over the exec channel. Main
     passes it to the Host over the utility-process `InitLocal` message (never
     to the renderer). Human-readable `zcode status` redacts it.
   - `clearCoreScopedStatus()` drops it whenever the Core exits, crashes or is
     replaced. The next generation publishes a new one, so old secrets stop
     working (asserted in `runtimeLifecycle.integration.test.ts`).
3. **Verification.** `verifyHostBootstrapRequest`
   (`hostBootstrapAuth.ts`, one copy in each package) checks, in this order:
   - Any `Origin` header → **403**. Real callers are Node. Browsers always send
     `Origin` on cross-origin POSTs, and `Authorization` also forces a CORS
     preflight, which is never answered.
   - Core only (and the legacy server when bound to loopback): a `Host`
     authority that is not `127.0.0.1` / `localhost` / `[::1]` (optional port)
     → **403**. This blocks DNS rebinding. SSH forwards still present
     `127.0.0.1:<local port>`.
   - No configured credential → **401**. This only happens on the legacy server
     with neither option set.
   - Missing, garbage (non-`Bearer <1..1024 visible ASCII>`), wrong-length or
     wrong secret → **401**. Comparison is `timingSafeEqual(sha256(expected),
sha256(presented))`, which runs in constant time whatever the length. When
     several credentials are configured, all of them are compared.
   - Rejection never calls `issue()`. Every response sets
     `Cache-Control: no-store`.
4. **Client.** `connectToPersistentTarget({ hostBootstrapToken })` sends the
   Bearer header only to `POST /api/rpc-host-capability`, never to
   `/api/server-info` or to the `/ws/host` upgrade (asserted in
   `persistentTargetClient.test.ts`).
5. **`authRequired`.** Both servers now report `true`, because the privileged
   Host bootstrap always needs an out-of-band credential. No in-repo client
   branches on this field today. The Core's `/ws` (terminal-client, Host
   channels excluded) and `/api/server-info` stay loopback-open.

### Legacy server mapping (`packages/server/src/http.ts`)

- The accepted credentials are `hostBootstrapToken` (new option) and/or
  `authToken`. `authToken` is the operator-configured secret that already
  grants all of `/api` and `/ws`, so presenting it as a Bearer header also
  bootstraps. With neither option set, issuance is closed (401) instead of open.
- The lite token middleware now skips the capability path, which enforces its
  own stricter rule: the cookie and `?token=` query carriers do **not** mint
  tickets, because they are what a same-site browser page would carry. All
  other `/api` and `/ws` paths behave as before.
- The `Host` header check applies only when `options.host` is loopback. When
  bound to other interfaces, the credential is the only defence and the
  `Origin` check still applies.
- New `hostCapabilityStore` option, mirroring Server Core, so tests can inject
  a store. Without it, each server still creates a fresh TTL store.
- `authRequired` no longer reads the mismatched `ZCODE_SERVER_TOKEN` env var
  (`entry-http.ts` uses `ZCODE_SERVER_AUTH_TOKEN`).

## Migration and compatibility

| Client → Server                                                                                                          | Result                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New client, new Supervisor + new Core                                                                                    | Secret flows. Ticket issued.                                                                                                                                                            |
| New client, old running Supervisor + old Core (Desktop upgraded while a service-registered Supervisor keeps running)     | Status has no secret, so the client sends no header, and the old Core does not check. Works.                                                                                            |
| New or old client, **old Supervisor + new Core** (in-place `apply-update` of the Core release under a pre-M2 Supervisor) | The old Supervisor's `ready` schema strips the unknown field, so status has no secret and the new Core returns **401**. **Known gap:** Host attach fails until the Supervisor restarts. |
| Old Desktop CLI reading a new status (`.strict()` schema)                                                                | Rejected as invalid status. Desktop always uses its own bundled CLI, so this happens only in manual mixed-version setups. The SSH parser is lenient.                                    |
| Remote `bin/zcode` older than the Desktop (SSH path without a staged runtime)                                            | Old Core, no enforcement. Works.                                                                                                                                                        |

Options to close the skew gap (Planner decision): (a) Core also writes a `0600`
`run/core-host-bootstrap.json` keyed by generation and port, and the new CLI
merges it into `serve/status --json` when the Supervisor status lacks it; or
(b) require a Supervisor restart as part of the first post-M2 update. This cut
implements neither.

## Deferred (tracked, not fixed here)

- **Tickets are unbound bearer tokens (Ex4 finding).** A ticket is only
  `{capability, expiresAt}`. Whoever holds it within 30 s becomes a trusted
  Host, whatever the client, scope or generation. This cut makes _obtaining_ a
  ticket require the private secret, but does not bind the ticket itself.
  Binding options:
  1. _Bind to the bootstrap credential._ `issue()` stores
     `sha256(bootstrap secret)`, and the `/ws/host` upgrade must present the
     same Bearer secret alongside the ticket. A leaked ticket alone is then
     useless. This is the recommended next step, but it changes the consume
     path owned by Ex4.
  2. _Proof of possession._ The client sends `sha256(nonce)` at issuance and
     the nonce at upgrade. This binds the ticket to the one requesting process
     without sending the secret twice.
  3. _Bind to runtime generation._ Stamp the Core generation and reject on
     mismatch. Today the stores are process memory, so a restart already
     invalidates tickets. This matters only if the stores become shared or
     persistent.
  4. _Bind to scope._ The ticket names the target ID and the intended role or
     workspace scope, and `/ws/host` grants only that scope. This needs a
     service-level scoped channel API.
  5. _Bind to connection origin_ (peer address). Weak: every caller, including
     SSH forwards, appears as loopback.
- **Burn on non-upgrade or failed handshake (Ex4 finding, low risk).** The
  `/ws/host` middleware consumes a ticket before knowing whether the request is
  a WebSocket upgrade, or whether the handshake completes. A plain GET/POST, or
  an upgrade rejected by a later layer, burns the ticket. That is fail-closed
  (a DoS against oneself only).
- **Duplicated store logic (Ex4 finding, drift risk).** `hostCapability.ts` and
  now `hostBootstrapAuth.ts` exist in both `packages/server` and
  `packages/zcode-server-cli`. The dependency boundary forbids importing
  `@zcode/server` from server-cli. Candidate home: a Node-only subpath of a
  shared package. Until then, the two `hostBootstrapAuth.ts` copies are
  byte-identical and must be changed together.
- Windows: `chmod` is a no-op, so status.json confidentiality relies on the
  per-user profile ACL and the named-pipe control endpoint.
- The secret rotates only per Core launch, not per ticket or on a timer.
- The Core's `/ws` terminal-client and `/api/server-info` stay unauthenticated
  on loopback.

## Tests

- `packages/zcode-server-cli/src/server-core/hostCapabilityBootstrapAuth.test.ts`:
  missing, wrong, garbage and wrong-length credentials → 401; `Origin` and
  non-loopback `Host` → 403, even with the valid secret; valid secret → ticket
  that opens `/ws/host`; secret generated per server; weak secrets refused;
  `authRequired: true`. Each rejection asserts `issue()` was not called.
- `packages/server/src/hostCapabilityBootstrapAuth.test.ts`: closed when
  unconfigured; `authToken` accepted only as Bearer (cookie and query → 401);
  both credentials accepted; `Origin` and `Host` → 403; injected store is used.
- `packages/server/src/remote/persistentTargetClient.test.ts`: the secret is
  sent only to the capability endpoint; a missing secret surfaces the 401.
- `runtimeLifecycle.integration.test.ts`: the real Supervisor/Core path uses the
  status secret; after a Core crash, the previous generation's secret gets 401.
