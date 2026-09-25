import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";
import { ReadonlyNativeSessionMetadataView } from "@zcode/adapters/storage";

// Use the existing real-Registry fake-I/O child mode. No paid or live model request is allowed.
test(
  "real CLI stdio restart recovers original draft ID after lost ACK without model/tool calls",
  { timeout: 45000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "native-create-stdio-"));
    const cwd = join(root, "workspace");
    const dbPath = join(root, "session.sqlite");
    await mkdir(cwd);
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: "fixture-message",
          type: "message",
          role: "assistant",
          model: "fixture-model",
          content: [{ type: "text", text: "fixture reply" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const children = new Set<ChildProcess>();
    const launch = async (barrier = false) => {
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
            ...(barrier ? { ZCODE_BOOT_FIXTURE_CREATE_BARRIER: "1" } : {}),
            ZCODE_BOOT_FIXTURE_CWD: cwd,
            ZCODE_BOOT_FIXTURE_URL: `http://127.0.0.1:${address.port}/fixture-private-endpoint-sentinel`,
            ZCODE_TELEMETRY_ENABLED: "false",
          },
          stdio: ["pipe", "pipe", "pipe", "ipc"],
        },
      );
      children.add(child);
      assert.ok(child.stdin && child.stdout && child.stderr);
      const pending: Array<{ predicate: (frame: any) => boolean; resolve: (frame: any) => void }> =
        [];
      const frames: any[] = [];
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString().slice(0, 500);
      });
      createInterface({ input: child.stdout }).on("line", (line) => {
        let frame: any;
        try {
          frame = JSON.parse(line);
        } catch {
          return;
        }
        if (frame.method === "session/requestRuntimePreferences" && frame.id !== undefined) {
          child.stdin?.write(
            JSON.stringify({
              id: frame.id,
              result: { memoryEnabled: false, nativeSearchEnhancementsEnabled: false },
            }) + "\n",
          );
        }
        frames.push(frame);
        for (let index = pending.length - 1; index >= 0; index--) {
          const request = pending[index]!;
          if (request.predicate(frame)) {
            pending.splice(index, 1);
            request.resolve(frame);
          }
        }
      });
      const next = (predicate: (frame: any) => boolean) => {
        const matched = frames.find(predicate);
        if (matched) return Promise.resolve(matched);
        return new Promise<any>((resolve, reject) => {
          const request = { predicate, resolve };
          pending.push(request);
          const timer = setTimeout(() => {
            pending.splice(pending.indexOf(request), 1);
            reject(new Error(`stdio timed out; stderr=${stderr.slice(0, 300)}`));
          }, 16000);
          request.resolve = (frame) => {
            clearTimeout(timer);
            resolve(frame);
          };
        });
      };
      const send = async (id: number, method: string, params: object) => {
        child.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
        return next((frame) => frame.id === id);
      };
      const committed = () =>
        new Promise<{ commandId: string; sessionId: string }>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`post-COMMIT IPC timed out: ${stderr}`)),
            16000,
          );
          child.once("message", (message: any) => {
            clearTimeout(timer);
            if (message?.kind !== "native-create-committed")
              reject(new Error("unexpected IPC event"));
            else resolve(message);
          });
        });
      await next(
        (frame) => frame.method === "startup/storageState" && frame.params?.phase === "ready",
      );
      return { child, send, committed, frames };
    };
    try {
      const first = await launch();
      const params = {
        commandId: "stable-original-create",
        clientId: "desktop-continuous",
        sessionId: null,
        type: "createSession",
        issuedAt: 1,
        payload: { workspaceId: cwd },
      };
      const [ack, inFlightDuplicate] = await Promise.all([
        first.send(10, V4_METHODS.command, params),
        first.send(18, V4_METHODS.command, { ...params, clientId: "mobile", issuedAt: 2 }),
      ]);
      assert.equal(ack.result?.status, "accepted", JSON.stringify(ack.error ?? ack.result));
      const originalId = ack.result.result.sessionId as string;
      assert.equal(inFlightDuplicate.result?.result?.sessionId, originalId);
      assert.equal(inFlightDuplicate.result?.status, "duplicate");
      // Crash without ACK delivery to the next caller: the durable original must be enough.
      first.child.kill("SIGKILL");
      await new Promise<void>((resolve) => first.child.once("exit", resolve));
      const view = new ReadonlyNativeSessionMetadataView(dbPath);
      assert.equal(
        (await view.readCreateReceipt(params.commandId, cwd))?.originalSessionId,
        originalId,
      );
      const restarted = await launch();
      const query = await restarted.send(11, V4_METHODS.commandsQuery, {
        commands: [{ sessionId: null, commandId: params.commandId }],
      });
      assert.equal(query.result?.results?.[0]?.result?.result?.sessionId, originalId);
      const retry = await restarted.send(12, V4_METHODS.command, {
        ...params,
        clientId: "web-remote-replayable",
        issuedAt: Date.now(),
      });
      assert.equal(retry.result?.result?.sessionId, originalId);
      assert.equal(retry.result?.status, "duplicate");
      const conflict = await restarted.send(13, V4_METHODS.command, {
        ...params,
        payload: { workspaceId: cwd, config: { model: "different-model" } },
      });
      assert.equal(conflict.result?.reasonCode, "guard.nativeCreateIntentConflict");
      const wrongScope = await restarted.send(19, V4_METHODS.command, {
        ...params,
        payload: { workspaceId: join(root, "foreign") },
      });
      assert.equal(wrongScope.result?.reasonCode, "guard.nativeCreateIntentConflict");
      assert.equal(
        await view.readCreateReceipt(params.commandId, join(root, "foreign")),
        undefined,
      );
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(
          (db.prepare("select count(*) as count from session").get() as { count: number }).count,
          1,
        );
      } finally {
        db.close();
      }
      assert.equal(requests, 0, "draft-only create must not invoke a model or tool HTTP request");
      const withInput = {
        ...params,
        commandId: "first-input-create",
        issuedAt: 3,
        payload: { workspaceId: cwd, firstInput: { text: "fixture prompt" } },
      };
      const started = await restarted.send(14, V4_METHODS.command, withInput);
      assert.equal(
        started.result?.status,
        "accepted",
        JSON.stringify(started.error ?? started.result),
      );
      const inputId = started.result.result.sessionId as string;
      const inputQuery = await restarted.send(15, V4_METHODS.commandsQuery, {
        commands: [{ sessionId: null, commandId: withInput.commandId }],
      });
      assert.equal(inputQuery.result?.results?.[0]?.result?.result?.sessionId, inputId);
      const inputDb = new DatabaseSync(dbPath, { readOnly: true });
      let inputStatus: string | undefined;
      try {
        const row = inputDb
          .prepare("select status from session_input where id = ?")
          .get(`queue_${withInput.commandId}`) as { status: string } | undefined;
        assert.ok(row && row.status !== "discarded", "live query must not discard accepted input");
        inputStatus = row.status;
      } finally {
        inputDb.close();
      }
      const metadataInput = await view.readCreateReceipt(withInput.commandId, cwd);
      if (inputStatus === "promoted") assert.equal(metadataInput?.originalSessionId, inputId);
      else assert.equal(metadataInput, undefined);
      const callsBeforeRetry = requests;
      restarted.child.kill("SIGKILL");
      await new Promise<void>((resolve) => restarted.child.once("exit", resolve));
      const recoveredInput = await launch();
      const restartedQuery = await recoveredInput.send(16, V4_METHODS.commandsQuery, {
        commands: [{ sessionId: null, commandId: withInput.commandId }],
      });
      const queriedInput = restartedQuery.result?.results?.[0]?.result;
      assert.equal(queriedInput?.result?.sessionId, inputId);
      if (inputStatus === "admitted") {
        assert.equal(queriedInput?.status, "failed");
        assert.equal(queriedInput?.reasonCode, "fault.command.inputPending");
      } else assert.equal(queriedInput?.status, "accepted");
      const inputRetry = await recoveredInput.send(17, V4_METHODS.command, {
        ...withInput,
        clientId: "web-remote-replayable",
        issuedAt: Date.now(),
      });
      assert.equal(inputRetry.result?.result?.sessionId, inputId);
      assert.equal(inputRetry.result?.status, inputStatus === "admitted" ? "failed" : "duplicate");
      await delay(50);
      assert.equal(requests, callsBeforeRetry, "firstInput duplicate must not call Model again");
      const finalDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(
          (finalDb.prepare("select count(*) as count from session").get() as { count: number })
            .count,
          2,
        );
      } finally {
        finalDb.close();
      }
    } finally {
      for (const child of children)
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);

