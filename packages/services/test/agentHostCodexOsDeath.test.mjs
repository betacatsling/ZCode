import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Node 24 transforms local TS; resolve emitted-.js imports without installing/building siblings.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) {
      const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { createCodexTransport } = await import("../src/agent-adapters/codex/codexTransport.ts");

const bounded = async (promise, ms) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`native child deadline ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

test(
  "pinned OS child signal exit during held genuine turn/start ACK permits bounded close",
  { skip: process.env.ZCODE_CODEX_NATIVE_OS_DEATH !== "1", timeout: 20000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-codex-os-death-"));
    const cwd = join(root, "cwd");
    await mkdir(cwd);
    let native;
    let intercepted;
    const heldAck = new Promise((resolve) => {
      intercepted = resolve;
    });
    let transport;
    let interceptedCount = 0;
    let appServers = 0;
    try {
      transport = await createCodexTransport({
        cwd,
        sessionHome: join(root, "private"),
        gatewayUrl: "http://127.0.0.1:19371/v1",
        gatewayToken: "synthetic-local-only",
        model: "synthetic-local-only",
        executable: "codex",
        onEvent: () => {},
        spawnProcess(command, args, options) {
          const child = spawn(command, args, options);
          if (args[0] === "--version") return child;
          native = child;
          appServers++;
          assert.ok(child.pid > 0, "actual OS child PID");
          const output = new PassThrough();
          const original = child.stdout;
          child.stdout = output;
          let tail = "";
          original.on("data", (data) => {
            tail += data.toString("utf8");
            for (;;) {
              const end = tail.indexOf("\n");
              if (end < 0) break;
              const line = tail.slice(0, end + 1);
              tail = tail.slice(end + 1);
              const frame = JSON.parse(line);
              if (frame.result?.turn?.id && ++interceptedCount === 1) intercepted(frame);
              else output.write(line);
            }
          });
          original.on("end", () => output.end());
          return child;
        },
      });
      const thread = await bounded(transport.startThread(), 5000);
      const pending = transport.startTurn(thread, "no provider request after held ACK");
      // Register a rejection handler before the child dies; the ACK is the actual native reply, not a fabricated frame.
      const rejected = assert.rejects(pending, /exited|closed|stdout ended/i);
      await bounded(heldAck, 6000);
      assert.equal(interceptedCount, 1);
      const exit = once(native, "exit");
      native.kill("SIGKILL");
      const [code, signal] = await bounded(exit, 3000);
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
      assert.equal(native.exitCode, null);
      assert.equal(native.signalCode, "SIGKILL");
      t.diagnostic(
        `pinned app-server pid=${native.pid} exit=${code} signal=${signal}; appServers=${appServers}`,
      );
      await bounded(rejected, 3000);
      await bounded(transport.close(), 1200);
      await bounded(transport.close(), 1200);
      assert.equal(appServers, 1, "accepted input must not start a replacement native child");
    } finally {
      if (native && native.exitCode === null && native.signalCode === null) {
        const exited = once(native, "exit");
        native.kill("SIGKILL");
        await bounded(exited, 2000);
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
