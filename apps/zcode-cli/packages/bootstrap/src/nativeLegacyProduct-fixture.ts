import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";

export interface NativeLegacyProductFrame {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

export interface NativeLegacyProductCli {
  readonly childPid: number;
  readonly upstreamRequests: () => number;
  request(method: string, params: Record<string, unknown>): Promise<NativeLegacyProductFrame>;
  nextFrame(
    predicate: (frame: NativeLegacyProductFrame) => boolean,
  ): Promise<NativeLegacyProductFrame>;
  close(): Promise<void>;
}

/** Disposable real CLI process with the existing real Registry/Model path and loopback-only upstream. */
export async function launchNativeLegacyProductCli(input: {
  root: string;
  cwd: string;
  dbPath: string;
  signal?: AbortSignal;
}): Promise<NativeLegacyProductCli> {
  let upstreamRequests = 0;
  const upstream: Server = createServer((_request, response) => {
    upstreamRequests++;
    const event = (type: string, data: object) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" }).end(
      event("message_start", {
        message: {
          id: `legacy-fixture-${upstreamRequests}`,
          type: "message",
          role: "assistant",
          model: "fixture-model",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 0 },
        },
      }) +
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
        event("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: "native legacy fixture response" },
        }) +
        event("content_block_stop", { index: 0 }) +
        event("message_delta", {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 4 },
        }) +
        event("message_stop", {}),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address() as AddressInfo;
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", new URL("./native-bootstrap-subprocess.test.ts", import.meta.url).pathname],
    {
      cwd: process.cwd(),
      // Do not inherit provider credentials, user config paths, or any ambient service settings.
      env: {
        PATH: process.env.PATH ?? "",
        NODE_OPTIONS: "--max-old-space-size=2048",
        HOME: input.root,
        ZCODE_DATA_BASE_DIR: input.root,
        ZCODE_SESSION_DB_PATH: input.dbPath,
        ZCODE_NATIVE_BOOT_FIXTURE_CHILD: "1",
        ZCODE_BOOT_FIXTURE_CWD: input.cwd,
        ZCODE_BOOT_FIXTURE_URL: `http://127.0.0.1:${address.port}/fixture`,
        ZCODE_TELEMETRY_ENABLED: "false",
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    },
  );
  assert.ok(child.stdin && child.stdout && child.stderr, "native fixture stdio unavailable");
  const frames: NativeLegacyProductFrame[] = [];
  const pending: Array<{
    predicate: (frame: NativeLegacyProductFrame) => boolean;
    resolve: (frame: NativeLegacyProductFrame) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  const stderr: Buffer[] = [];
  let closing: Promise<void> | undefined;
  const failWaiters = (error: Error) => {
    for (const waiter of pending.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };
  child.on("error", (error) => failWaiters(error));
  child.on("exit", (code, signal) => {
    failWaiters(
      new Error(
        `native legacy product CLI exited code=${code} signal=${signal} stderrBytes=${Buffer.concat(stderr).length}`,
      ),
    );
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 8) stderr.push(chunk);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const frame = JSON.parse(line) as NativeLegacyProductFrame;
    if (frame.method === "session/requestRuntimePreferences" && frame.id !== undefined) {
      child.stdin?.write(
        JSON.stringify({
          id: frame.id,
          result: { memoryEnabled: false, nativeSearchEnhancementsEnabled: false },
        }) + "\n",
      );
      return;
    }
    frames.push(frame);
    for (let index = pending.length - 1; index >= 0; index--) {
      const waiter = pending[index]!;
      if (!waiter.predicate(frame)) continue;
      clearTimeout(waiter.timer);
      pending.splice(index, 1);
      waiter.resolve(frame);
    }
  });
  const nextFrame = (predicate: (frame: NativeLegacyProductFrame) => boolean) => {
    const previous = frames.find(predicate);
    if (previous) return Promise.resolve(previous);
    return new Promise<NativeLegacyProductFrame>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = pending.indexOf(waiter);
          if (index >= 0) pending.splice(index, 1);
          reject(
            new Error(
              `native legacy product frame timed out; stderrBytes=${Buffer.concat(stderr).length}`,
            ),
          );
        }, 15000),
      };
      pending.push(waiter);
    });
  };
  let nextRequestId = 1;
  // 中文：测试超时不会自动回收派生的 CLI；取消信号必须立即开始有限清理。
  const close = (): Promise<void> => {
    closing ??= (async () => {
      input.signal?.removeEventListener("abort", onAbort);
      failWaiters(new Error("native legacy product CLI closed"));
      const exit = new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("exit", () => resolve());
      });
      child.stdin?.end();
      if (child.connected) child.disconnect();
      upstream.closeAllConnections();
      try {
        // CLI normally exits on stdin EOF. Do not let a busy Model call strand the fixture.
        if (
          (await Promise.race([exit.then(() => true), delay(1500).then(() => false)])) === false
        ) {
          child.kill("SIGTERM");
          if (
            (await Promise.race([exit.then(() => true), delay(1500).then(() => false)])) === false
          ) {
            child.kill("SIGKILL");
          }
        }
        await Promise.race([
          exit,
          delay(1500).then(() => {
            throw new Error("CLI child did not exit after SIGKILL");
          }),
        ]);
      } finally {
        upstream.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        );
      }
    })();
    return closing;
  };
  const onAbort = () => {
    void close().catch(() => {});
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) await close();
  return {
    childPid: child.pid!,
    upstreamRequests: () => upstreamRequests,
    nextFrame,
    async request(method, params) {
      const id = nextRequestId++;
      child.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
      return await nextFrame((frame) => frame.id === id);
    },
    async close() {
      await close();
      if (!input.signal?.aborted)
        assert.equal(child.exitCode, 0, "native legacy product CLI must exit cleanly");
    },
  };
}
