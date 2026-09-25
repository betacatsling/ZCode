import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createMaintenanceCoordination } from "../src/workspace-hierarchy/maintenance.js";
import { createNodeMaintenanceLeaseHandler } from "../src/maintenance-lease.js";

test("maintenance freezes admission before fresh native+external activity and holds through action", async () => {
  const sequence: string[] = [];
  let releaseAdmission!: () => void;
  const unfinished = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const coordination = createMaintenanceCoordination({
    nativeFence: async () => {
      sequence.push("native:frozen");
      return { verify: async () => true, release: async () => {
        sequence.push("native:unfrozen");
      } };
    },
    activity: async () => {
      sequence.push("fresh:activity");
      return { running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false };
    },
  });
  const admitted = coordination.withAdmission(async () => {
    sequence.push("accepted");
    entered();
    await unfinished;
    sequence.push("finished");
  });
  await ready;
  const updating = coordination.withMaintenance(async () => {
    sequence.push("update");
    assert.equal(coordination.admissionEnabled(), false);
  });
  await assert.rejects(
    coordination.withAdmission(async () => {}),
    /frozen/,
  );
  assert.equal(sequence.includes("fresh:activity"), false);
  releaseAdmission();
  await admitted;
  await updating;
  assert.deepEqual(sequence, [
    "accepted",
    "native:frozen",
    "finished",
    "fresh:activity",
    "update",
    "native:unfrozen",
  ]);
  assert.equal(coordination.admissionEnabled(), true);
});

test("unknown/offline activity rejects automatic maintenance and unfreezes native without running action", async () => {
  let released = false;
  let performed = false;
  const coordination = createMaintenanceCoordination({
    nativeFence: async () => ({ verify: async () => true, release: async () => {
      released = true;
    } }),
    activity: async () => ({ running: 0, waiting: 0, tools: 1, uncertain: 1, offline: true }),
  });
  await assert.rejects(
    coordination.withMaintenance(async () => {
      performed = true;
    }),
    /busy or uncertain/,
  );
  assert.equal(performed, false);
  assert.equal(released, true);
  assert.equal(coordination.admissionEnabled(), true);
});

test("RPC lease survives separate messages, rejects stale epochs/duplicates without unfreezing", async () => {
  const sequence: string[] = [];
  const port = createMaintenanceCoordination({
    nativeFence: async () => {
      sequence.push("native:frozen");
      return { verify: async () => true, release: async () => {
        sequence.push("native:released");
      } };
    },
    activity: async () => {
      sequence.push("activity");
      return { running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false };
    },
  });
  const rpc = createNodeMaintenanceLeaseHandler(port);
  const lease = await rpc(JSON.parse(JSON.stringify({ command: "freezeAdmissions" })));
  assert.equal(typeof lease, "object");
  assert.deepEqual(sequence, ["native:frozen", "activity"]);
  await assert.rejects(
    port.withAdmission(async () => {}),
    /frozen/,
  );
  await assert.rejects(rpc({ command: "freezeAdmissions" }), /already/);
  await assert.rejects(
    rpc({ command: "releaseAdmissions", lease: { ...(lease as object), epoch: -1 } }),
    /lease/,
  );
  assert.equal(port.admissionEnabled(), false);
  await rpc(JSON.parse(JSON.stringify({ command: "releaseAdmissions", lease })));
  assert.deepEqual(sequence, ["native:frozen", "activity", "native:released"]);
  const next = await rpc({ command: "freezeAdmissions" });
  await assert.rejects(rpc({ command: "releaseAdmissions", lease }), /lease/);
  assert.equal(port.admissionEnabled(), false);
  await rpc({ command: "releaseAdmissions", lease: next });
  await assert.rejects(rpc({ command: "releaseAdmissions", lease: next }), /lease/);
});

test("native acquire ambiguity fails closed; release failure does not reopen workspace admission", async () => {
  const acquire = createMaintenanceCoordination({
    nativeFence: async () => {
      throw new Error("unknown CLI fence state");
    },
    activity: async () => ({ running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false }),
  });
  await assert.rejects(acquire.freezeAdmissions(), /unknown CLI fence state/);
  assert.equal(acquire.admissionEnabled(), false);
  const release = createMaintenanceCoordination({
    nativeFence: async () => ({ verify: async () => true, release: async () => {
      throw new Error("CLI release uncertain");
    } }),
    activity: async () => ({ running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false }),
  });
  const lease = await release.freezeAdmissions();
  await assert.rejects(release.releaseAdmissions(lease), /CLI release uncertain/);
  assert.equal(release.admissionEnabled(), false);
  await assert.rejects(release.freezeAdmissions(), /already/);
});

test("failed fresh check releases only acquired fence and leaves admissions open", async () => {
  let releases = 0;
  const port = createMaintenanceCoordination({
    nativeFence: async () => ({ verify: async () => true, release: async () => {
      releases++;
    } }),
    activity: async () => {
      throw new Error("activity offline");
    },
  });
  await assert.rejects(port.freezeAdmissions(), /activity offline/);
  assert.equal(releases, 1);
  assert.equal(port.admissionEnabled(), true);
});

