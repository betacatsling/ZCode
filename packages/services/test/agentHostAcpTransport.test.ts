import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createAcpTransport, type AcpProcess } from "../src/agent-adapters/acp/acpTransport.js";

function fixture(load: boolean, version = "1.5.0") {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill() {
      this.killed = true;
      this.emit("exit", 0);
      return true;
    },
  }) as AcpProcess & { killed: boolean };
  const writes: Record<string, unknown>[] = [];
  let buffered = "";
  stdin.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    while (buffered.includes("\n")) {
      const index = buffered.indexOf("\n");
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      writes.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  const send = (frame: unknown) => stdout.write(`${JSON.stringify(frame)}\n`);
  const descriptor = {
    executable: "/fixture/agent",
    argv: ["acp"],
    cwd: "/fixture/work",
    env: { HOME: "/fixture/profile" },
    version: { argv: ["--version"], exact: version },
  };
  const connect = (extra: Parameters<typeof createAcpTransport>[1] = {}) =>
    createAcpTransport(descriptor, {
      ...extra,
      probeVersion: async () => version,
      launch: () => child,
    });
  const respond = async (method: string, result: unknown) => {
    await new Promise((resolve) => setImmediate(resolve));
    const request = writes.findLast((item) => item.method === method);
    assert.ok(request, `missing ${method}`);
    send({ jsonrpc: "2.0", id: request.id, result });
  };
  const initialize = async (transportPromise: ReturnType<typeof connect>, protocolVersion = 1) => {
    await respond("initialize", {
      protocolVersion,
      agentCapabilities: { loadSession: load, experimental: true },
    });
    return transportPromise;
  };
  return { child, writes, send, connect, respond, initialize };
}

for (const [name, load] of [
  ["alpha-load", true],
  ["beta-history", false],
] as const) {
  test(`${name}: capabilities and structured updates never imply model binding or synthetic resume`, async () => {
    const f = fixture(load);
    const opening = f.connect();
    const client = await f.initialize(opening);
    assert.equal(client.capabilities.loadSession, load);
    if (!load) await assert.rejects(client.load("old-id"), /not supported/);
    else {
      const loading = client.load("old-id");
      await f.respond("session/load", {});
      await loading;
    }
    if (!load) {
      const created = client.newSession();
      await f.respond("session/new", { sessionId: "opaque-id" });
      assert.equal(await created, "opaque-id");
    }
    const events: unknown[] = [];
    client.onUpdate((update) => events.push(update));
    const nativeId = load ? "old-id" : "opaque-id";
    f.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: nativeId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
      },
    });
    f.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: nativeId, update: { sessionUpdate: "future_extension", data: 42 } },
    });
    const prompt = client.prompt("hi");
    await f.respond("session/prompt", { stopReason: "end_turn" });
    assert.deepEqual(await prompt, { stopReason: "end_turn" });
    assert.equal(events.length, 2);
    const init = f.writes.find((w) => w.method === "initialize");
    assert.ok(init && typeof init.params === "object" && init.params);
    assert.deepEqual((init.params as Record<string, unknown>).clientCapabilities, {});
    await client.close();
    assert.equal(f.child.killed, true);
  });
}

