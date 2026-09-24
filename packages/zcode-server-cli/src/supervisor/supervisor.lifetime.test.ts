import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveServerLayout } from "../runtime/paths.js";
import { requestControl } from "../ipc/controlClient.js";
import { Supervisor } from "./supervisor.js";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Fixture did not reach expected state");
}

test("real Core child continues output after client disconnect; crash retains uncertainty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-lifetime-"));
  const layout = resolveServerLayout(join(dir, "server"));
  const output = join(dir, "core-output");
  const fixture = join(dir, "core.cjs");
  const client = join(dir, "client.cjs");
  await writeFile(
    fixture,
    `
const fs = require('node:fs');
let sequence = 0;
const timer = setInterval(() => fs.appendFileSync(process.env.OUTPUT, String(++sequence) + '\\n'), 20);
process.send({ type: 'ready', host: '127.0.0.1', port: 41414, version: 'test', generation: Number(process.argv[2]) });
process.send({ type: 'heartbeat', at: Date.now(), runningTaskCount: 0, externalActivity: { running: 0, waiting: 0, uncertain: 0 } });
process.on('message', message => {
  if (message.command === 'shutdown') { clearInterval(timer); process.exit(0); }
  if (message.command === 'activity') process.send({ type: 'activity', requestId: message.requestId, runningTaskCount: 0, externalActivity: { running: 0, waiting: 1, uncertain: 0 } });
});
`,
  );
  await writeFile(
    client,
    `
const net = require('node:net');
const socket = net.connect(process.argv[2]);
socket.on('connect', () => socket.write(JSON.stringify({ command: 'status', id: 'client' }) + '\\n'));
socket.on('data', () => socket.end());
`,
  );
  const supervisor = new Supervisor({
    layout,
    version: "test",
    launcher: {
      launch: (generation) =>
        fork(fixture, [String(generation)], {
          env: { ...process.env, OUTPUT: output },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        }),
    },
  });
  try {
    await supervisor.start();
    await until(
      () =>
        supervisor.status().state === "ready" &&
        supervisor.status().externalActivity.uncertain === 0,
    );
    const cli = spawn(process.execPath, [client, layout.controlEndpoint], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      cli.once("error", reject);
      cli.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`client exited ${code}`)),
      );
    });
    const before = (await readFile(output, "utf8")).trim().split("\n").length;
    await until(
      async () => (await readFile(output, "utf8")).trim().split("\n").length > before + 2,
    );
    assert.equal(supervisor.status().state, "ready");
    // Initial idle heartbeat is stale: fresh Core roundtrip must see waiting approval.
    assert.deepEqual(
      await requestControl(layout.controlEndpoint, { command: "prepare-uninstall" }),
      {
        status: "blocked",
        runningTaskCount: 0,
      },
    );
    await assert.rejects(
      requestControl(layout.controlEndpoint, {
        command: "confirm-uninstall",
        confirmation: "DELETE",
      }),
      /active, waiting or uncertain/,
    );
    process.kill(supervisor.status().pid!, "SIGKILL");
    await until(() => supervisor.status().state === "crashed");
    assert.equal(supervisor.status().externalActivity.uncertain, 1);
    await until(
      () => supervisor.status().state === "ready" && supervisor.status().generation === 2,
    );
    // Explicit operator stop is distinct from detach/automatic maintenance and stays available.
    assert.deepEqual(await requestControl(layout.controlEndpoint, { command: "stop" }), {
      stopping: true,
    });
    await until(() => supervisor.status().state === "stopped");
  } finally {
    await supervisor.stop("test-cleanup");
    await rm(dir, { recursive: true, force: true });
  }
});
