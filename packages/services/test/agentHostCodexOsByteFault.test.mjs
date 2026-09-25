import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

async function bounded(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`native IO deadline ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const fault of ["fragmented-unterminated", "aggregate-early"]) {
  test(
    `pinned OS child ${fault} stdout fault rejects pending turn and is reaped`,
    { skip: process.env.ZCODE_CODEX_NATIVE_BYTE_FAULT !== "1", timeout: 25000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-codex-os-byte-"));
      const cwd = join(root, "cwd");
      await mkdir(cwd);
      let native;
      let appServers = 0;
      let upstreamRequests = 0;
      let failures = 0;
      let injectedEvents = 0;
      let transport;
      let output;
      let releaseAck;
      const heldAck = new Promise((resolve) => {
        releaseAck = resolve;
      });
      const upstream = createServer(async (request, response) => {
        upstreamRequests++;
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) {
            response.writeHead(413).end();
            return;
          }
        }
        response.writeHead(503).end("synthetic upstream unavailable");
      });
      try {
        upstream.listen(0, "127.0.0.1");
        await bounded(once(upstream, "listening"), 2000);
        const address = upstream.address();
        assert.ok(address && typeof address !== "string");
        transport = await createCodexTransport({
          cwd,
          sessionHome: join(root, "private"),
          gatewayUrl: `http://127.0.0.1:${address.port}/v1`,
          gatewayToken: "synthetic-local-only",
          model: "synthetic-local-only",
          executable: "codex",
          onEvent: () => injectedEvents++,
          onFailure: () => failures++,
          spawnProcess(command, args, options) {
            const child = spawn(command, args, options);
            if (args[0] === "--version") return child;
            native = child;
            appServers++;
            assert.ok(child.pid > 0);
            output = new PassThrough();
            const original = child.stdout;
            child.stdout = output;
            const decoder = new StringDecoder("utf8");
            let tail = "";
            original.on("data", (data) => {
              tail += decoder.write(data);
              for (;;) {
                const end = tail.indexOf("\n");
                if (end < 0) break;
                const line = tail.slice(0, end + 1);
                tail = tail.slice(end + 1);
                const frame = JSON.parse(line);
                if (typeof frame.result?.turn?.id === "string") releaseAck();
                else output.write(line);
              }
            });
            original.once("end", () => output.end());
            original.once("error", (error) => output.destroy(error));
            return child;
          },
        });
        const thread = await bounded(transport.startThread(), 6000);
        const pending = transport.startTurn(thread, "synthetic bounded stdout fault");
        const rejected = assert.rejects(pending, /frame too large/);
        await bounded(heldAck, 10000);
        const requestsBeforeFault = upstreamRequests;
        const eventsBeforeFault = injectedEvents;
        const exit = once(native, "exit");
        if (fault === "fragmented-unterminated") {
          output.write(Buffer.alloc(600_000, 120));
          output.write(Buffer.alloc(500_000, 120));
        } else {
          const line = `${JSON.stringify({ method: "thread/name/updated", params: { payload: "x".repeat(600_000) } })}\n`;
          output.write(Buffer.from(line + line));
        }
        await bounded(rejected, 3000);
        const [code, signal] = await bounded(exit, 3000);
        // 修复依据：真实 Codex 在收到 SIGTERM 后可能正常退出 0；已回收的 OS 子进程不要求 signalCode 非空。
        assert.ok(code !== null || signal !== null, "actual child must be OS-reaped");
        assert.equal(native.exitCode, code);
        assert.equal(native.signalCode, signal);
        assert.equal(failures, 1);
        assert.equal(
          injectedEvents,
          eventsBeforeFault,
          "aggregate frames cannot dispatch partial notifications",
        );
        await bounded(transport.close(), 1200);
        await bounded(transport.close(), 1200);
        assert.equal(appServers, 1);
        assert.equal(upstreamRequests, requestsBeforeFault, "fault must not retry upstream");
        t.diagnostic(
          `pid=${native.pid} exit=${code} signal=${signal}; fault=${fault}; appServers=${appServers}; failures=${failures}; fakeRequestsBefore=${requestsBeforeFault}; fakeRequestsAfter=${upstreamRequests}`,
        );
      } finally {
        if (native && native.exitCode === null && native.signalCode === null) {
          const exit = once(native, "exit");
          native.kill("SIGKILL");
          await bounded(exit, 3000);
        }
        await transport?.close();
        upstream.closeAllConnections();
        await bounded(new Promise((resolve) => upstream.close(resolve)), 2000);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
