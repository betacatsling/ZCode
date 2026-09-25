import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";
import { zcodeProtocolMethods } from "@zcode/shared";
import { ReadonlyNativeSessionMetadataView } from "@zcode/adapters/storage";

// Real existing CLI/Registry/fake HTTP child, not a mock session owner or synthetic input.
test(
  "a completed default-selection native draft persists its actual selection before first input",
  { timeout: 45000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "core-native-selection-"));
    const cwd = join(root, "workspace");
    const dbPath = join(root, "session.sqlite");
    await mkdir(cwd);
    let http = 0;
    const server = createServer((_req, res) => {
      http++;
      res.writeHead(500).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");
    const children: ChildProcess[] = [];
    const launch = async () => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          new URL("./native-bootstrap-subprocess.test.ts", import.meta.url).pathname,
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
            ZCODE_BOOT_FIXTURE_URL: `http://127.0.0.1:${addr.port}/fixture`,
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
      const waiters: { predicate: (frame: any) => boolean; resolve: (frame: any) => void }[] = [];
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
        frames.push(frame);
        for (let index = waiters.length - 1; index >= 0; index--) {
          const item = waiters[index]!;
          if (item.predicate(frame)) {
            waiters.splice(index, 1);
            item.resolve(frame);
          }
        }
      });
      const next = (predicate: (frame: any) => boolean) => {
        const found = frames.find(predicate);
        if (found) return Promise.resolve(found);
        return new Promise<any>((resolve, reject) => {
          const item = {
            predicate,
            resolve: (frame: any) => {
              clearTimeout(timer);
              resolve(frame);
            },
          };
          const timer = setTimeout(() => {
            waiters.splice(waiters.indexOf(item), 1);
            reject(new Error(`CLI timeout: ${stderr}`));
          }, 16000);
          waiters.push(item);
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
      };
    };
    try {
      const cli = await launch();
      const capability = await cli.send(3, zcodeProtocolMethods.runtimeCapabilities, {});
      assert.equal(
        capability.result?.nativeCoreCreateV1,
        true,
        "old CLI must be unavailable before native create effect",
      );
      const ack = await cli.send(1, V4_METHODS.command, {
        commandId: "core-default-draft",
        clientId: "desktop",
        sessionId: null,
        type: "createSession",
        issuedAt: 1,
        payload: {
          workspaceId: cwd,
          config: {
            modelSelection: {
              providerId: "fixture",
              modelId: "fixture-model",
              options: { reasoningLevel: "off" },
            },
            mode: "build",
          },
        },
      });
      assert.equal(ack.result?.status, "accepted", JSON.stringify(ack.error ?? ack.result));
      const id = ack.result.result.sessionId as string;
      const view = new ReadonlyNativeSessionMetadataView(dbPath);
      assert.equal(
        (await view.readCreateReceipt("core-default-draft", cwd))?.originalSessionId,
        id,
      );
      const stored = await view.read(id);
      assert.equal(
        stored?.hasSelectionEntry,
        true,
        "completed receipt must not omit matching-default selection",
      );
      assert.deepEqual(stored?.lastSelection, {
        providerId: "fixture",
        modelId: "fixture-model",
        options: { reasoningLevel: "off" },
      });
      const certified = await view.readCertifiedCreateReceipt("core-default-draft", cwd);
      assert.equal(certified?.receipt.originalSessionId, id);
      assert.deepEqual(certified?.selection, stored?.lastSelection);
      assert.deepEqual(certified?.execution, { mode: "build", planEnabled: false });
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(
          (db.prepare("select count(*) as count from session").get() as { count: number }).count,
          1,
        );
      } finally {
        db.close();
      }
      cli.child.kill("SIGKILL");
      await new Promise<void>((resolve) => cli.child.once("exit", resolve));
      const restarted = await launch();
      const query = await restarted.send(2, V4_METHODS.commandsQuery, {
        commands: [{ sessionId: null, commandId: "core-default-draft" }],
      });
      assert.equal(query.result?.results?.[0]?.result?.result?.sessionId, id);
      assert.deepEqual(
        (await view.readCertifiedCreateReceipt("core-default-draft", cwd))?.selection,
        stored?.lastSelection,
      );
      assert.equal(http, 0, "draft must not start Model");
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
