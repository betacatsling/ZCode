import assert from "node:assert/strict";
import test from "node:test";
import { createHostCapabilityStore, createHostCapabilityUpgradeGate } from "./hostCapability.js";

// Gate-level contract behind the @hono/node-ws waiter leak (webSocketUpgradeLeak.test.ts):
// the route handler registers a waiter that only a successful handshake removes, so nothing may
// reject an upgrade *after* the /ws/host middleware has admitted it. In particular the ws
// server's verifyClient must accept every admitted request, and the checks that used to fail
// there (ticket already consumed by a concurrent upgrade, client already half-closed) must run
// at admission, before the route, without burning the ticket for a request that cannot upgrade.

const VALID_KEY = "dGhlIHNhbXBsZSBub25jZQ==";

interface FakeIncoming {
  method: string;
  url: string;
  headers: Record<string, string>;
  socket: { readable: boolean; writable: boolean };
}

function incoming(
  overrides: { method?: string; headers?: Record<string, string>; readable?: boolean } = {},
): FakeIncoming {
  return {
    method: overrides.method ?? "GET",
    url: "/ws/host",
    headers: {
      host: "127.0.0.1:1",
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": VALID_KEY,
      "sec-websocket-version": "13",
      ...overrides.headers,
    },
    socket: { readable: overrides.readable ?? true, writable: true },
  };
}

function setup() {
  const store = createHostCapabilityStore();
  const gate = createHostCapabilityUpgradeGate(store, { requireLoopbackHost: true });
  const server: { options: { verifyClient?: unknown } } = { options: {} };
  gate.attach(server);
  const verifyClient = server.options.verifyClient as (info: { req: object }) => boolean;
  const admit = (request: FakeIncoming, capability: string) =>
    gate.admit({
      incoming: request,
      capability,
      origin: undefined,
      host: request.headers["host"],
      upgrade: request.headers["upgrade"],
      connection: request.headers["connection"],
    });
  return { store, admit, verifyClient };
}

test("gate: verifyClient accepts every admitted request; a raced second upgrade is refused at admission", () => {
  const { store, admit, verifyClient } = setup();
  const { capability } = store.issue();
  const first = incoming();
  const second = incoming();
  const admissions = [admit(first, capability), admit(second, capability)];
  assert.deepEqual(
    admissions.map((admission) => admission.ok),
    [true, false],
    "only one upgrade is admitted per ticket",
  );
  for (const [index, request] of [first, second].entries()) {
    if (admissions[index]?.ok) assert.equal(verifyClient({ req: request }), true, "admitted → 101");
  }
});

test("gate: a client that already half-closed is refused at admission and keeps its ticket", () => {
  const { store, admit, verifyClient } = setup();
  const { capability } = store.issue();
  const halfClosed = admit(incoming({ readable: false }), capability);
  assert.equal(halfClosed.ok, false, "half-closed socket is not admitted");
  assert.equal(store.peek?.(capability), true, "ticket not burned");
  const retry = incoming();
  assert.equal(admit(retry, capability).ok, true);
  assert.equal(verifyClient({ req: retry }), true);
});

test("gate: handshakes the WebSocket layer would refuse are refused at admission without burning the ticket", () => {
  const { store, admit } = setup();
  const { capability } = store.issue();
  const cases: Array<[string, FakeIncoming, number]> = [
    ["malformed key", incoming({ headers: { "sec-websocket-key": "nope" } }), 400],
    ["version 7", incoming({ headers: { "sec-websocket-version": "7" } }), 400],
    ["bad subprotocol", incoming({ headers: { "sec-websocket-protocol": "a,,b" } }), 400],
    ["POST upgrade", incoming({ method: "POST" }), 405],
  ];
  for (const [name, request, status] of cases) {
    const admission = admit(request, capability);
    assert.deepEqual(admission.ok ? "admitted" : admission.status, status, name);
  }
  assert.equal(store.peek?.(capability), true, "ticket not burned");
});

test("gate: verifyClient passes unremembered requests on other paths and refuses them on /ws/host (control)", () => {
  const { verifyClient } = setup();
  assert.equal(verifyClient({ req: { ...incoming(), url: "/ws" } }), true);
  assert.equal(verifyClient({ req: incoming() }), false);
});