test("permission remains pending until selected option; cancellation invalidates late replies", async () => {
  const f = fixture(true);
  let resolve!: (optionId: string) => boolean;
  const opening = f.connect({
    onPermission: (request) => {
      resolve = request.resolve;
    },
  });
  const client = await f.initialize(opening);
  const creating = client.newSession();
  await f.respond("session/new", { sessionId: "s" });
  await creating;
  const prompt = client.prompt("go");
  f.send({
    jsonrpc: "2.0",
    id: 70,
    method: "session/request_permission",
    params: {
      sessionId: "s",
      toolCall: { toolCallId: "tool" },
      options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
    },
  });
  assert.equal(
    f.writes.some((w) => w.id === 70 && "result" in w),
    false,
  );
  assert.equal(resolve("wrong"), false);
  assert.equal(resolve("yes"), true);
  assert.equal(resolve("yes"), false);
  assert.deepEqual(f.writes.find((w) => w.id === 70 && "result" in w)?.result, {
    outcome: { outcome: "selected", optionId: "yes" },
  });
  f.send({
    jsonrpc: "2.0",
    id: 71,
    method: "session/request_permission",
    params: { sessionId: "s", toolCall: { toolCallId: "tool2" }, options: [{ optionId: "yes" }] },
  });
  await client.cancel();
  assert.equal(resolve("yes"), false);
  assert.deepEqual(f.writes.find((w) => w.id === 71 && "result" in w)?.result, {
    outcome: { outcome: "cancelled" },
  });
  await assert.rejects(prompt, /cancelled/);
  await assert.rejects(client.prompt("too soon"), /cancelling/);
  const oldPrompt = f.writes.find((w) => w.method === "session/prompt");
  assert.ok(oldPrompt);
  f.send({ jsonrpc: "2.0", id: oldPrompt.id, result: { stopReason: "cancelled" } });
  const next = client.prompt("next turn");
  await f.respond("session/prompt", { stopReason: "end_turn" });
  assert.deepEqual(await next, { stopReason: "end_turn" });
  await client.close();
});

test("default-deny client requests and injected authorized filesystem handler", async () => {
  const f = fixture(false);
  const opening = f.connect({
    clientRequests: { "fs/read_text_file": async () => ({ content: "authorized" }) },
    clientCapabilities: { fs: { readTextFile: true } },
  });
  const client = await f.initialize(opening);
  f.send({
    jsonrpc: "2.0",
    id: 80,
    method: "fs/read_text_file",
    params: { path: "/fixture/work/file" },
  });
  f.send({ jsonrpc: "2.0", id: 81, method: "terminal/create", params: { command: "danger" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.writes.find((w) => w.id === 80)?.result, { content: "authorized" });
  const denied = f.writes.find((w) => w.id === 81);
  assert.ok(denied?.error);
  assert.equal((denied.error as { code: number }).code, -32601);
  await client.close();
});

test("capabilities cannot advertise filesystem or terminal execution without injected callbacks", async () => {
  const f = fixture(false);
  await assert.rejects(
    f.connect({ clientCapabilities: { fs: { writeTextFile: true } } }),
    /advertised without authorized callback/,
  );
  assert.equal(f.child.killed, false);
  await assert.rejects(
    f.connect({ clientCapabilities: { terminal: true } }),
    /terminal advertised/,
  );
});

test("unknown version, malformed/duplicate frames and child exit fail closed", async () => {
  const old = fixture(false);
  const opening = old.connect();
  await old.respond("initialize", { protocolVersion: 2 });
  await assert.rejects(opening, /version/);
  assert.equal(old.child.killed, true);
  const f = fixture(true);
  const start = f.connect();
  const client = await f.initialize(start);
  const creating = client.newSession();
  f.send({
    jsonrpc: "2.0",
    id: 93,
    method: "session/request_permission",
    params: { sessionId: "s", toolCall: { toolCallId: "x" }, options: [] },
  });
  f.send({
    jsonrpc: "2.0",
    id: 93,
    method: "session/request_permission",
    params: { sessionId: "s", toolCall: { toolCallId: "x" }, options: [] },
  });
  await assert.rejects(creating);
  assert.equal(f.child.killed, true);
  const g = fixture(false);
  const starting = g.connect();
  const active = await g.initialize(starting);
  const pending = active.newSession();
  g.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: 1 } });
  await assert.rejects(pending);
  const broken = fixture(false);
  const startingBroken = broken.connect();
  const malformed = await broken.initialize(startingBroken);
  const pendingMalformed = malformed.newSession();
  broken.child.stdout.write("{invalid-json}\n");
  await assert.rejects(pendingMalformed);
  assert.equal(broken.child.killed, true);
  const h = fixture(false);
  const startingH = h.connect();
  const live = await h.initialize(startingH);
  const pendingH = live.newSession();
  h.child.emit("exit", 1);
  await assert.rejects(pendingH);
});
