import assert from "node:assert/strict";
import { once, EventEmitter } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { createServer as createNetServer, connect, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import test from "node:test";
import { SSHBackend } from "./ssh-backend.js";

interface FixtureSSHClient extends EventEmitter {
  on(
    event: "authentication",
    listener: (context: { method: string; accept(): void }) => void,
  ): this;
  on(event: "ready", listener: () => void): this;
  on(
    event: "tcpip",
    listener: (
      accept: () => Duplex,
      reject: () => void,
      info: { destIP: string; destPort: string | number },
    ) => void,
  ): this;
  on(
    event: "session",
    listener: (accept: () => FixtureSSHSession, reject: () => void) => void,
  ): this;
}

interface FixtureSSHSession extends EventEmitter {
  once(
    event: "exec",
    listener: (accept: () => FixtureSSHExecStream, reject: () => void) => void,
  ): this;
}

interface FixtureSSHExecStream extends Duplex {
  exit(code: number): void;
  stderr: Duplex;
}

interface FixtureSSHServer extends EventEmitter {
  listen(port: number, host: string): this;
  address(): AddressInfo | string | null;
  close(callback?: () => void): this;
}

const SSHServer = createRequire(import.meta.url)("ssh2").Server as new (
  options: { hostKeys: string[] },
  onClient: (client: FixtureSSHClient) => void,
) => FixtureSSHServer;

test(
  "SSH direct-tcpip loopback attachment forwards bytes and closes without a remote stop",
  { timeout: 15_000 },
  async () => {
    const echoServer = createNetServer((socket) => socket.pipe(socket));
    echoServer.listen(0, "127.0.0.1");
    await once(echoServer, "listening");
    const echoAddress = echoServer.address();
    assert.ok(echoAddress && typeof echoAddress !== "string");

    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    const sshServer = new SSHServer({ hostKeys: [privateKey] }, (client) => {
      client.on("authentication", (context) => context.accept());
      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.once("exec", (acceptExec) => {
            const stream = acceptExec();
            stream.write("ready");
            stream.exit(0);
            stream.end();
          });
        });
        client.on("tcpip", (accept, reject, info) => {
          if (info.destIP !== "127.0.0.1" || Number(info.destPort) !== echoAddress.port) {
            reject();
            return;
          }
          const channel = accept();
          const target = connect(echoAddress.port, "127.0.0.1");
          target.once("error", () => channel.destroy());
          channel.once("close", () => target.destroy());
          channel.pipe(target).pipe(channel);
        });
      });
    });
    sshServer.listen(0, "127.0.0.1");
    await once(sshServer, "listening");
    const sshAddress = sshServer.address();
    assert.ok(sshAddress && typeof sshAddress !== "string");

    const backend = new SSHBackend({
      host: "127.0.0.1",
      port: sshAddress.port,
      username: "isolated-test",
      password: "isolated-test",
    });
    let forward: Awaited<ReturnType<SSHBackend["openLocalPortForward"]>> | undefined;
    try {
      forward = await backend.openLocalPortForward(echoAddress.port);
      assert.ok(forward);
      const socket = connect(forward.port, forward.host);
      const echoed = new Promise<Buffer>((resolve, reject) => {
        socket.once("error", reject);
        socket.once("data", (chunk: Buffer) => resolve(chunk));
      });
      socket.write(Buffer.from("target-core-loopback"));
      assert.equal((await echoed).toString(), "target-core-loopback");
      socket.destroy();
      await forward.disposeAndWait();
      forward = undefined;
      // The SSH backend remains usable after detaching the forwarded Core socket.
      const status = await backend.exec("printf ready");
      let output = "";
      status.stdout.on("data", (chunk: Buffer | string) => {
        output += chunk.toString();
      });
      const exitCode = await new Promise<number>((resolve, reject) => {
        status.onClose((code) => resolve(code));
        status.stderr.on("error", reject);
      });
      assert.equal(exitCode, 0);
      assert.equal(output, "ready");
    } finally {
      await forward?.disposeAndWait();
      backend.dispose();
      await new Promise<void>((resolve) => sshServer.close(() => resolve()));
      await new Promise<void>((resolve) => echoServer.close(() => resolve()));
    }
  },
);
