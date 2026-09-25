import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { requestControl } from "../ipc/controlClient.js";
import { ensureServerInstallOwnership } from "../runtime/installationOwnership.js";
import { resolveServerLayout } from "../runtime/paths.js";
import { Supervisor } from "../supervisor/supervisor.js";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Core never became ready");
}

test("Supervisor binds real Core authority child: RPC detach, native fence, fallback hold and explicit stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "core-supervisor-"));
  const layout = resolveServerLayout(join(dir, "server"));
  await ensureServerInstallOwnership(layout);
  const provider = join(dir, "builtin.json");
  await writeFile(provider, "{}\n");
  const fixture = fileURLToPath(new URL("./coreAuthorityChild.fixture.ts", import.meta.url));
  const supervisor = new Supervisor({
    layout,
    version: "fixture",
    launcher: {
      launch: (generation) =>
        fork(fixture, [String(generation)], {
          execArgv: ["--import", import.meta.resolve("tsx")],
          env: {
            ...process.env,
            ZCODE_SERVER_ROOT: layout.serverRoot,
            ZCODE_DATA_BASE_DIR: dir,
            ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: provider,
          },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        }),
    },
  });
  try {
    await supervisor.start();
    await until(() => supervisor.status().state === "ready");
    const status = (await requestControl(layout.controlEndpoint, { command: "status" })) as {
      port: number;
      pid: number;
    };
    assert.equal(status.pid, supervisor.status().pid);
    const response = await fetch(`http://127.0.0.1:${status.port}/api/server-info`);
    assert.equal(response.status, 200);
    await response.body?.cancel(); // the detached RPC reader must not stop Core.
    const child = (supervisor as unknown as { core: import("node:child_process").ChildProcess })
      .core;
    assert.equal(supervisor.status().pid, child.pid);
    const admit = (): Promise<boolean> =>
      new Promise((resolve) => {
        const onMessage = (raw: unknown): void => {
          if (raw && typeof raw === "object" && "type" in raw && raw.type === "fixture-admitted") {
            child.off("message", onMessage);
            resolve((raw as unknown as { accepted: boolean }).accepted);
          }
        };
        child.on("message", onMessage);
        child.send({ command: "fixture-admit" });
      });
    assert.equal(await admit(), true);
    child.send({ command: "fixture-wait" });
    // Same IPC channel orders fixture-wait before the maintenance-begin command.
    await assert.rejects(
      requestControl(layout.controlEndpoint, { command: "begin-fallback-migration" }),
      /active, waiting or uncertain/,
    );
    child.send({ command: "fixture-finish" });
    const first = requestControl(layout.controlEndpoint, { command: "begin-fallback-migration" });
    await first;
    assert.equal(await admit(), false);
    await assert.rejects(
      requestControl(layout.controlEndpoint, { command: "begin-fallback-migration" }),
      /already fenced/,
    );
    await requestControl(layout.controlEndpoint, { command: "end-fallback-migration" });
    assert.equal(await admit(), true);
    assert.deepEqual(await requestControl(layout.controlEndpoint, { command: "stop" }), {
      stopping: true,
    });
    await until(() => supervisor.status().state === "stopped");
  } finally {
    await supervisor.stop("test-cleanup");
    await rm(dir, { recursive: true, force: true });
  }
});
