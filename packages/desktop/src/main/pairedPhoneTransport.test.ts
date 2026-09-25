import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { connectViaWebSocket } from "@zcode/client";
import { IAgentHostService } from "@zcode/services";
import { ChannelServer, MessagePortProtocol, type MessagePortLike } from "@zcode/rpc";
import type { MessagePortMain } from "electron";
import { createPairedPhoneTransport, type PairedPhoneScope } from "./pairedPhoneTransport.js";

const scope: PairedPhoneScope = {
  windowId: 7,
  targetId: "local",
  workspaceId: "a",
  hostSessionId: "session-a",
  workspacePath: "/synthetic",
  workspaceIdentity: "local:a",
};
const owner = {
  kind: "external" as const,
  scope: {
    targetId: "local",
    workspaceId: "a",
    workspacePath: "/synthetic",
    workspaceIdentity: "local:a",
  },
  spec: { hostSessionId: "session-a" },
  historyOnly: false,
};

test("paired phone listener is closed by default; Core certification precedes listener and pairing", async () => {
  const transport = createPairedPhoneTransport({
    currentHost: () => undefined,
    certify: async () => {
      throw new Error("unreachable");
    },
    attachPort: () => {
      throw new Error("unreachable");
    },
  });
  assert.equal(transport.address(), null);
  await assert.rejects(() => transport.enable(scope), /scope|host|consent/i);
  transport.dispose();
});

test("disable during asynchronous Core certification cannot mint a later listener or grant", async () => {
  const host = {};
  let finish!: (value: typeof owner) => void;
  const certification = new Promise<typeof owner>((resolve) => {
    finish = resolve;
  });
  const transport = createPairedPhoneTransport({
    currentHost: () => host,
    certify: () => certification as never,
    attachPort: () => {
      throw new Error("not reached");
    },
  });
  try {
    const pending = transport.enable(scope);
    transport.disable();
    finish(owner);
    await assert.rejects(pending, /denied|revoked|cancelled/i);
    assert.equal(transport.address(), null);
  } finally {
    transport.dispose();
  }
});

