# Host capability bootstrap authentication (M2)

Status: implemented for issuance, including the old-Supervisor + new-Core skew
fallback ("Version-skew fallback"). Tickets are consumed only when the
`/ws/host` upgrade is accepted, and both servers share one store ("Ticket
consume-on-upgrade"). Ticket binding is deferred (see "Deferred").

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

A ticket (`{capability, expiresAt}`, 30 s TTL, single use; one shared store in
`packages/shared/src/node/hostCapabilityStore.ts`, see "Ticket
consume-on-upgrade") upgrades `/ws/host` to `desktop-continuous` /
`trusted-host-relay`. That role gets
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
   - Core → CLI, skew fallback only: the Core also writes
     `run/core-host-bootstrap.json` (`0600`). The new CLI reads it only when the
     Supervisor status lacks the secret. See "Version-skew fallback".
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

### Ticket consume-on-upgrade

A ticket is consumed only when the `/ws/host` WebSocket upgrade is accepted, not
when the request first arrives. Both servers wire the same gate
(`createHostCapabilityUpgradeGate`) in the same two places:

1. **HTTP middleware on `/ws/host` (`admit`, never consumes).** It runs for
   every method, in the order below:
   - Missing, unknown or expired ticket → **401**. The check is
     `store.peek()`, which is non-consuming. It purges expired entries, so an
     expired ticket stays dead even if the clock later rewinds.
   - Not a WebSocket upgrade → **426** with `Upgrade: websocket`. A
     WebSocket upgrade here means `Upgrade: websocket` plus a
     `Connection: upgrade` token, which is exactly what makes Node route the
     request to the `upgrade` event. This covers plain `GET`/`POST`/`PUT`/`DELETE`
     and an `Upgrade` header without `Connection: Upgrade`.
   - Otherwise the Node `IncomingMessage` is remembered with its ticket in a
     `WeakMap`, and the request continues to `upgradeWebSocket`.
2. **Consume point: the `ws` server's `verifyClient` (`attach`).** `ws` calls it
   only after it has validated the handshake: method `GET`,
   `Sec-WebSocket-Key`, `Sec-WebSocket-Version`, and subprotocol and extension
   headers. It runs synchronously, right before `101 Switching Protocols` is
   written. Only here is `store.consume()` called, which deletes the ticket
   whatever the result. If it returns `false` (replayed, expired, or already
   won by a concurrent upgrade), `ws` answers **401** and never sends 101.
   Requests without a remembered ticket pass through (the plain `/ws` route).
   A defensive check rejects an unremembered request whose path is exactly
   `/ws/host`.

Resulting semantics, identical on both servers:

- A request that never reaches an accepted handshake does not burn the ticket.
  This covers non-upgrade requests, a malformed handshake (400), a `POST`
  upgrade (405, because `@hono/node-ws` routes every upgrade as `GET` and `ws`
  refuses the method), wrong paths such as `/ws/host/` or `/ws/host/extra`
  (404), and requests the lite-token middleware rejects.
- Invalid and expired tickets are still rejected (401).
- A ticket is still single-use. Replaying it after a successful upgrade gets 401.
- Concurrent upgrades with one ticket: exactly one gets 101, and the others get
  401 before 101. JavaScript runs `verifyClient` one call at a time, so the
  consume is atomic.
- Remaining edge: if the client has already half-closed its socket when
  `verifyClient` returns, `ws` destroys the socket after the ticket was
  consumed. Only that client's own ticket is lost.

`HostCapabilityStore.peek` is optional for injected stores, so the legacy
`hostCapabilityStore` option keeps accepting `{issue, consume}`. Without
`peek`, an invalid ticket is refused at the consume point (401) instead of in
the middleware.

**Shared location.** `packages/shared/src/node/hostCapabilityStore.ts`,
exported from the Node-only subpath `@zcode/shared/node`. Both
`packages/server` and `packages/zcode-server-cli` already depend on
`@zcode/shared`, so no new dependency edge was added. The subpath is
Node-only, because the store uses `node:crypto`, and it is never imported by
renderer or browser bundles. The gate talks to the `ws` server through a
structural type, so `@zcode/shared` does not depend on `ws`.
`packages/server/src/hostCapability.ts` and
`packages/zcode-server-cli/src/server-core/hostCapability.ts` are now plain
re-exports that keep the historical import paths. `@zcode/server` could not
host the store, because the dependency boundary forbids server-cli from
importing it. Services was avoided because other teams are actively changing it.

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
  a store. Without it, each server still creates a fresh TTL store. The
  consume-on-upgrade gate applies to injected stores too.
- `authRequired` no longer reads the mismatched `ZCODE_SERVER_TOKEN` env var
  (`entry-http.ts` uses `ZCODE_SERVER_AUTH_TOKEN`).

## Migration and compatibility

| Client → Server                                                                                                      | Result                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New client, new Supervisor + new Core                                                                                | Secret flows. Ticket issued.                                                                                                                                                                                             |
| New client, old running Supervisor + old Core (Desktop upgraded while a service-registered Supervisor keeps running) | Status has no secret, so the client sends no header, and the old Core does not check. Works.                                                                                                                             |
| New client, **old Supervisor + new Core** (in-place `apply-update` of the Core release under a pre-M2 Supervisor)    | The old Supervisor's `ready` schema strips the unknown field, so its status has no secret. The new CLI fills it from the Core-written `run/core-host-bootstrap.json` (see below). Ticket issued.                         |
| Old client, old Supervisor + new Core                                                                                | The old CLI does not read the file, so the new Core returns **401** until the Supervisor restarts. Desktop runs its bundled CLI and the SSH connector runs the staged runtime's CLI, so this needs a manual mixed setup. |
| Old Desktop CLI reading a new status (`.strict()` schema)                                                            | Rejected as invalid status. Desktop always uses its own bundled CLI, so this happens only in manual mixed-version setups. The SSH parser is lenient.                                                                     |
| Remote `bin/zcode` older than the Desktop (SSH path without a staged runtime)                                        | Old Core, no enforcement. Works.                                                                                                                                                                                         |

### Version-skew fallback: `run/core-host-bootstrap.json`

Planner option (a). The alternative, (b) forcing a Supervisor restart on the
first post-M2 update, was not taken. Code:
`packages/zcode-server-cli/src/runtime/coreHostBootstrap.ts`.

- **Location.** `<serverRoot>/run/core-host-bootstrap.json`
  (`ServerLayout.coreHostBootstrapFile`, next to `status.json`). The Core finds
  the server root through `ZCODE_SERVER_ROOT`, which every Supervisor launcher
  in the repository history (pre-M2 included) sets for the Core. Without it
  (embedded or test Cores), no file is written.
- **Format.** A strict JSON object:
  `{schemaVersion: 1, generation, pid, host, port, hostBootstrapToken, createdAt}`.
  `generation` is the Supervisor-assigned argv generation. `pid`, `host` and
  `port` are the Core's own, which are the same values the Supervisor publishes in
  `ServerStatus`.
- **Write.** `runServerCore` writes the file after the HTTP server listens and
  **before** it sends `ready`, so any status that says `ready` for this
  generation already has its file. The write creates the runDir `0700` and
  `chmod`s an existing one to `0700` on POSIX (a pre-M2 Supervisor never
  tightens it). It writes a unique temp file with `0600` and `wx`, `chmod`s it to
  exactly `0600`, then renames it over the target. A failed write is logged and
  does not block startup, because the new-Supervisor path does not need the file.
- **Removal.** On clean shutdown, after the HTTP server closes, the Core removes
  the file, but only if it still names this Core's generation and pid. A crash
  or `SIGKILL` leaves it behind, and the next generation overwrites it before its
  own `ready`. Uninstall clears `run/`.
- **Merge rules.** `serve --json` covers the already-running, freshly started and
  foreground paths. Desktop Main and the SSH connector read this output.
  `status --json` covers the control socket and the `status.json` fallback. Both
  call `mergeCoreHostBootstrapToken`, which adds the file's secret only when all
  of these hold:
  1. The Supervisor status has no `hostBootstrapToken`. A Supervisor-provided
     secret always wins.
  2. `state === "ready"`, and `pid`, `host` and `port` are non-null.
  3. On POSIX, the file is opened with `O_NOFOLLOW`. Through the opened handle it
     must be a regular file of at most 4 KiB, with mode exactly `0600`, owned by
     the current uid.
  4. It parses under the strict schema. Malformed JSON, an unknown
     `schemaVersion`, extra keys or a bad token shape mean it is ignored.
  5. `generation`, `pid`, `host` and `port` all equal the status values. A record
     from a previous generation or port is stale and is ignored.
  6. The pid is alive (`kill(pid, 0)`). `EPERM` counts as not ours.

  Only the secret is added to the printed status. Nothing else changes.
  Human-readable `zcode status` still prints `[redacted]`. The secret still never
  enters the environment, the renderer or logs.

- **Why this is safe.** The file holds the same secret with the same
  confidentiality as `status.json` (`0600` in a `0700` runDir, same OS user). A
  stale file's secret is useless, because each Core generation generates its own
  secret, and the old secret gets 401 from the new Core.

## Deferred (tracked, not fixed here)

- **Ticket binding to the bootstrap credential.** At issue, record the
  credential's fingerprint and the generation. Verify both at the `/ws/host`
  consume. Reject tickets issued before a credential rotation. Owned by Ex2 as
  the next slice after the shared store. Today a ticket is only
  `{capability, expiresAt}`: whoever holds it within 30 s becomes a trusted
  Host, whatever the client, scope or generation. This cut requires the private
  secret to _obtain_ a ticket, but does not bind the ticket itself. The consume
  point is now the single shared `verifyClient` gate, so binding lands in one
  place. Binding options:
  1. _Bind to the bootstrap credential._ `issue()` stores
     `sha256(bootstrap secret)` and the generation. The `/ws/host` upgrade must
     present the same Bearer secret alongside the ticket, and a mismatch is
     rejected. A leaked ticket alone is then useless. This is the planned next
     slice.
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
- **Duplicated bootstrap verification.** The ticket store is shared now
  ("Ticket consume-on-upgrade"), but `hostBootstrapAuth.ts` still exists in
  both `packages/server` and `packages/zcode-server-cli`. The two copies are
  byte-identical and must be changed together. It could move to
  `@zcode/shared/node` the same way.
- Windows: `chmod` is a no-op, so the confidentiality of `status.json` and
  `core-host-bootstrap.json` relies on the per-user profile ACL and the
  named-pipe control endpoint. The reader skips the mode and uid checks there.
- The skew fallback file can be removed once pre-M2 Supervisors are no longer
  supported, meaning every running Supervisor forwards `ready.hostBootstrapToken`.
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
- `hostCapability.wsHost.test.ts` in both `packages/server/src` and
  `packages/zcode-server-cli/src/server-core` run the same consume-on-upgrade
  matrix against each server:
  - plain `GET`/`POST`/`PUT`/`DELETE` → 426, and an `Upgrade` header without
    `Connection: Upgrade` → 426;
  - `Sec-WebSocket-Version: 7` or a missing or malformed `Sec-WebSocket-Key`
    → 400, and a `POST` upgrade → 405;
  - wrong-path upgrades are refused;
  - after each of these, the ticket still upgrades once and then gets 401 on
    replay;
  - unknown and expired tickets → 401 before the upgrade check (the legacy
    variant goes through the `hostCapabilityStore` option);
  - after a failed handshake, 4 concurrent upgrades with the ticket admit
    exactly one, and the other three get 401.
- `packages/server/src/remote/persistentTargetClient.test.ts`: the secret is
  sent only to the capability endpoint; a missing secret surfaces the 401.
- `runtimeLifecycle.integration.test.ts`: the real Supervisor/Core path uses the
  status secret; after a Core crash, the previous generation's secret gets 401.
- `packages/zcode-server-cli/src/server-core/hostBootstrapSkew.integration.test.ts`:
  a real Supervisor with a Core whose `ready` passes through the pre-M2 schema
  (`fixtures/preM2SupervisorCoreEntry.ts`). The status has no secret and the
  Core returns 401. `status --json` and `serve --daemon --json` merge the file,
  a ticket is issued and `/ws/host` attaches. Human `status` redacts the secret.
  After a Core crash the file is replaced by the new generation, and the old
  secret gets 401. A planted previous-generation record is not merged. A clean
  stop removes the file.
- `packages/zcode-server-cli/src/runtime/coreHostBootstrap.test.ts`: atomic
  `0600` write and `0700` runDir tightening; merge only for a matching, live,
  ready Core; the Supervisor token wins; stale generation, port, host or pid,
  and a dead pid, are ignored; missing and malformed files are ignored;
  non-`0600` modes and symlinks are rejected (POSIX); cleanup removes only its
  own record; the `status --json` `status.json` fallback merges while human
  output redacts.
