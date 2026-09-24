import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { attachInstalledSshCore, type SshCoreAttachmentTransport } from "./sshCoreAttachment.js";

async function fixture(
  t: { after(fn: () => void | Promise<void>): void },
  overrides: Record<string, unknown> = {},
  receipt: Record<string, unknown> = {},
  expired = false,
) {
  let tickets = 0;
  const server: Server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/server-info") {
      res.end(
        JSON.stringify({
          serverId: "installed-id",
          version: "3.14.3",
          protocolVersion: 1,
          authRequired: false,
          workspaces: [],
          capabilities: { desktopContinuous: true, websocketRpc: true, agentHost: true },
          ...overrides,
        }),
      );
    } else if (req.url === "/api/rpc-host-capability" && req.method === "POST") {
      tickets++;
      res.end(
        JSON.stringify({
          capability: "one-use-test-ticket",
          expiresAt: Date.now() + (expired ? -1 : 30_000),
        }),
      );
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  let closed = 0;
  let execs = 0;
  const transport: SshCoreAttachmentTransport = {
    detect: async () => ({ platform: "linux", arch: "x64" }),
    exec: async (command) => {
      execs++;
      assert.equal(command, '"$HOME/.zcode/server/bin/zcode" serve --daemon --json');
      const events = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      setImmediate(() => {
        stdout.emit(
          "data",
          JSON.stringify({
            state: "ready",
            host: "127.0.0.1",
            port,
            version: "3.14.3",
            ...receipt,
          }),
        );
        events.emit("close", 0);
      });
      return {
        stdin: { end() {} } as never,
        stdout: stdout as never,
        stderr: stderr as never,
        onClose: (listener: (code: number) => void) => {
          events.on("close", listener);
          return { dispose() {} };
        },
      };
    },
    openLoopbackTunnel: async (remotePort) => {
      assert.equal(remotePort, port);
      return {
        endpoint: `http://127.0.0.1:${port}`,
        dispose: () => {
          closed++;
        },
      };
    },
  };
  return {
    transport,
    get tickets() {
      return tickets;
    },
    get closed() {
      return closed;
    },
    get execs() {
      return execs;
    },
  };
}

test("SSH attachment uses installed Core and disposable tunnel; does not stop Core", async (t) => {
  const f = await fixture(t);
  const attachment = await attachInstalledSshCore(f.transport, {
    serverId: "installed-id",
    version: "3.14.3",
  });
  assert.equal(attachment.websocketUrl.endsWith("/ws/host"), true);
  assert.equal(attachment.ticket, "one-use-test-ticket");
  assert.equal(f.tickets, 1);
  attachment.dispose();
  assert.equal(f.closed, 1);
});

test("wrong identity/protocol never issues a ticket and closes tunnel", async (t) => {
  const f = await fixture(t, { serverId: "reinstalled-id" });
  await assert.rejects(
    attachInstalledSshCore(f.transport, { serverId: "installed-id", version: "3.14.3" }),
    /mismatch/,
  );
  assert.equal(f.tickets, 0);
  assert.equal(f.closed, 1);
});

test("unsupported target fails before exec", async (t) => {
  const f = await fixture(t);
  f.transport.detect = async () => ({ platform: "darwin", arch: "arm64" });
  await assert.rejects(
    attachInstalledSshCore(f.transport, { serverId: "installed-id", version: "3.14.3" }),
    /linux/,
  );
  assert.equal(f.execs, 0);
});

test("wrong protocol, bootstrap version, and expired ticket each fail closed", async (t) => {
  const protocol = await fixture(t, { protocolVersion: 2 });
  await assert.rejects(
    attachInstalledSshCore(protocol.transport, { serverId: "installed-id", version: "3.14.3" }),
  );
  assert.equal(protocol.tickets, 0);
  assert.equal(protocol.closed, 1);
  const receipt = await fixture(t, {}, { version: "older" });
  await assert.rejects(
    attachInstalledSshCore(receipt.transport, { serverId: "installed-id", version: "3.14.3" }),
    /ready receipt/,
  );
  assert.equal(receipt.tickets, 0);
  const expired = await fixture(t, {}, {}, true);
  await assert.rejects(
    attachInstalledSshCore(expired.transport, { serverId: "installed-id", version: "3.14.3" }),
    /expired/,
  );
  assert.equal(expired.closed, 1);
});
