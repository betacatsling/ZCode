# Host capability bootstrap authentication (M2)

Status: implemented for issuance, including the old-Supervisor + new-Core skew
fallback ("Version-skew fallback"). Tickets are consumed only when the
`/ws/host` upgrade is accepted, and both servers share one store ("Ticket
consume-on-upgrade"). Tickets are bound to the bootstrap credential that
authorised them and to the Core generation ("Ticket binding to the bootstrap
credential"). `/ws/host` applies the issue endpoint's `Origin`/`Host` rule
before it looks at the ticket ("`/ws/host` request header checks"). The
unauthenticated `/ws` and `/api/server-info` refuse browser and DNS-rebinding
requests and publish only non-sensitive fields ("Local endpoints: `/ws` and
`/api/server-info`"); token auth for them is deferred.

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

A ticket (`{capability, expiresAt}`, 30 s TTL, single use, bound to the
issuing credential; one shared store in
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
   (`packages/shared/src/node/hostBootstrapAuth.ts`, exported from
   `@zcode/shared/node`; each server's `hostBootstrapAuth.ts` is a re-export)
   checks, in this order. The first two checks are
   `verifyHostRequestHeaders`, which `/ws/host` also uses:
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
   channels excluded) and `/api/server-info` have no token, but they do have
   header checks ("Local endpoints").

### Ticket consume-on-upgrade

A ticket is consumed only when the `/ws/host` WebSocket upgrade is accepted, not
when the request first arrives. Both servers wire the same gate
(`createHostCapabilityUpgradeGate`) in the same two places:

1. **HTTP middleware on `/ws/host` (`admit`, never consumes).** It runs for
   every method, in the order below:
   - Any `Origin`, or a non-loopback `Host` where the issue endpoint requires
     one → **403** ("`/ws/host` request header checks"). The ticket is not
     looked at.
   - Missing, unknown or expired ticket, or one whose binding is not current
     ("Ticket binding") → **401**. The check is `store.peek()`, which is
     non-consuming. It purges expired entries, so an expired ticket stays dead
     even if the clock later rewinds.
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
   whatever the result. If it returns `false` (replayed, expired, binding no
   longer current, or already won by a concurrent upgrade), `ws` answers
   **401** and never sends 101.
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
the middleware. How such stores interact with binding is described under
"Ticket binding".

### `/ws/host` request header checks

`/ws/host` applies the same browser and authority rule as
`POST /api/rpc-host-capability`: the same predicate
(`verifyHostRequestHeaders` in `packages/shared/src/node/hostBootstrapAuth.ts`)
with the same options object that each server passes to
`verifyHostBootstrapRequest` (`hostRequestHeaderRules` in each `http.ts`).

- Any `Origin` header → **403**. Real `/ws/host` clients are Node `ws`
  clients (`connectToPersistentTarget` in
  `packages/server/src/remote/persistentTargetClient.ts`, used by the Desktop
  Host and the SSH connector, and `verify-remote-ssh.mjs`). None sets the `ws`
  `origin` option, and `ws` sends `Origin` only when that option is set. A
  browser always sends `Origin` on a WebSocket handshake, so this refuses
  cross-site WebSocket hijacking and rebinding pages outright.
- A `Host` authority other than `127.0.0.1` / `localhost` / `[::1]` (optional
  port) → **403** (DNS rebinding). This applies on Server Core always, and on
  the legacy server when it is bound to loopback, exactly as for issuance.
  Clients connect to `/ws/host` with the same authority they used to obtain
  the ticket.
- **Order.** The check is the first step of the shared gate's `admit`, before
  any `peek`, and a request rejected there is never remembered, so the
  `verifyClient` consume point never sees it. A rejected request can never
  burn a ticket. On the legacy server with `authToken`, the lite-token
  middleware still runs first; it does not touch tickets either.

### Ticket binding to the bootstrap credential

A ticket is only valid on a server that still holds the credential it was
issued under.

- **What is recorded.** On a successful `POST /api/rpc-host-capability`, the
  server issues through `gate.issue(binding)`, where binding is
  `{credentialFingerprint, generation?}`:
  - `credentialFingerprint = hostBootstrapCredentialFingerprint(credential)`,
    which is base64url `sha256("zcode/host-bootstrap-credential/v1\0" ‖
credential)`. It is one-way, so the ticket record never holds the secret,
    and deterministic, so a rotated credential has a different fingerprint.
    The credential is the one actually presented: Server Core has exactly one
    (`hostBootstrapToken`). The legacy server fingerprints the presented
    Bearer, which after verification equals `hostBootstrapToken` or
    `authToken`.
  - `generation`: the Supervisor-assigned Core generation. `runServerCore`
    passes it as `createCoreHttpServer({ generation })`. The legacy server has
    no generations and omits it.
- **Where it is stored.** In the ticket record of the shared store
  (`packages/shared/src/node/hostCapabilityStore.ts`), next to `expiresAt`, in
  process memory only.
- **What is accepted.** The gate reads the server's current bindings
  (`acceptedBindings()`) at every check, and a ticket's binding must equal
  one of them exactly (fingerprint and generation):
  - Server Core: `[{fingerprint(hostBootstrapToken), generation}]`.
  - Legacy server: one entry per configured credential (`hostBootstrapToken`,
    `authToken`). With neither configured nothing can be issued over HTTP, so
    no binding is enforced.
- **Where it is checked.** In both places from "Ticket consume-on-upgrade",
  with the same policy:
  - `admit` → `store.peek(capability, accepted)`. A mismatch is 401 and the
    ticket is **not** consumed, so a ticket carried to the wrong server stays
    usable at its issuer until it expires.
  - `verifyClient` → `store.consume(capability, accepted)`. The ticket is
    deleted whatever the outcome, and a mismatch there (for example if the
    policy changed between `admit` and the handshake) is 401 before 101.
- **Rotation behaviour.** A ticket issued under a credential that is no longer
  current, or by another Core generation, is rejected with 401. That includes
  one issued by a previous generation that reused the same secret, and on the
  legacy server one obtained with an `authToken` that has since been
  replaced. Today each server holds its credentials for its whole lifetime,
  and stores live in process memory, so this matters when a store is shared
  (the `hostCapabilityStore` option) or if credentials ever rotate in-process.
  `acceptedBindings` is re-read on every check, so in-process rotation would
  take effect without a restart.
- **Unbound tickets.** `store.issue()` without a binding is only reachable
  in-process, by code that holds the store object. The HTTP endpoint always
  binds. A binding-aware store keeps such tickets unbound and accepts them,
  which is what the existing store-level tests rely on. Every ticket obtained
  with a bootstrap credential is bound.
- **Injected stores without binding support.** A store is binding-aware when
  it sets `bindsCredential: true` (`createHostCapabilityStore` does). An older
  `{issue, consume[, peek]}` store cannot record a binding, and its tickets
  would be indistinguishable from tickets issued under another credential
  sharing the same store. The gate therefore wraps it **fail-closed**. It keeps
  the binding of every ticket it issued itself (reclaimed at `expiresAt`, while
  TTL and single use stay with the inner store). While a binding policy is
  configured, a ticket the gate has no matching record for is rejected with
  401 in `admit`, without touching the inner store, so nothing is burned. Its
  own tickets keep working exactly as before. With no policy (legacy server
  without credentials) the wrapper is transparent.

**Shared location.** `packages/shared/src/node/hostCapabilityStore.ts` (and
`hostBootstrapAuth.ts` next to it), exported from the Node-only subpath `@zcode/shared/node`. Both
`packages/server` and `packages/zcode-server-cli` already depend on
`@zcode/shared`, so no new dependency edge was added. The subpath is
Node-only, because the store uses `node:crypto`, and it is never imported by
renderer or browser bundles. The gate talks to the `ws` server through a
structural type, so `@zcode/shared` does not depend on `ws`.
`hostCapability.ts` and `hostBootstrapAuth.ts` in `packages/server/src` and
`packages/zcode-server-cli/src/server-core` are now plain re-exports that keep
the historical import paths. `@zcode/server` could not
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
  consume-on-upgrade gate and ticket binding apply to injected stores too.
- Tickets are bound to the fingerprint of the credential presented at issue.
  Replacing `authToken` (restarting with another value) invalidates tickets
  obtained with the old one, while tickets obtained with a still-configured
  `hostBootstrapToken` stay valid.
- `authRequired` no longer reads the mismatched `ZCODE_SERVER_TOKEN` env var
  (`entry-http.ts` uses `ZCODE_SERVER_AUTH_TOKEN`).

## Local endpoints: `/ws` and `/api/server-info`

These endpoints have no token (full token auth is deferred), so they are locked
down by request headers and by publishing less. The same rules cover the
legacy server's `/ws/remote/:id`, whose only client is the same Web UI.

### Who connects (audit)

Found with `git grep` for `server-info`, `new WebSocket(`,
`connectViaWebSocket` and `/ws`. The desktop renderer is not a client: it
reaches the Host over MessagePorts and opens no WebSocket to either server
(`packages/desktop/src/main/chromeLocalStorageManager.ts:193` connects to a
Chrome DevTools endpoint, not to ZCode). `apps/zcode-cli` has no caller.

| Client                                                                                                          | Server | Endpoint(s)                                                                                                     | `Origin` sent                                                                                                                                                                                                                               | server-info fields read                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Web UI served by the legacy server (`zcode --web`, `scripts/zcode-distribution/runner.mjs:178-190`)             | legacy | `/ws` or `/ws/remote/:id` (`packages/web/src/main.tsx:308-318`, `:393` → `packages/client/src/websocket.ts:67`) | Browser WebSocket: always the page origin, which is this server, e.g. `http://127.0.0.1:<port>` (`runner.mjs:131-135`), `http://localhost:<port>`, or `http://<LAN IP>:<port>` with `--host 0.0.0.0` (token enforced, `runner.mjs:105`)     | —                                                                                           |
| Same Web UI bootstrap fetch                                                                                     | legacy | `GET /api/server-info` (`packages/web/src/main.tsx:324`)                                                        | None: a same-origin `GET` fetch carries no `Origin` (Fetch spec), and an `Origin` would equal the page origin                                                                                                                               | `workspaces[0].path`, `workspaces[0].workspaceIdentity` (`main.tsx:331-337`)                |
| Web UI under Vite dev (`packages/web/vite.config.ts:52-56`, page `http://localhost:5173`)                       | legacy | `/ws`, `/api/*` proxied to `localhost:3030`                                                                     | `http://localhost:5173`. The proxy entries are objects without `changeOrigin` or `rewriteWsOrigin`, so Vite 8.0.8 forwards `Host: localhost:5173` and the `Origin` unchanged (`node_modules/vite/dist/node/chunks/node.js:16854`, `:17761`) | same as above                                                                               |
| Desktop Host → local Core (`packages/desktop/src/host/index.ts:2839`)                                           | Core   | `GET /api/server-info`, then `/ws/host` (`packages/server/src/remote/persistentTargetClient.ts:83`, `:186`)     | None: Node `fetch` and the `ws` client (`ws` sends `Origin` only with its `origin` option, unused)                                                                                                                                          | `serverId` (target identity), `capabilities.agentHost` (`persistentTargetClient.ts:88-104`) |
| SSH connector → remote Core over a local forward (`packages/server/src/remote/connect.ts:513`)                  | Core   | same as above, `Host: 127.0.0.1:<forward>` (`ssh-backend.ts:380`)                                               | None                                                                                                                                                                                                                                        | same as above                                                                               |
| `packages/zcode-server-cli/scripts/verify-remote-ssh.mjs`                                                       | Core   | `GET /api/server-info` (`:208-217`), `/ws` (`:221`), `/ws/host` (`:265`)                                        | None (Node `fetch`, `ws`)                                                                                                                                                                                                                   | `capabilities.websocketRpc`, `serverId`, `version` (logged)                                 |
| `scripts/zcode-distribution-smoke.mjs`                                                                          | legacy | `GET /api/server-info` (`:103`), `/ws` (`:121`)                                                                 | None (Node `fetch`, `ws`)                                                                                                                                                                                                                   | `workspaces[0].path` (`:116`)                                                               |
| Tests (`runtimeLifecycle.integration.test.ts:196`, `hostCapability*.test.ts`, `persistentTargetClient.test.ts`) | both   | `/ws`, `/api/server-info`                                                                                       | None                                                                                                                                                                                                                                        | `authRequired` (schema parse), `serverId`, `capabilities`                                   |

No real client sends `Origin: null`, and no page other than the server's own
Web UI (or the Vite dev page that proxies to it) connects.

### Header rules

One shared predicate, `verifyLocalEndpointHeaders` in
`packages/shared/src/node/hostBootstrapAuth.ts`, runs as Hono middleware
registered before the routes (and before the legacy lite-token middleware), so
a rejected request never reaches the upgrade or the handler. Rejections are
**403**.

- **Host.** The same rule and the same options object as
  `POST /api/rpc-host-capability` and `/ws/host` (`hostRequestHeaderRules`):
  a `Host` other than `127.0.0.1` / `localhost` / `[::1]` (optional port) is
  refused. Server Core always applies it. The legacy server applies it only
  when it is bound to loopback. Bound to another interface (`--host 0.0.0.0`,
  or no host in dev), the `Host` is not checked, exactly as for issuance, and
  the lite token (`authToken`, auto-enabled by the runner for non-local hosts)
  is the defence.
- **Origin, Server Core (`origin: "no-browser"`).** Every real client is a Node
  process that sends no `Origin`, and Core serves no web page, so any `Origin`
  is refused, including Core's own origin.
- **Origin, legacy server (`origin: "same-origin"`).** No `Origin` (Node
  clients) is accepted. Otherwise the `Origin` must be exactly the
  serialization `http(s)://<Host header>` (`isSameOriginAsHost`: scheme http or
  https, no path, default ports normalised), which is what the served page and
  the Vite dev proxy send. `null`, other sites, other loopback ports and `ws:`
  origins are refused.
- **What this stops.** Cross-site WebSocket hijacking and cross-site reads from
  any other page, including pages on other localhost ports. A DNS-rebinding
  page is "same-origin" with the name it rebound (`Origin` and `Host` both
  `evil.example:<port>`), so it is stopped by the `Host` rule, and therefore
  only while the server is bound to loopback.

### `/api/server-info` fields

Servers publish only what a real client reads. The shared schema
(`packages/shared/src/server-remote.ts`) keeps `serverId` and `workspaces` as
optional fields for old servers.

- **Server Core** publishes `serverId`, `version`, `protocolVersion`,
  `authRequired` and `capabilities`.
  - Removed: `workspaces` (always `[]`), and the `os.hostname()` fallback for
    `serverId` when no install identity is injected (embedded and test Cores
    now say `zcode-server`).
  - Kept with justification: `serverId` is the install-scoped target identity
    (`local:<deviceMid>` or the installation ID). The Desktop Host and the SSH
    connector must check it **before** they send the bootstrap secret to the
    port. `capabilities` gates `agentHost` and `websocketRpc`.
- **Legacy server** publishes `version`, `protocolVersion`, `authRequired`,
  `capabilities` and `workspaces: [{path, workspaceIdentity?}]`.
  - Removed: `serverId` (`os.hostname()` by default), `name`
    (`ZCODE_SERVER_NAME`) and workspace `label`. No client reads them. The
    options are still accepted.
  - Kept with justification: the workspace `path` and `workspaceIdentity`,
    because the Web UI (`packages/web/src/main.tsx:331-337`) opens its initial
    workspace from them, and the distribution smoke asserts the path. The same
    page gets the same data over `/ws` anyway, and with `authToken` set,
    `/api/*` needs the lite token.

### Compatibility

- Legacy web behind a reverse proxy that rewrites `Host` but not `Origin`
  (for example nginx's default `proxy_set_header Host $proxy_host`, with a
  public `Origin`) now gets 403 on `/ws`. No in-repo deployment does this. The
  fix would be an explicit allowed-origins option, which is not added here.
- A browser page on another loopback port (for example a second dev server)
  can no longer open the legacy `/ws`.

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

- **Stronger ticket binding.** Tickets are now bound to the issuing credential
  and generation ("Ticket binding"). Whoever holds a ticket within 30 s on the
  server that issued it still becomes a trusted Host. Remaining options:
  1. _Proof of possession._ The client sends `sha256(nonce)` at issuance and
     the nonce (or the Bearer secret) at upgrade, so a leaked ticket alone is
     useless. The client currently never sends the secret to `/ws/host`
     (asserted in `persistentTargetClient.test.ts`), so this needs a client
     change.
  2. _Bind to scope._ The ticket names the target ID and the intended role or
     workspace scope, and `/ws/host` grants only that scope. This needs a
     service-level scoped channel API.
  3. _Bind to connection origin_ (peer address). Weak: every caller, including
     SSH forwards, appears as loopback.
- Windows: `chmod` is a no-op, so the confidentiality of `status.json` and
  `core-host-bootstrap.json` relies on the per-user profile ACL and the
  named-pipe control endpoint. The reader skips the mode and uid checks there.
- The skew fallback file can be removed once pre-M2 Supervisors are no longer
  supported, meaning every running Supervisor forwards `ready.hostBootstrapToken`.
- The secret rotates only per Core launch, not per ticket or on a timer.
- **Token auth for `/ws` and `/api/server-info`** (both servers, plus the legacy
  `/ws/remote/:id`). Today they rely on the header rules and minimal fields
  ("Local endpoints"). That stops browsers and DNS rebinding, but not other
  local OS users or processes, or anyone reaching an SSH forward. A per-launch
  secret like the Host bootstrap credential (header for Node clients, a
  cookie or subprotocol for the Web UI) would close this. It needs client
  changes in the Web UI and the connectors. Until then, the legacy server bound
  to a non-loopback interface depends on `authToken`.
- The legacy `POST /api/connect-remote` has no `Origin`/`Host` check beyond the
  lite token.

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
- `hostCapabilityBinding.test.ts` in both `packages/server/src` and
  `packages/zcode-server-cli/src/server-core`: two servers share one injected
  store to model rotation.
  - A ticket issued under one secret gets 401 on the other server, including
    for a plain `GET` (401, not 426), and afterwards still opens once at its
    issuer.
  - Server Core: a previous generation's ticket is rejected even when the
    secret is reused.
  - Legacy server: a ticket obtained with a replaced `authToken` is rejected,
    while one obtained with the surviving `hostBootstrapToken` works.
  - The recorded binding is a deterministic fingerprint of the presented
    credential (plus the generation on Core), and never contains the secret.
  - A binding-unaware injected store keeps working at its issuer and fails
    closed elsewhere and for tickets the server did not issue.
  - Control: unbound in-process tickets stay usable.
- `hostCapability.wsHostHeaders.test.ts` in both packages: any `Origin`
  (including `null` and a loopback page origin) and non-loopback `Host`
  authorities get 403 with a valid ticket, which then still opens once. The
  header checks come before the ticket and upgrade checks: `Origin` without a
  ticket, a foreign `Host` with an unknown ticket, and a plain `GET` with
  `Origin` all get 403 (not 401 or 426). Control: loopback authorities without
  `Origin` upgrade.
- `localEndpointHeaders.test.ts` in both packages:
  - Core: any `Origin` on `/ws` or `/api/server-info` → 403, and a
    non-loopback `Host` → 403. server-info keys are limited to the allow-list,
    with no hostname fallback.
  - Legacy: cross-site `Origin`s (`null`, other sites, another loopback port,
    `ws:`) on `/ws`, `/ws/remote/:id` and server-info → 403, and a non-loopback
    `Host` → 403 when bound to loopback, including the rebinding pair.
    server-info drops `serverId`, `name` and `label`. Bound to `127.0.0.2`
    (Linux only), `Host` is unchecked but cross-site `Origin` is still refused.
  - Controls: Node clients and the fields they read, the same-origin Web UI
    page, and the Vite dev proxy form.
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
