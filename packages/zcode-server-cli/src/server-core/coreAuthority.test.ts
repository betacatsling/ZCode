import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { coreMessageSchema } from "../contracts.js";
import { ensureServerInstallOwnership } from "../runtime/installationOwnership.js";
import { resolveServerLayout } from "../runtime/paths.js";

// This child runs the real Core entry/RPC server and uses an isolated authority factory;
// it does NOT certify the production Node composition until its public factory is mounted.
test("real Core subprocess: one installation-scoped owner, IPC maintenance lease and explicit stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "core-authority-"));
  const layout = resolveServerLayout(join(dir, "server"));
  const ownership = await ensureServerInstallOwnership(layout);
  const provider = join(dir, "builtin.json");
  await writeFile(provider, "{}\n");
  const fixture = fileURLToPath(new URL("./coreAuthorityChild.fixture.ts", import.meta.url));
  const child = fork(fixture, ["7"], {
    execArgv: ["--import", import.meta.resolve("tsx")],
    env: {
      ...process.env,
      ZCODE_SERVER_ROOT: layout.serverRoot,
      ZCODE_DATA_BASE_DIR: dir,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: provider,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const messages: unknown[] = [];
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("message", (message: unknown) => messages.push(message));
  async function next(predicate: (raw: unknown) => boolean): Promise<unknown> {
    for (let i = 0; i < 500; i++) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0];
      if (child.exitCode !== null)
        throw new Error(`Core exited: ${child.exitCode}; ${stderr}; ${JSON.stringify(messages)}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Core reply timed out; ${stderr}; ${JSON.stringify(messages)}`);
  }
  try {
    const options = (await next(
      (m) => !!m && typeof m === "object" && "type" in m && m.type === "factory-options",
    )) as {
      options: {
        installationId: string;
        profileRoot: string;
        zcodeBuiltinProviderConfigFilePath: string;
      };
    };
    assert.equal(options.options.installationId, ownership.installationId);
    assert.equal(options.options.profileRoot, layout.serverRoot);
    assert.equal(options.options.zcodeBuiltinProviderConfigFilePath, provider);
    await next((m) => !!m && typeof m === "object" && "type" in m && m.type === "reconciled");
    const ready = coreMessageSchema.parse(
      await next((m) => !!m && typeof m === "object" && "type" in m && m.type === "ready"),
    );
    assert.equal(ready.type, "ready");
    if (ready.type !== "ready") throw new Error("unexpected reply");
    const result = await fetch(`http://${ready.host}:${ready.port}/api/server-info`);
    assert.equal(result.status, 200);
    await result.body?.cancel(); // Client detach is NOT an authority shutdown.
    const first = randomUUID();
    child.send({ command: "maintenance-begin", requestId: first });
    const held = coreMessageSchema.parse(
      await next(
        (m) =>
          !!m &&
          typeof m === "object" &&
          "type" in m &&
          m.type === "maintenance" &&
          "requestId" in m &&
          m.requestId === first,
      ),
    );
    assert.equal(held.type, "maintenance");
    if (held.type !== "maintenance" || !held.leaseId) throw new Error("lease missing");
    assert.deepEqual(held.nativeActivity, { running: 0, waiting: 0, uncertain: 0 });
    const second = randomUUID();
    child.send({ command: "maintenance-begin", requestId: second });
    const rejected = coreMessageSchema.parse(
      await next(
        (m) =>
          !!m &&
          typeof m === "object" &&
          "type" in m &&
          m.type === "maintenance" &&
          "requestId" in m &&
          m.requestId === second,
      ),
    );
    assert.equal(rejected.type, "maintenance");
    if (rejected.type !== "maintenance") throw new Error("unexpected reply");
    assert.equal(rejected.leaseId, undefined);
    const stale = randomUUID();
    child.send({ command: "maintenance-release", requestId: stale, leaseId: randomUUID() });
    const staleResult = coreMessageSchema.parse(
      await next(
        (m) =>
          !!m &&
          typeof m === "object" &&
          "type" in m &&
          m.type === "maintenance" &&
          "requestId" in m &&
          m.requestId === stale,
      ),
    );
    if (staleResult.type !== "maintenance") throw new Error("unexpected reply");
    assert.equal(staleResult.leaseId, undefined);
    child.send({ command: "fixture-admit" });
    assert.deepEqual(
      await next(
        (m) => !!m && typeof m === "object" && "type" in m && m.type === "fixture-admitted",
      ),
      { type: "fixture-admitted", accepted: false },
    );
    const release = randomUUID();
    child.send({ command: "maintenance-release", requestId: release, leaseId: held.leaseId });
    const released = coreMessageSchema.parse(
      await next(
        (m) =>
          !!m &&
          typeof m === "object" &&
          "type" in m &&
          m.type === "maintenance" &&
          "requestId" in m &&
          m.requestId === release,
      ),
    );
    if (released.type !== "maintenance") throw new Error("unexpected reply");
    assert.equal(released.leaseId, held.leaseId);
    child.send({ command: "shutdown" });
    await next((m) => !!m && typeof m === "object" && "type" in m && m.type === "shutdown-ack");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    if (child.exitCode === null)
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
