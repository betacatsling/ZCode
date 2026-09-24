import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requestControl } from "../ipc/controlClient.js";
import { resolveServerLayout } from "../runtime/paths.js";
import { Supervisor } from "./supervisor.js";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("fixture did not settle");
}

test("subprocess IPC: detach survives; freeze races admission; fallback holds until release; explicit stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "core-maintenance-"));
  const layout = resolveServerLayout(join(dir, "server"));
  const fixture = join(dir, "core.cjs");
  await writeFile(
    fixture,
    `
const { randomUUID } = require('node:crypto');
let lease, pending = false, admission = 0, waiting = 0;
const activity = () => ({ running: 0, waiting, uncertain: 0 });
process.send({ type: 'ready', host: '127.0.0.1', port: 40123, version: 'test', generation: Number(process.argv[2]) });
process.on('message', m => {
  if (m.command === 'shutdown') process.exit(0);
  if (m.command === 'activity') process.send({ type: 'activity', requestId: m.requestId, runningTaskCount: 0, externalActivity: activity() });
  if (m.command === 'maintenance-begin') {
    if (lease || pending) return process.send({ type: 'maintenance', requestId: m.requestId });
    pending = true;
    setTimeout(() => {
      lease = randomUUID(); pending = false;
      process.send({ type: 'maintenance', requestId: m.requestId, leaseId: lease,
        nativeActivity: activity(), externalActivity: activity() });
    }, 60);
  }
  if (m.command === 'maintenance-release') {
    if (lease === m.leaseId) { lease = undefined; process.send({ type: 'maintenance', requestId: m.requestId, leaseId: m.leaseId }); }
    else process.send({ type: 'maintenance', requestId: m.requestId });
  }
  if (m.command === 'admit') { if (!lease && !pending) { admission++; waiting++; } process.send({ type: 'admitted', accepted: admission }); }
  if (m.command === 'finish') waiting = 0;
});
`,
  );
  const supervisor = new Supervisor({
    layout,
    version: "test",
    launcher: {
      launch: (generation) =>
        fork(fixture, [String(generation)], { stdio: ["ignore", "ignore", "ignore", "ipc"] }),
    },
  });
  try {
    await supervisor.start();
    await until(() => supervisor.status().state === "ready");
    // A control client detaches; Core remains the same process and maintains the accepted activity.
    assert.equal(
      ((await requestControl(layout.controlEndpoint, { command: "status" })) as { pid: number })
        .pid,
      supervisor.status().pid,
    );
    const core = (supervisor as unknown as { core: import("node:child_process").ChildProcess })
      .core;
    const admit = (): Promise<number> =>
      new Promise((resolve) => {
        const listener = (raw: unknown): void => {
          if (typeof raw === "object" && raw && "type" in raw && raw.type === "admitted") {
            core.off("message", listener);
            resolve((raw as unknown as { accepted: number }).accepted);
          }
        };
        core.on("message", listener);
        core.send({ command: "admit" });
      });
    assert.equal(await admit(), 1);
    const first = requestControl(layout.controlEndpoint, { command: "begin-fallback-migration" });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await assert.rejects(
      requestControl(layout.controlEndpoint, { command: "begin-fallback-migration" }),
      /already in progress/,
    );
    assert.equal(await admit(), 1, "new admission is fenced while maintenance begins");
    await assert.rejects(first, /active, waiting or uncertain/);
    core.send({ command: "finish" });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await requestControl(layout.controlEndpoint, { command: "begin-fallback-migration" });
    assert.equal(await admit(), 1, "fence held across control roundtrips");
    await assert.rejects(
      requestControl(layout.controlEndpoint, { command: "begin-fallback-migration" }),
      /already fenced/,
    );
    await requestControl(layout.controlEndpoint, { command: "end-fallback-migration" });
    assert.equal(await admit(), 2);
    assert.deepEqual(await requestControl(layout.controlEndpoint, { command: "stop" }), {
      stopping: true,
    });
    await until(() => supervisor.status().state === "stopped");
  } finally {
    await supervisor.stop("test-cleanup");
    await rm(dir, { recursive: true, force: true });
  }
});