test("public pairing HTML is inert and served with restrictive content headers", async (t) => {
  const { rm } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "phone-static-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "paired-phone.html"), "<!doctype html><title>Pair</title>");
  const host = {};
  const transport = createPairedPhoneTransport({
    currentHost: () => host,
    certify: async () => owner as never,
    attachPort: () => {
      throw new Error("not reached");
    },
    rendererRoot: dir,
  });
  try {
    const { origin } = await transport.enable(scope);
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${origin}/index.html`)).status, 403);
  } finally {
    transport.dispose();
  }
});

test("authenticated WebSocket forwards public-client RPC on a scoped Host port; revoke closes it", async () => {
  const host = {};
  let ports = 0;
  let calls = 0;
  let server: ChannelServer | undefined;
  let hostProtocol: MessagePortProtocol | undefined;
  const transport = createPairedPhoneTransport({
    currentHost: () => host,
    certify: async () => owner as never,
    attachPort: () => {
      ports++;
      const { port1, port2 } = new MessageChannel();
      // Node's worker port emits raw data; Electron's MessagePortMain emits { data }.
      const listeners = new Map<Function, (data: unknown) => void>();
      const electronPort = {
        on(event: string, listener: (...args: never[]) => void) {
          if (event === "message") {
            const wrapped = (data: unknown) => listener({ data } as never);
            listeners.set(listener, wrapped);
            port1.on("message", wrapped);
          } else port1.on(event, listener);
          return this;
        },
        off(event: string, listener: (...args: never[]) => void) {
          port1.off(event, listeners.get(listener) ?? listener);
          return this;
        },
        once(event: string, listener: (...args: never[]) => void) {
          port1.once(event, listener);
          return this;
        },
        postMessage(data: unknown) {
          port1.postMessage(data);
        },
        start() {
          port1.start();
        },
        close() {
          port1.close();
        },
      } as unknown as MessagePortMain;
      hostProtocol = new MessagePortProtocol(port2 as unknown as MessagePortLike);
      server = new ChannelServer(hostProtocol, "host");
      server.registerChannel(IAgentHostService.channelName, {
        async call(_ctx, method: string, args: unknown[]) {
          if (
            method !== "getSessionSpec" ||
            (args[0] as { hostSessionId: string })?.hostSessionId !== scope.hostSessionId
          )
            throw new Error("foreign session denied");
          calls++;
          return owner.spec;
        },
        listen() {
          throw new Error("event denied");
        },
      });
      return electronPort;
    },
  });
  const original = globalThis.WebSocket;
  try {
    const { origin, challenge } = await transport.enable(scope);
    const paired = await fetch(`${origin}/pair`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "text/plain;charset=UTF-8",
        "x-zcode-phone-csrf": "pair-v1",
      },
      body: challenge,
    });
    assert.equal(paired.status, 200);
    const credential = paired.headers.get("set-cookie")!.split(";")[0]!;
    const proof = ((await paired.json()) as { csrf: string }).csrf;
    const BrowserSocket = class extends WebSocket {
      constructor(url: string, protocols?: string[]) {
        super(url, protocols, { origin, headers: { cookie: credential } });
      }
    };
    globalThis.WebSocket = BrowserSocket as unknown as typeof WebSocket;
    let closed!: () => void;
    const closeEvent = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const services = await connectViaWebSocket(`${origin.replace("http:", "ws:")}/rpc`, {
      protocols: ["zcode-phone-v1", proof],
      onClose: () => closed(),
    });
    assert.deepEqual(
      await services.agentHostService.getSessionSpec({
        targetId: "local",
        workspaceId: "a",
        hostSessionId: scope.hostSessionId,
      }),
      owner.spec,
    );
    assert.equal(ports, 1);
    assert.equal(calls, 1);
    await assert.rejects(
      services.agentHostService.getSessionSpec({
        targetId: "local",
        workspaceId: "a",
        hostSessionId: "foreign",
      }),
      /foreign session denied/,
    );
    transport.disable();
    await closeEvent;
    assert.equal(transport.address(), null);
    assert.equal(ports, 1);
  } finally {
    globalThis.WebSocket = original;
    server?.dispose();
    hostProtocol?.disconnect();
    transport.dispose();
  }
});

test("actual loopback HTTP denies Origin/CSRF/replay before Host port, revocation closes admission", async () => {
  const host = {};
  let attempts = 0;
  let ports = 0;
  const transport = createPairedPhoneTransport({
    currentHost: () => host,
    certify: async (input) => {
      attempts++;
      assert.deepEqual(input, scope);
      return owner as never;
    },
    attachPort: () => {
      ports++;
      throw new Error("no fixture Host");
    },
  });
  try {
    assert.equal(transport.address(), null);
    const { origin, challenge } = await transport.enable(scope);
    assert.equal(attempts, 1);
    const pair = (from: string, code: string, csrf = "pair-v1") =>
      fetch(`${origin}/pair`, {
        method: "POST",
        headers: {
          origin: from,
          "content-type": "text/plain;charset=UTF-8",
          "x-zcode-phone-csrf": csrf,
        },
        body: code,
      });
    assert.equal((await pair("http://bad.example", challenge)).status, 403);
    assert.equal((await pair(origin, challenge, "bad")).status, 403);
    assert.equal((await pair(origin, "wrong")).status, 403);
    const valid = await pair(origin, challenge);
    assert.equal(valid.status, 200);
    const cookie = valid.headers.get("set-cookie")!.split(";")[0]!;
    const proof = ((await valid.json()) as { csrf: string }).csrf;
    assert.ok(proof);
    assert.equal((await pair(origin, challenge)).status, 403);
    assert.equal(
      (
        await fetch(`${origin}/session`, {
          method: "POST",
          headers: { origin: "http://bad.example", cookie, "x-zcode-phone-csrf": "session-v1" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${origin}/session`, {
          method: "POST",
          headers: { origin, cookie, "x-zcode-phone-csrf": "session-v1" },
        })
      ).status,
      200,
    );
    async function upgrade(protocols: string[]): Promise<number> {
      return new Promise((resolve) => {
        const ws = new WebSocket(`${origin.replace("http:", "ws:")}/rpc`, protocols, {
          origin,
          headers: { cookie },
        });
        ws.on("unexpected-response", (_req, response) => {
          resolve(response.statusCode ?? 0);
          ws.terminate();
        });
        ws.on("error", () => resolve(403));
        ws.on("open", () => {
          resolve(101);
          ws.close();
        });
      });
    }
    assert.notEqual(await upgrade(["zcode-phone-v1", "wrong"]), 101);
    assert.equal(ports, 0);
    // Correct cookie+Origin+CSRF crosses authentication; fixture intentionally has no Host port.
    await upgrade(["zcode-phone-v1", proof]);
    assert.equal(ports, 1);
    transport.disable();
    assert.equal(transport.address(), null);
  } finally {
    transport.dispose();
  }
});
