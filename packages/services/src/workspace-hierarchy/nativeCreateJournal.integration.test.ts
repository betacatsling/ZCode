import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";
import { zcodeProtocolMethods } from "@zcode/shared";
import { NativeCreateJournal } from "./nativeCreateJournal.js";

// Isolated child runs the existing actual CLI stdio/SQLite + fake Registry fixture, not a Core allocator.
test(
  "real CLI completed ACK dropped before caller, readonly mapping recovers same original ID after restart",
  { timeout: 45000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "core-native-new-map-"));
    const cwd = join(root, "workspace");
    const dbPath = join(root, "sessions.sqlite");
    await mkdir(cwd);
    let httpCalls = 0;
    const server = createServer((_req, res) => {
      httpCalls++;
      res.writeHead(500).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const children: ChildProcess[] = [];
    const launch = async () => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          new URL(
            "../../../../apps/zcode-cli/packages/bootstrap/src/native-bootstrap-subprocess.test.ts",
            import.meta.url,
          ).pathname,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: root,
            XDG_CONFIG_HOME: root,
            ZCODE_DATA_BASE_DIR: root,
            ZCODE_SESSION_DB_PATH: dbPath,
            ZCODE_NATIVE_BOOT_FIXTURE_CHILD: "1",
            ZCODE_BOOT_FIXTURE_CWD: cwd,
            ZCODE_BOOT_FIXTURE_URL: `http://127.0.0.1:${address.port}/fixture`,
            ZCODE_TELEMETRY_ENABLED: "false",
          },
          stdio: ["pipe", "pipe", "pipe", "ipc"],
        },
      );
      children.push(child);
      let stderr = "";
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString().slice(0, 300);
      });
      const frames: any[] = [];
      const droppedResponses = new Map<number, () => void>();
      const waiters: Array<{ predicate: (value: any) => boolean; resolve: (value: any) => void }> =
        [];
      createInterface({ input: child.stdout! }).on("line", (line) => {
        let frame: any;
        try {
          frame = JSON.parse(line);
        } catch {
          return;
        }
        if (frame.method === "session/requestRuntimePreferences" && frame.id !== undefined)
          child.stdin!.write(
            JSON.stringify({
              id: frame.id,
              result: { memoryEnabled: false, nativeSearchEnhancementsEnabled: false },
            }) + "\n",
          );
        // 中文：真实 stdio 子进程已经完成写库，但 Core 调用方的传输层丢弃完成 ACK；
        // 不从 ACK 提取 ID，也不把 pending post-COMMIT 崩溃冒充完成丢包。
        const dropped = droppedResponses.get(frame.id);
        if (dropped) {
          droppedResponses.delete(frame.id);
          dropped();
          return;
        }
        frames.push(frame);
        for (let i = waiters.length - 1; i >= 0; i--)
          if (waiters[i]!.predicate(frame)) {
            waiters.splice(i, 1)[0]!.resolve(frame);
          }
      });
      const next = (predicate: (value: any) => boolean) => {
        const found = frames.find(predicate);
        if (found) return Promise.resolve(found);
        return new Promise<any>((resolve, reject) => {
          const waiter = { predicate, resolve };
          const timer = setTimeout(() => {
            const i = waiters.indexOf(waiter);
            if (i >= 0) waiters.splice(i, 1);
            reject(new Error(`CLI timeout: ${stderr}`));
          }, 16000);
          waiter.resolve = (frame: any) => {
            clearTimeout(timer);
            resolve(frame);
          };
          waiters.push(waiter);
        });
      };
      await next(
        (frame) => frame.method === "startup/storageState" && frame.params?.phase === "ready",
      );
      return {
        child,
        send: (id: number, method: string, params: object) => {
          child.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
          return next((frame) => frame.id === id);
        },
        sendWithLostAck: (id: number, method: string, params: object) =>
          new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`CLI lost-ACK barrier timeout: ${stderr}`)),
              16000,
            );
            droppedResponses.set(id, () => {
              clearTimeout(timer);
              resolve();
            });
            child.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
          }),
      };
    };
    try {
      const cli = await launch();
      const capability = await cli.send(1, zcodeProtocolMethods.runtimeCapabilities, {});
      assert.equal(capability.result?.nativeCoreCreateV1, true);
      const payload = {
        workspaceId: cwd,
        config: {
          modelSelection: {
            providerId: "fixture",
            modelId: "fixture-model",
            options: { reasoningLevel: "off" },
          },
          mode: "build",
        },
      };
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            config: {
              mode: "build",
              modelSelection: {
                modelId: "fixture-model",
                options: { reasoningLevel: "off" },
                providerId: "fixture",
              },
            },
            workspaceId: cwd,
          }),
        )
        .digest("hex");
      const journal = new NativeCreateJournal(join(root, "native-create"));
      const intent = {
        schemaVersion: 1 as const,
        commandId: "core-real-draft",
        targetId: "target",
        projectId: "project",
        workspaceId: "catalog-uuid-not-path",
        repositoryBindingId: "binding",
        worktreeGeneration: "generation-1",
        workspaceIdentity: cwd,
        workspacePath: cwd,
        cwdRelativeToWorktree: ".",
        modelBinding: { kind: "host-managed" as const, selection: payload.config.modelSelection },
        nativeDatabasePath: dbPath,
        databaseId: createHash("sha256").update(dbPath).digest("hex"),
        intentFingerprint: fingerprint,
      };
      await journal.stage(intent);
      assert.equal((await journal.read(intent.commandId))?.mapping, undefined);
      await cli.sendWithLostAck(2, V4_METHODS.command, {
        commandId: intent.commandId,
        clientId: "desktop",
        sessionId: null,
        type: "createSession",
        issuedAt: 1,
        payload,
      });
      // The caller never receives the ACK; only CLI-owned read-only SQLite proves completion.
      const mismatched = new NativeCreateJournal(join(root, "mismatched-provenance"));
      await mismatched.stage({ ...intent, intentFingerprint: "0".repeat(64) });
      await assert.rejects(mismatched.complete(intent.commandId), /uncertain/);
      assert.equal((await mismatched.read(intent.commandId))?.mapping, undefined);
      const mapping = await journal.complete(intent.commandId);
      const original = mapping.originalSessionId;
      cli.child.kill("SIGKILL");
      await new Promise<void>((resolve) => cli.child.once("exit", resolve));
      const recovered = await new NativeCreateJournal(join(root, "native-create")).read(
        intent.commandId,
      );
      assert.equal(recovered?.mapping?.originalSessionId, original);
      assert.equal(httpCalls, 0, "creating a draft must not start a Model turn");
      await assert.rejects(
        journal.stage({
          ...intent,
          modelBinding: {
            kind: "host-managed",
            selection: { providerId: "fixture", modelId: "other" },
          },
        }),
        /conflict/,
      );
      const restarted = await launch();
      const query = await restarted.send(3, V4_METHODS.commandsQuery, {
        commands: [{ sessionId: null, commandId: intent.commandId }],
      });
      assert.equal(query.result?.results?.[0]?.result?.result?.sessionId, original);
      assert.equal((await journal.complete(intent.commandId)).originalSessionId, original);
    } finally {
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          child.kill("SIGKILL");
          await exited;
        }),
      );
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