test("child Core retains lease across IPC while Supervisor messages race with accepted admission", async () => {
  const loader = createRequire(import.meta.url).resolve("tsx");
  const child = fork(
    fileURLToPath(new URL("./fixtures/maintenanceLeaseChild.ts", import.meta.url)),
    [],
    {
      execArgv: ["--import", loader],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let id = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object" || !("id" in message)) return;
    const reply = message as { id: number; result?: unknown; error?: string };
    const item = pending.get(reply.id);
    if (!item) return;
    pending.delete(reply.id);
    if (reply.error) item.reject(new Error(reply.error));
    else item.resolve(reply.result);
  });
  const request = (payload: unknown): Promise<unknown> => {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      child.send({ id: requestId, request: payload });
    });
  };
  try {
    assert.equal(await request("test:admit"), "accepted");
    const freeze = request({ command: "freezeAdmissions" });
    await assert.rejects(request({ command: "freezeAdmissions" }), /already/);
    await assert.rejects(
      request({ command: "releaseAdmissions", lease: { token: "wrong", epoch: 1 } }),
      /lease/,
    );
    assert.equal(await request("test:finish"), "finished");
    const lease = await freeze;
    assert.equal(typeof (lease as { token: string }).token, "string");
    await assert.rejects(request({ command: "freezeAdmissions" }), /already/);
    assert.deepEqual(await request({ command: "releaseAdmissions", lease }), { released: true });
    await assert.rejects(request({ command: "releaseAdmissions", lease }), /lease/);
  } finally {
    child.disconnect();
    child.kill();
    for (const item of pending.values()) item.reject(new Error("child closed"));
  }
});

test("real native control lease is verified after workspace drain; positive activity releases its own lease", async () => {
  const { createNativeAdmissionFence } = await import("../src/maintenance-lease.js");
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let checks = 0;
  const released: unknown[] = [];
  const nativeLease = { epoch: "0195ab00-0000-4000-8000-000000000019", leaseId: "worker-19" };
  const activity = { epoch: nativeLease.epoch, frozen: true, active: 0, accepted: 0, pending: 0, tools: 0, approvals: 0, unknown: false };
  const nativeFence = createNativeAdmissionFence({
    freeze: async () => ({ lease: nativeLease, activity }),
    getActivity: async (_target, lease) => {
      assert.equal(lease, nativeLease);
      checks++;
      return { ...activity, pending: 1 };
    },
    release: async (_target, lease) => { released.push(lease); return true; },
  }, { workspacePath: "/fixture" });
  const port = createMaintenanceCoordination({ nativeFence,
    activity: async () => ({ running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false }) });
  const inflight = port.withAdmission(async () => {
    entered();
    await new Promise<void>((resolve) => { finish = resolve; });
  });
  await started;
  const freezing = port.freezeAdmissions();
  assert.equal(checks, 0);
  finish();
  await inflight;
  await assert.rejects(freezing, /busy or uncertain/);
  assert.equal(checks, 1);
  assert.deepEqual(released, [nativeLease]);
  assert.equal(port.admissionEnabled(), true);
});

test("changed native epoch, unknown worker, or denied release cannot certify maintenance idle", async () => {
  const { createNativeAdmissionFence } = await import("../src/maintenance-lease.js");
  const lease = { epoch: "0195ab00-0000-4000-8000-000000000007", leaseId: "old-worker" };
  const activity = { epoch: lease.epoch, frozen: true, active: 0, accepted: 0, pending: 0, tools: 0, approvals: 0, unknown: false };
  for (const later of [{ ...activity, epoch: "0195ab00-0000-4000-8000-000000000008" }, { ...activity, unknown: true }]) {
    let releaseCount = 0;
    const port = createMaintenanceCoordination({
      nativeFence: createNativeAdmissionFence({
        freeze: async () => ({ lease, activity }),
        getActivity: async () => later,
        release: async () => { releaseCount++; return true; },
      }, { workspacePath: "/fixture" }),
      activity: async () => ({ running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false }),
    });
    await assert.rejects(port.freezeAdmissions(), /native maintenance/);
    assert.equal(releaseCount, 0);
    assert.equal(port.admissionEnabled(), false);
  }
  const port = createMaintenanceCoordination({
    nativeFence: createNativeAdmissionFence({
      freeze: async () => ({ lease, activity }),
      getActivity: async () => activity,
      release: async () => false,
    }, { workspacePath: "/fixture" }),
    activity: async () => ({ running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false }),
  });
  const owned = await port.freezeAdmissions();
  await assert.rejects(port.releaseAdmissions(owned), /native maintenance/);
  assert.equal(port.admissionEnabled(), false);
});

test("legacy release-only callback cannot mint an automatic shutdown lease", async () => {
  let releaseCount = 0;
  const port = createMaintenanceCoordination({
    nativeFence: async () => async () => { releaseCount++; },
    activity: async () => ({ running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false }),
  });
  await assert.rejects(port.freezeAdmissions(), /Unverifiable native maintenance fence/);
  assert.equal(releaseCount, 0);
  assert.equal(port.admissionEnabled(), false);
});