for (const phase of ["draft", "firstInput", "admitted"] as const) {
  test(`SIGKILL after real CLI COMMIT before ACK (${phase})`, { timeout: 45000 }, async () => {
    const withInput = phase !== "draft";
    const root = await mkdtemp(join(tmpdir(), "native-create-crash-"));
    const cwd = join(root, "workspace");
    const dbPath = join(root, "session.sqlite");
    await mkdir(cwd);
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(500).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const children: ChildProcess[] = [];
    const launch = async (barrier: boolean) => {
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
            ...(barrier && phase !== "admitted" ? { ZCODE_BOOT_FIXTURE_CREATE_BARRIER: "1" } : {}),
            ...(barrier && phase === "admitted" ? { ZCODE_BOOT_FIXTURE_INPUT_BARRIER: "1" } : {}),
            ZCODE_BOOT_FIXTURE_CWD: cwd,
            ZCODE_BOOT_FIXTURE_URL: `http://127.0.0.1:${address.port}/fixture-private-endpoint-sentinel`,
            ZCODE_TELEMETRY_ENABLED: "false",
          },
          stdio: ["pipe", "pipe", "pipe", "ipc"],
        },
      );
      children.push(child);
      const frames: any[] = [];
      let stderr = "";
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString().slice(0, 300);
      });
      createInterface({ input: child.stdout! }).on("line", (line) => {
        try {
          const frame = JSON.parse(line);
          frames.push(frame);
          if (frame.method === "session/requestRuntimePreferences" && frame.id !== undefined)
            child.stdin!.write(
              JSON.stringify({
                id: frame.id,
                result: { memoryEnabled: false, nativeSearchEnhancementsEnabled: false },
              }) + "\n",
            );
        } catch {
          /* non-JSON fixture output */
        }
      });
      const next = async (predicate: (frame: any) => boolean) => {
        for (let attempt = 0; attempt < 1600; attempt++) {
          const frame = frames.find(predicate);
          if (frame) return frame;
          if (child.exitCode !== null) throw new Error(`child exited: ${stderr}`);
          await delay(10);
        }
        throw new Error(`stdio timeout: ${stderr.slice(0, 300)}`);
      };
      const send = (id: number, method: string, params: object) => {
        child.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
        return next((frame) => frame.id === id);
      };
      await next(
        (frame) => frame.method === "startup/storageState" && frame.params?.phase === "ready",
      );
      return { child, frames, send };
    };
    try {
      const first = await launch(true);
      const params = {
        commandId: "pre-ack-create",
        sessionId: null,
        clientId: "desktop-continuous",
        type: "createSession",
        issuedAt: 1,
        payload: {
          workspaceId: cwd,
          ...(withInput ? { firstInput: { text: "do not execute before commit" } } : {}),
        },
      };
      const committed = new Promise<{ kind: string; sessionId: string; commandId: string }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("no post-COMMIT IPC")), 16000);
          first.child.once("message", (message: any) => {
            clearTimeout(timer);
            resolve(message);
          });
        },
      );
      first.child.stdin!.write(
        JSON.stringify({ id: 80, method: V4_METHODS.command, params }) + "\n",
      );
      const proof = await committed;
      assert.equal(
        proof.kind,
        phase === "admitted" ? "native-create-input-admitted" : "native-create-committed",
      );
      if (phase !== "admitted") assert.equal(proof.commandId, params.commandId);
      // Input-admitted IPC follows its durable row; the receipt supplies the original ID.
      if (phase === "admitted") {
        const committedDb = new DatabaseSync(dbPath, { readOnly: true });
        try {
          proof.sessionId = (
            committedDb
              .prepare(
                "select session_id as sessionId from native_create_receipt where command_id = ?",
              )
              .get(params.commandId) as { sessionId: string }
          ).sessionId;
        } finally {
          committedDb.close();
        }
      }
      assert.equal(
        first.frames.some((frame) => frame.id === 80),
        false,
        "no ACK before SIGKILL",
      );
      first.child.kill("SIGKILL");
      await new Promise<void>((resolve) => first.child.once("exit", resolve));
      const view = new ReadonlyNativeSessionMetadataView(dbPath);
      assert.equal(
        await view.readCreateReceipt(params.commandId, cwd),
        undefined,
        "pending cannot be writable",
      );
      const restarted = await launch(false);
      const query = await restarted.send(81, V4_METHODS.commandsQuery, {
        commands: [{ sessionId: null, commandId: params.commandId }],
      });
      const fact = query.result?.results?.[0]?.result;
      assert.equal(fact?.result?.sessionId, proof.sessionId);
      assert.equal(fact?.reasonCode, "fault.command.createPending");
      if (phase === "admitted") {
        const scopedQuery = await restarted.send(83, V4_METHODS.commandsQuery, {
          commands: [{ sessionId: proof.sessionId, commandId: params.commandId }],
        });
        assert.ok(
          scopedQuery.result?.results,
          JSON.stringify(scopedQuery.error ?? scopedQuery.result),
        );
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          assert.equal(
            (
              db
                .prepare("select status from session_input where id = ?")
                .get(`queue_${params.commandId}`) as { status: string }
            ).status,
            "admitted",
            "global query must not discard on cold worker",
          );
        } finally {
          db.close();
        }
        const resumed = await restarted.send(84, V4_METHODS.conversationSubscribe, {
          topic: `conversation/${proof.sessionId}`,
          connectionId: "fixture",
          clientMode: "web-remote-replayable",
        });
        assert.ok(
          resumed.result?.ack?.subscriptionId,
          JSON.stringify(resumed.error ?? resumed.result),
        );
        const afterResume = new DatabaseSync(dbPath, { readOnly: true });
        try {
          const row = afterResume
            .prepare("select status, status_reason as reason from session_input where id = ?")
            .get(`queue_${params.commandId}`) as { status: string; reason: string };
          assert.equal(row.status, "discarded");
          assert.equal(row.reason, "session_resumed");
        } finally {
          afterResume.close();
        }
        const again = await restarted.send(85, V4_METHODS.commandsQuery, {
          commands: [{ sessionId: null, commandId: params.commandId }],
        });
        assert.equal(again.result?.results?.[0]?.result?.result?.sessionId, proof.sessionId);
      }
      const retry = await restarted.send(82, V4_METHODS.command, {
        ...params,
        clientId: "web-remote-replayable",
        issuedAt: 999,
      });
      assert.equal(retry.result?.result?.sessionId, proof.sessionId);
      assert.equal(retry.result?.reasonCode, "fault.command.createPending");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(
          (db.prepare("select count(*) as count from session").get() as { count: number }).count,
          1,
        );
        assert.equal(
          (
            db
              .prepare("select status from native_create_receipt where command_id = ?")
              .get(params.commandId) as { status: string }
          ).status,
          "pending",
        );
        assert.equal(
          (db.prepare("select count(*) as count from session_input").get() as { count: number })
            .count,
          phase === "admitted" ? 1 : 0,
        );
      } finally {
        db.close();
      }
      assert.equal(requests, 0, "no model or tool before/after pending retry");
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
}
