import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

async function removeIsolatedProfile(root: string): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 14) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
}

// The first process uses the existing public factory, real Git/Target/Catalog/CLI/SQLite.
// Two independent restarts prove scoped degradation and per-original-ID execution separately.
for (const variant of [
  "damaged",
  "per-id-model",
  "pending",
  "completed",
  "coreCompletedRepair",
  "coreCompletedRetry",
  "coreCompletedArchiveDrain",
  "coreCompletedGitSwap",
  "coreCompletedDisposeDrain",
  "schema",
  "source-db",
  "boot-held",
  "worker-rotation",
  "schema-between",
  "boot-old-command",
] as const)
  test(`public native factory ${variant}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "native-factory-boundaries-"));
    const calls: Array<{ model: string; body: string }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(body) as { model: string; stream?: boolean };
      calls.push({ model: parsed.model, body });
      if (parsed.stream === false) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "msg_fixture",
            type: "message",
            role: "assistant",
            model: parsed.model,
            content: [{ type: "text", text: "fixture completed" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 4, output_tokens: 4 },
          }),
        );
        return;
      }
      const event = (type: string, data: object) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        event("message_start", {
          message: {
            id: "msg_fixture",
            type: "message",
            role: "assistant",
            model: parsed.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 4, output_tokens: 0 },
          },
        }) +
          event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          event("content_block_delta", {
            index: 0,
            delta: { type: "text_delta", text: "fixture completed" },
          }) +
          event("content_block_stop", { index: 0 }) +
          event("message_delta", {
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 4 },
          }) +
          event("message_stop", {}),
      );
    });
    const children: ReturnType<typeof fork>[] = [];
    try {
      const config = join(root, "builtin.json");
      await writeFile(
        config,
        JSON.stringify({
          schemaVersion: 1,
          revision: 0,
          config: {
            providerConfigRules: { templateRules: [], providerRules: [] },
            modelConfigRules: {
              modelRules: [],
              modelApiRules: [],
              providerSiteRules: [],
              templateModelRules: [],
              builtinProviderModelRules: [],
            },
          },
        }),
      );
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const dbPath = join(root, "native.sqlite");
      const baseEnv = {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: root,
        ZCODE_DATA_BASE_DIR: root,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: config,
        CORE_NATIVE_FIXTURE_URL: `http://127.0.0.1:${address.port}/fixture`,
        ZCODE_SESSION_DB_PATH: dbPath,
        ZCODE_TELEMETRY_ENABLED: "false",
        ZCODE_AGENT_SERVER_REQUIRES_STORAGE_STARTUP: "1",
        ZCODE_AGENT_SERVER_BOOT_FENCE_V1: "1", // trusted checked-out CLI fixture, not a credential
        ZCODE_AGENT_SERVER_COMMAND: process.execPath,
        ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([
          "--import",
          import.meta.resolve("tsx"),
          fileURLToPath(
            new URL("../../../../apps/zcode-cli/packages/cli/src/main.ts", import.meta.url),
          ),
          "app-server",
          "--stdio",
        ]),
      };
      const boot = async (fixture: string, env: NodeJS.ProcessEnv, args: string[] = []) => {
        const child = fork(fileURLToPath(new URL(fixture, import.meta.url)), args, {
          cwd: root,
          execArgv: ["--import", import.meta.resolve("tsx")],
          env: { ...baseEnv, ...env },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        children.push(child);
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString().slice(0, 2000);
        });
        // 中文：进程在注册监听前退出、或 Core 无法收尾时都有限时失败并回收自己的子进程。
        const reply = await new Promise<any>((resolve, reject) => {
          const timer = setTimeout(
            () => settle(new Error(`factory fixture timeout: ${stderr}`)),
            40000,
          );
          const onMessage = (message: unknown) => settle(undefined, message);
          const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
            settle(new Error(`factory exited ${code}/${signal}: ${stderr}`));
          function settle(error?: Error, value?: unknown) {
            clearTimeout(timer);
            child.off("message", onMessage);
            child.off("exit", onExit);
            if (error) reject(error);
            else resolve(value);
          }
          child.once("message", onMessage);
          child.once("exit", onExit);
        });
        if (reply?.type === "error" || reply?.type === "native-error")
          throw new Error(JSON.stringify(reply) + stderr);
        if (child.exitCode === null && child.signalCode === null)
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              child.off("exit", onExit);
              child.kill("SIGKILL");
              reject(new Error("factory did not exit"));
            }, 5000);
            const onExit = () => {
              clearTimeout(timer);
              resolve();
            };
            child.once("exit", onExit);
          });
        return reply;
      };
      const first = await boot("./coreNativeMountChild.fixture.ts", {
        ZCODE_MULTI_HARNESS_ENABLED: "1",
        ZCODE_CORE_NATIVE_CREATE_TEST_ONLY: "1",
        CORE_NATIVE_BOOT_FENCE_TEST_ONLY: variant === "per-id-model" ? "1" : "0",
        CORE_INGRESS_ROTATE_WORKER_TEST_ONLY: variant === "worker-rotation" ? "1" : "0",
        CORE_INGRESS_SCHEMA_BETWEEN_TEST_ONLY: variant === "schema-between" ? "1" : "0",
        CORE_NATIVE_SECOND_WORKSPACE_TEST_ONLY: ["pending", "damaged"].includes(variant)
          ? "1"
          : "0",
        CORE_NATIVE_FAILURE_BOUNDARY_TEST_ONLY:
          variant === "coreCompletedRepair" ||
          variant === "coreCompletedRetry" ||
          variant === "coreCompletedArchiveDrain" ||
          variant === "coreCompletedGitSwap" ||
          variant === "coreCompletedDisposeDrain"
            ? "completed"
            : ["pending", "completed", "schema"].includes(variant)
              ? variant
              : "",
        ZCODE_NATIVE_CREATE_POST_COMMIT_PENDING_TEST_ONLY:
          variant === "pending" ? "native-create-pending-boundary" : "",
        ZCODE_CORE_NATIVE_BEFORE_MAPPING_FAULT_TEST_ONLY:
          variant === "completed" ||
          variant === "coreCompletedRepair" ||
          variant === "coreCompletedRetry" ||
          variant === "coreCompletedArchiveDrain" ||
          variant === "coreCompletedGitSwap" ||
          variant === "coreCompletedDisposeDrain"
            ? "native-create-completed-boundary"
            : "",
        ZCODE_CORE_NATIVE_CATALOG_FAULT_TEST_ONLY: "native-create-catalog-fault",
        ZCODE_CORE_NATIVE_DROP_ACK_TEST_ONLY: "native-create-1",
        ZCODE_CORE_NATIVE_MAPPING_FSYNC_FAULT_TEST_ONLY: "native-create-fsync-fault",
      });
      assert.equal(
        first.type,
        variant === "pending" ||
          variant === "completed" ||
          variant === "coreCompletedRepair" ||
          variant === "coreCompletedRetry" ||
          variant === "coreCompletedArchiveDrain" ||
          variant === "coreCompletedGitSwap" ||
          variant === "coreCompletedDisposeDrain"
          ? "boundary-staged"
          : variant === "schema"
            ? "boundary-schema"
            : "native-created",
      );
      assert.equal(first.ids.length, 2);
      assert.equal(first.worktreeCount, 1);
      if (variant === "worker-rotation" || variant === "schema-between") {
        assert.equal(
          first.workerRotation,
          variant === "worker-rotation"
            ? "native-create-owner-changed-before-effect"
            : "unknown-native-session-schema",
        );
        assert.equal(first.raceAllocated, false);
        assert.equal(calls.length, 0);
      }
      const { DatabaseSync } = await import("node:sqlite");
      const count = () => {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          return (db.prepare("select count(*) as total from session").get() as { total: number })
            .total;
        } finally {
          db.close();
        }
      };
      const before = count();
      const mappingPath = join(
        root,
        ".zcode",
        "v2",
        "native-create",
        `${createHash("sha256").update("native-create-1").digest("hex")}.mapping.json`,
      );
      assert.ok((await readFile(mappingPath, "utf8")).includes(first.ids[0]));
      let secondSource: string | undefined;
      let recoveredIds = first.ids;
      if (variant === "source-db") {
        secondSource = join(root, "native-second.sqlite");
        const next = await boot(
          "./coreNativeMountChild.fixture.ts",
          {
            ZCODE_SESSION_DB_PATH: secondSource,
            ZCODE_MULTI_HARNESS_ENABLED: "1",
            ZCODE_CORE_NATIVE_CREATE_TEST_ONLY: "1",
            CORE_NATIVE_FAILURE_BOUNDARY_TEST_ONLY: "",
            ZCODE_CORE_NATIVE_CATALOG_FAULT_TEST_ONLY: "",
            ZCODE_CORE_NATIVE_DROP_ACK_TEST_ONLY: "",
            ZCODE_CORE_NATIVE_MAPPING_FSYNC_FAULT_TEST_ONLY: "",
          },
          ["source-next"],
        );
        assert.equal(next.type, "native-created");
        assert.equal(next.ids.length, 1);
        assert.notEqual(next.ids[0], first.ids[0]);
        recoveredIds = [first.ids[0], next.ids[0]];
        const db = new (await import("node:sqlite")).DatabaseSync(dbPath);
        db.exec("pragma user_version = 1");
        db.close();
      } else if (variant === "damaged") await writeFile(mappingPath, "{damaged");
      else if (variant === "per-id-model") {
        const personal = join(root, ".zcode", "v2", "provider_config.json");
        const settings = JSON.parse(await readFile(personal, "utf8"));
        settings.config.defaultModelSelection.modelId = "fixture-other";
        await writeFile(personal, JSON.stringify(settings));
      }
      const result = await boot(
        variant === "coreCompletedRepair" ||
          variant === "coreCompletedRetry" ||
          variant === "coreCompletedArchiveDrain" ||
          variant === "coreCompletedGitSwap" ||
          variant === "coreCompletedDisposeDrain"
          ? "./coreCompletedRepairChild.fixture.ts"
          : variant === "boot-old-command"
            ? "./coreIngressAuthorityOldChild.fixture.ts"
            : variant === "boot-held"
              ? "./coreIngressAuthorityBootChild.fixture.ts"
              : "./nativeFactoryBoundariesChild.fixture.ts",
        {
          ZCODE_MULTI_HARNESS_ENABLED:
            variant === "boot-held" ||
            variant === "coreCompletedRepair" ||
            variant === "coreCompletedRetry" ||
            variant === "coreCompletedArchiveDrain" ||
            variant === "coreCompletedGitSwap" ||
            variant === "coreCompletedDisposeDrain"
              ? "1"
              : "0",
          ZCODE_CORE_NATIVE_CREATE_TEST_ONLY: "0",
          ...(variant === "boot-old-command"
            ? {
                ZCODE_AGENT_SERVER_BOOT_FENCE_V1: "0",
                ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([
                  "-e",
                  "require('node:fs').writeFileSync(process.env.CORE_OLD_CLI_MARKER,'spawned')",
                ]),
                CORE_OLD_CLI_MARKER: join(root, "old-cli-spawned"),
              }
            : {}),
          ZCODE_SESSION_DB_PATH: secondSource ?? dbPath,
          CORE_NATIVE_IDS: JSON.stringify(recoveredIds),
          CORE_NATIVE_SECOND_WORKSPACE_TEST_ONLY: ["pending", "damaged"].includes(variant)
            ? "1"
            : "0",
          CORE_NATIVE_VERIFY_INPUT: variant === "per-id-model" ? "1" : "0",
          CORE_NATIVE_RECOVER_BOUNDARY_TEST_ONLY:
            variant === "pending" || variant === "completed" ? variant : "",
          CORE_COMPLETED_ORIGINAL_ID: first.originalId,
          CORE_COMPLETED_RETRY_FIRST: variant === "coreCompletedRetry" ? "1" : "0",
        },
        variant === "coreCompletedArchiveDrain"
          ? ["archive-drain"]
          : variant === "coreCompletedGitSwap"
            ? ["git-swap"]
            : variant === "coreCompletedDisposeDrain"
              ? ["dispose-drain"]
              : [],
      );
      if (variant === "boot-old-command") {
        assert.equal(result.type, "old-command-refused");
        assert.equal(result.spawned, false);
        assert.equal(calls.length, 0);
      } else if (variant === "boot-held") {
        assert.equal(result.type, "boot-held");
        assert.equal(result.heldReason, "guard.nativeMaintenanceFrozen");
        assert.equal(result.before, before);
        assert.equal(result.after, before + 1);
        assert.equal(calls.length, 0);
      } else if (variant === "coreCompletedRepair" || variant === "coreCompletedRetry") {
        assert.equal(result.type, "coreCompletedRepair");
        assert.equal(result.originalId, first.originalId);
        assert.equal(result.heldBoot, true);
        assert.equal(result.heldMaintenance, true);
        assert.equal(result.afterRelease, true);
        assert.equal(result.references, 1);
        assert.equal(calls.length, 0);
      } else if (variant === "coreCompletedArchiveDrain") {
        assert.equal(result.type, "coreCompletedArchiveDrain");
        assert.deepEqual(result.order.slice(-1), ["maintenance-granted"]);
        assert.ok(
          result.order.indexOf("repair-completed") < result.order.indexOf("maintenance-granted"),
        );
        assert.ok(
          result.order.indexOf("archive-completed") < result.order.indexOf("maintenance-granted"),
        );
        assert.equal(result.references, 1);
        assert.equal(calls.length, 0);
      } else if (variant === "coreCompletedGitSwap") {
        assert.equal(result.type, "coreCompletedGitSwap");
        assert.equal(result.rejectedBeforeWrite, true);
        assert.equal(calls.length, 0);
      } else if (variant === "coreCompletedDisposeDrain") {
        assert.equal(result.type, "coreCompletedDisposeDrain");
        assert.deepEqual(result.order, ["repair-completed", "disposed"]);
        assert.equal(result.references, 1);
        assert.equal(calls.length, 0);
      } else if (variant === "pending" || variant === "completed") {
        assert.equal(result.type, "boundary-read");
        assert.equal(result.status, variant);
        assert.equal(result.originalId, first.originalId);
        assert.deepEqual(
          result.beforeRepair,
          variant === "pending"
            ? { status: "pending" }
            : { status: "completed-unindexed", originalSessionId: first.originalId },
        );
        assert.equal(result.owner, variant === "completed");
        assert.equal(result.listed, variant === "completed");
        assert.equal(result.unrelated, true);
        if (variant === "pending") {
          assert.deepEqual(result.ownInspect, { status: "pending" });
          assert.deepEqual(result.foreignInspect, { status: "unknown" });
        }
        assert.equal(result.after - result.before, variant === "completed" ? 1 : 0);
        assert.equal(calls.length, 0);
        const catalog = JSON.parse(
          await readFile(
            join(root, ".zcode", "v2", "workspace-hierarchy", "profile", "catalog.json"),
            "utf8",
          ),
        );
        assert.equal(
          catalog.nativeReferences.some(
            (ref: { commandId: string }) => ref.commandId === first.commandId,
          ),
          variant === "completed",
        );
      } else if (variant === "worker-rotation" || variant === "schema-between") {
        assert.equal(result.type, "read");
        assert.equal(result.healthy, true);
        assert.equal(result.sessionIds.length, 2);
        assert.equal(calls.length, 0);
      } else if (variant === "damaged" || variant === "schema" || variant === "source-db") {
        assert.equal(result.type, "read");
        assert.equal(result.healthy, true);
        assert.equal(result.damaged, variant === "damaged" || variant === "source-db");
        if (variant === "damaged") assert.deepEqual(result.foreignInspect, { status: "unknown" });
        if (variant === "damaged" || variant === "source-db") {
          assert.deepEqual(result.inspected, {
            status: "unavailable",
            diagnostic: {
              entryId: createHash("sha256").update("native-create-1").digest("hex"),
              reason: "uncertified-mapping",
            },
          });
        } else assert.deepEqual(result.inspected, { status: "completed" });
        assert.equal(
          result.sessionIds.length,
          variant === "damaged" || variant === "source-db" ? 1 : 2,
          "only certified owners are listed",
        );
        assert.equal(calls.length, 0, "read-only history must not submit an input");
      } else {
        assert.equal(result.type, "input");
        assert.deepEqual(
          result.facts.map((row: { modelId: string }) => row.modelId),
          ["fixture-model", "fixture-other"],
        );
        // 中文：按主命令独有提示关联每个原始 ID；仅检查聚合 some(A) && some(B) 会漏掉互换路由。
        for (const [index, expected] of ["fixture-model", "fixture-other"].entries()) {
          const main = calls.filter((call) => call.body.includes(`proof-original-${index}`));
          assert.ok(main.length > 0, `missing actual input for original ${index}`);
          assert.ok(
            main.every((call) => call.model === expected),
            `original ${index} used another model: ${JSON.stringify(main.map((call) => call.model))}`,
          );
        }
      }
      assert.equal(count(), before + (variant === "boot-held" ? 1 : 0));
    } finally {
      const childResults = await Promise.allSettled(
        children.map(async (child) => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              child.off("exit", onExit);
              reject(new Error("owned factory child did not exit after bounded kill"));
            }, 5000);
            const onExit = () => {
              clearTimeout(timer);
              resolve();
            };
            child.once("exit", onExit);
            child.kill("SIGKILL");
          });
        }),
      );
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await removeIsolatedProfile(root);
      for (const result of childResults) {
        // eslint-disable-next-line no-unsafe-finally -- unreaped owned child is more serious than the assertion it interrupts.
        if (result.status === "rejected") throw result.reason;
      }
    }
  });
