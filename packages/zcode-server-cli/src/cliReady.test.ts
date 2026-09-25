import assert from "node:assert/strict";
import { test } from "node:test";
import { createStoppedServerStatus } from "./contracts.js";
import { waitForSupervisorReady } from "./cli.js";

const ready = {
  ...createStoppedServerStatus("test"),
  state: "ready" as const,
  generation: 1,
  pid: 123,
  host: "127.0.0.1",
  port: 34567,
};

test("synchronously latched READY survives immediate control-stop between CLI polls", async () => {
  const stopped = { ...ready, state: "stopped" as const, pid: null, host: null, port: null };
  // The public status can already be stopped by the time CLI first awaits readiness.
  assert.deepEqual(
    await waitForSupervisorReady(
      { status: () => stopped },
      Promise.resolve(ready),
      Promise.resolve(),
    ),
    ready,
  );
});

test("stop before any READY and crash-loop remain startup failures", async () => {
  const neverReady = new Promise<typeof ready>(() => undefined);
  await assert.rejects(
    waitForSupervisorReady(
      { status: () => createStoppedServerStatus("test") },
      neverReady,
      Promise.resolve(),
    ),
    /stopped before first READY/,
  );
  await assert.rejects(
    waitForSupervisorReady(
      {
        status: () => ({ ...createStoppedServerStatus("test"), state: "crash-loop-stopped" }),
      },
      neverReady,
      new Promise<void>(() => undefined),
    ),
    /crash-loop-stopped/,
  );
});

test("held-ready is internal until exact release creates a public READY transition", async () => {
  let open!: (status: typeof ready) => void;
  const firstReady = new Promise<typeof ready>((resolve) => {
    open = resolve;
  });
  let finished = false;
  const wait = waitForSupervisorReady(
    { status: () => ({ ...ready, state: "starting" as const }) },
    firstReady,
    new Promise<void>(() => undefined),
  ).then((result) => {
    finished = true;
    return result;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  assert.equal(finished, false);
  open(ready); // Supervisor calls onReady only after matching held lease release ACK.
  assert.deepEqual(await wait, ready);
});
