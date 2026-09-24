import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requestControl } from "../ipc/controlClient.js";
import { resolveServerLayout } from "../runtime/paths.js";
import { ReleaseManager } from "../runtime/releaseManager.js";
import { Supervisor } from "./supervisor.js";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 180; i++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("generation fixture deadline exceeded");
}

async function bounded<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("generation fixture barrier timed out")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const fixtureSource = `
const { randomUUID } = require('node:crypto');
const generation = Number(process.argv[2]);
let lease;
const idle = { running: 0, waiting: 0, uncertain: 0 };
process.send({type:'ready', host:'127.0.0.1', port:40042, version:'fixture', generation});
process.on('message', m => {
 if (m.command === 'shutdown') process.exit(0);
 if (m.command === 'maintenance-begin') {
   lease = randomUUID(); process.send({type:'maintenance', requestId:m.requestId, leaseId:lease, nativeActivity:idle, externalActivity:idle});
 }
 if (m.command === 'maintenance-release') process.send({type:'maintenance', requestId:m.requestId, leaseId:m.leaseId === lease ? lease : undefined});
});
`;

test("old update lease cannot stop a replacement after pointer-read await", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supervisor-generation-"));
  const layout = resolveServerLayout(join(dir, "server"));
  const source = join(dir, "core.cjs");
  await writeFile(source, fixtureSource);
  const releaseDir = join(layout.releasesDir, "candidate");
  await mkdir(releaseDir, { recursive: true });
  const releases = new ReleaseManager(layout);
  const children: import("node:child_process").ChildProcess[] = [];
  const supervisor = new Supervisor({
    layout,
    version: "test",
    coreStopGraceTimeoutMs: 100,
    coreKillTimeoutMs: 100,
    launcher: {
      launch: (generation) => {
        const child = fork(source, [String(generation)], {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        children.push(child);
        return child;
      },
    },
  });
  let entered!: () => void;
  let resume!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const originalRead = releases.readCurrent.bind(releases);
  let applying: Promise<unknown> | undefined;
  let reads = 0;
  try {
    await supervisor.start();
    await until(() => supervisor.status().state === "ready");
    (supervisor as unknown as { releaseManager: ReleaseManager }).releaseManager.readCurrent =
      async () => {
        if (++reads === 1) {
          entered();
          await barrier;
        }
        return originalRead();
      };
    const oldPid = supervisor.status().pid!;
    await releases.writePending({ version: "candidate", releaseDir });
    applying = requestControl(layout.controlEndpoint, { command: "apply-update" });
    void applying.catch(() => undefined);
    await bounded(reached);
    process.kill(oldPid, "SIGKILL");
    await until(() => supervisor.status().state === "crashed");
    assert.equal(supervisor.status().generation, 1, "update gate defers automatic restart");
    resume();
    await assert.rejects(applying, /generation|lease|Core.*changed|unsafe/i);
    await until(
      () => supervisor.status().state === "ready" && supervisor.status().generation === 2,
    );
    const replacementPid = supervisor.status().pid!;
    assert.notEqual(replacementPid, oldPid);
    assert.equal(supervisor.status().pid, replacementPid);
    children[0]!.emit("message", {
      type: "ready",
      host: "old",
      port: 49999,
      version: "stale",
      generation: 1,
    });
    children[0]!.emit("message", {
      type: "heartbeat",
      at: Date.now(),
      runningTaskCount: 42,
      externalActivity: { running: 42, waiting: 0, uncertain: 0 },
    });
    children[0]!.emit("message", { type: "fatal", message: "stale child" });
    children[0]!.emit("close", 1, null);
    assert.equal(supervisor.status().pid, replacementPid);
    assert.equal(supervisor.status().runningTaskCount, 0);
    assert.equal(supervisor.status().externalActivity.uncertain, 1);
    assert.equal(supervisor.status().state, "ready");
    assert.equal((await releases.readPending())?.version, "candidate");
    assert.equal(await releases.readCurrent(), null);
    assert.equal(
      await readFile(layout.updateTransactionFile, "utf8").then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    resume();
    await bounded(applying?.catch(() => undefined) ?? Promise.resolve());
    await supervisor.stop("fixture-cleanup");
    await rm(dir, { recursive: true, force: true });
  }
});

test("old maintenance release does not clear a replacement generation lease", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supervisor-generation-"));
  const layout = resolveServerLayout(join(dir, "server"));
  const source = join(dir, "core.cjs");
  await writeFile(source, fixtureSource);
  const supervisor = new Supervisor({
    layout,
    version: "test",
    launcher: {
      launch: (generation) =>
        fork(source, [String(generation)], { stdio: ["ignore", "ignore", "ignore", "ipc"] }),
    },
  });
  try {
    await supervisor.start();
    await until(() => supervisor.status().state === "ready");
    const privateSupervisor = supervisor as unknown as {
      beginMaintenance(): Promise<{ release(): Promise<void> }>;
    };
    const old = await privateSupervisor.beginMaintenance();
    process.kill(supervisor.status().pid!, "SIGKILL");
    await until(
      () => supervisor.status().state === "ready" && supervisor.status().generation === 2,
    );
    await requestControl(layout.controlEndpoint, { command: "begin-fallback-migration" });
    await old.release();
    await assert.rejects(
      requestControl(layout.controlEndpoint, { command: "begin-fallback-migration" }),
      /already fenced|already in progress/,
    );
    await requestControl(layout.controlEndpoint, { command: "end-fallback-migration" });
  } finally {
    await supervisor.stop("fixture-cleanup");
    await rm(dir, { recursive: true, force: true });
  }
});

test("candidate remains fenced until pointer transaction commits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supervisor-generation-"));
  const layout = resolveServerLayout(join(dir, "server"));
  const source = join(dir, "core.cjs");
  await writeFile(
    source,
    `
const { randomUUID } = require('node:crypto');
const generation = Number(process.argv[2]);
let lease = process.argv[3] === 'held' ? randomUUID() : undefined;
const idle = {running:0,waiting:0,uncertain:0};
process.send({type:'ready',host:'127.0.0.1',port:40042,version:'fixture',generation,...(lease && {bootLeaseId:lease})});
process.on('message', m => {
 if (m.command === 'shutdown') process.exit(0);
 if (m.command === 'maintenance-begin') { lease = randomUUID(); process.send({type:'maintenance',requestId:m.requestId,leaseId:lease,nativeActivity:idle,externalActivity:idle}); }
 if (m.command === 'maintenance-release') {
   const match = lease === m.leaseId; if (match) lease = undefined;
   process.send({type:'maintenance',requestId:m.requestId,...(match && {leaseId:m.leaseId})});
 }
 if (m.command === 'fixture-admit') process.send({type:'fixture-admitted',accepted:!lease});
});
`,
  );
  const releaseDir = join(layout.releasesDir, "candidate");
  await mkdir(releaseDir, { recursive: true });
  const supervisor = new Supervisor({
    layout,
    version: "test",
    coreReadyTimeoutMs: 1500,
    launcher: {
      launch: (generation, _release, fence) =>
        fork(source, [String(generation), String(fence)], {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        }),
    },
  });
  const releases = (supervisor as unknown as { releaseManager: ReleaseManager }).releaseManager;
  let entered!: () => void;
  let resume!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const complete = releases.completeUpdate.bind(releases);
  let applying: Promise<unknown> | undefined;
  releases.completeUpdate = async () => {
    entered();
    await barrier;
    await complete();
  };
  try {
    await supervisor.start();
    await until(() => supervisor.status().state === "ready");
    await releases.writePending({ version: "candidate", releaseDir });
    applying = requestControl(layout.controlEndpoint, { command: "apply-update" });
    void applying.catch(() => undefined);
    await bounded(reached);
    const child = (supervisor as unknown as { core: import("node:child_process").ChildProcess })
      .core;
    assert.equal(supervisor.status().generation, 2);
    assert.equal(supervisor.status().state, "starting", "held-ready is not public ready");
    async function admit(): Promise<boolean> {
      return new Promise((resolve) => {
        const onMessage = (raw: unknown): void => {
          if (raw && typeof raw === "object" && "type" in raw && raw.type === "fixture-admitted") {
            child.off("message", onMessage);
            resolve((raw as unknown as { accepted: boolean }).accepted);
          }
        };
        child.on("message", onMessage);
        child.send({ command: "fixture-admit" });
      });
    }
    assert.equal(await bounded(admit()), false);
    resume();
    assert.deepEqual(await applying, { applied: true, version: "candidate" });
    assert.equal(await bounded(admit()), true);
  } finally {
    resume();
    await applying?.catch(() => undefined);
    await supervisor.stop("fixture-cleanup");
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed candidate and ready timeout restore previous pointer before fenced rollback admits", async () => {
  for (const failure of ["exit", "timeout"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "supervisor-rollback-"));
    const layout = resolveServerLayout(join(dir, "server"));
    const source = join(dir, "core.cjs");
    await writeFile(
      source,
      `
const {randomUUID} = require('node:crypto');
const generation = Number(process.argv[2]);
if (generation === 2 && process.argv[4] === 'exit') process.exit(1);
let lease = process.argv[3] === 'held' ? randomUUID() : undefined;
const idle = {running:0,waiting:0,uncertain:0};
if (!(generation === 2 && process.argv[4] === 'timeout'))
 process.send({type:'ready',host:'127.0.0.1',port:40042,version:'fixture',generation,...(lease && {bootLeaseId:lease})});
process.on('message',m => {
 if (m.command === 'shutdown') process.exit(0);
 if (m.command === 'maintenance-begin') {lease=randomUUID();process.send({type:'maintenance',requestId:m.requestId,leaseId:lease,nativeActivity:idle,externalActivity:idle});}
 if (m.command === 'maintenance-release') {const ok=lease===m.leaseId;if(ok)lease=undefined;process.send({type:'maintenance',requestId:m.requestId,...(ok&&{leaseId:m.leaseId})});}
 if (m.command === 'fixture-admit') process.send({type:'fixture-admitted',accepted:!lease});
});
`,
    );
    const oldDir = join(layout.releasesDir, "previous");
    const nextDir = join(layout.releasesDir, "candidate");
    await mkdir(oldDir, { recursive: true });
    await mkdir(nextDir, { recursive: true });
    const supervisor = new Supervisor({
      layout,
      version: "test",
      coreReadyTimeoutMs: 250,
      launcher: {
        launch: (generation, _release, fence) =>
          fork(source, [String(generation), fence, failure], {
            stdio: ["ignore", "ignore", "ignore", "ipc"],
          }),
      },
    });
    const releases = (supervisor as unknown as { releaseManager: ReleaseManager }).releaseManager;
    try {
      await releases.ensure();
      await releases.restoreCurrent({ version: "previous", releaseDir: oldDir });
      await releases.writePending({ version: "candidate", releaseDir: nextDir });
      await supervisor.start();
      await until(() => supervisor.status().state === "ready");
      await assert.rejects(
        requestControl(layout.controlEndpoint, { command: "apply-update" }),
        /failed|Timed out/,
      );
      await until(
        () => supervisor.status().generation === 3 && supervisor.status().state === "ready",
      );
      assert.equal((await releases.readCurrent())?.version, "previous");
      assert.equal(
        await readFile(layout.updateTransactionFile, "utf8").then(
          () => true,
          () => false,
        ),
        false,
      );
      const child = (supervisor as unknown as { core: import("node:child_process").ChildProcess })
        .core;
      assert.ok(child.pid);
      assert.equal(child.exitCode, null);
    } finally {
      await supervisor.stop("fixture-cleanup");
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("Core exit while freeze request is pending never authorizes fallback on replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supervisor-acquire-"));
  const layout = resolveServerLayout(join(dir, "server"));
  const source = join(dir, "core.cjs");
  await writeFile(
    source,
    `
const {randomUUID}=require('node:crypto');
const generation=Number(process.argv[2]);
const idle={running:0,waiting:0,uncertain:0};
let lease;
process.send({type:'ready',host:'127.0.0.1',port:40042,version:'fixture',generation});
process.on('message',m=>{
 if(m.command==='shutdown')process.exit(0);
 if(m.command==='maintenance-begin') {
  if(generation===1){process.send({type:'fixture-freeze-pending'});return;}
  lease=randomUUID();process.send({type:'maintenance',requestId:m.requestId,leaseId:lease,nativeActivity:idle,externalActivity:idle});
 }
 if(m.command==='maintenance-release')process.send({type:'maintenance',requestId:m.requestId,leaseId:m.leaseId===lease?lease:undefined});
});
`,
  );
  let oldChild: import("node:child_process").ChildProcess | undefined;
  const supervisor = new Supervisor({
    layout,
    version: "test",
    launcher: {
      launch: (generation) => {
        const child = fork(source, [String(generation)], {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        if (generation === 1) oldChild = child;
        return child;
      },
    },
  });
  try {
    await supervisor.start();
    await until(() => supervisor.status().state === "ready");
    const freezeStarted = new Promise<void>((resolve) =>
      oldChild!.once("message", (raw: unknown) => {
        if (
          raw &&
          typeof raw === "object" &&
          "type" in raw &&
          raw.type === "fixture-freeze-pending"
        )
          resolve();
      }),
    );
    const acquiring = requestControl(layout.controlEndpoint, {
      command: "begin-fallback-migration",
    });
    await bounded(freezeStarted);
    process.kill(oldChild!.pid!, "SIGKILL");
    await assert.rejects(acquiring, /Cannot confirm maintenance admission fence/);
    await until(
      () => supervisor.status().generation === 2 && supervisor.status().state === "ready",
    );
    await assert.rejects(
      requestControl(layout.controlEndpoint, { command: "end-fallback-migration" }),
      /No fallback migration lease/,
    );
    assert.deepEqual(
      await requestControl(layout.controlEndpoint, { command: "begin-fallback-migration" }),
      { ready: true },
    );
    await requestControl(layout.controlEndpoint, { command: "end-fallback-migration" });
  } finally {
    await supervisor.stop("fixture-cleanup");
    await rm(dir, { recursive: true, force: true });
  }
});

test("lost post-commit release acknowledgement retains pointer and child instead of rollback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supervisor-commit-"));
  const layout = resolveServerLayout(join(dir, "server"));
  const source = join(dir, "core.cjs");
  await writeFile(
    source,
    `
const {randomUUID}=require('node:crypto');
const generation=Number(process.argv[2]);
let lease=process.argv[3]==='held'?randomUUID():undefined;
const idle={running:0,waiting:0,uncertain:0};
process.send({type:'ready',host:'127.0.0.1',port:40042,version:'fixture',generation,...(lease&&{bootLeaseId:lease})});
process.on('message',m=>{
 if(m.command==='shutdown')process.exit(0);
 if(m.command==='maintenance-begin'){lease=randomUUID();process.send({type:'maintenance',requestId:m.requestId,leaseId:lease,nativeActivity:idle,externalActivity:idle});}
 if(m.command==='maintenance-release'){
  if(m.leaseId===lease)lease=undefined;
  if(generation!==2)process.send({type:'maintenance',requestId:m.requestId,leaseId:m.leaseId});
 }
});
`,
  );
  const releaseDir = join(layout.releasesDir, "candidate");
  await mkdir(releaseDir, { recursive: true });
  const supervisor = new Supervisor({
    layout,
    version: "test",
    launcher: {
      launch: (generation, _release, fence) =>
        fork(source, [String(generation), fence], { stdio: ["ignore", "ignore", "ignore", "ipc"] }),
    },
  });
  const releases = (supervisor as unknown as { releaseManager: ReleaseManager }).releaseManager;
  try {
    await supervisor.start();
    await until(() => supervisor.status().state === "ready");
    await releases.writePending({ version: "candidate", releaseDir });
    await assert.rejects(
      requestControl(layout.controlEndpoint, { command: "apply-update" }),
      /Cannot verify maintenance admission release/,
    );
    assert.equal(supervisor.status().state, "stop-failed");
    assert.equal(supervisor.status().generation, 2);
    assert.ok(supervisor.status().pid);
    assert.equal((await releases.readCurrent())?.version, "candidate");
    assert.equal(
      await readFile(layout.updateTransactionFile, "utf8").then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    await supervisor.stop("fixture-cleanup");
    await rm(dir, { recursive: true, force: true });
  }
});

test("running, waiting and unknown census each refuses nonforce update, fallback and uninstall", async () => {
  for (const kind of ["running", "waiting", "uncertain"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "supervisor-unsafe-"));
    const layout = resolveServerLayout(join(dir, "server"));
    const source = join(dir, "core.cjs");
    await writeFile(
      source,
      `
const {randomUUID}=require('node:crypto');
const kind=process.argv[3];let lease;
const native={running:0,waiting:0,uncertain:0};native[kind]=1;
const idle={running:0,waiting:0,uncertain:0};
process.send({type:'ready',host:'127.0.0.1',port:40042,version:'fixture',generation:Number(process.argv[2])});
process.on('message',m=>{
 if(m.command==='shutdown')process.exit(0);
 if(m.command==='maintenance-begin'){lease=randomUUID();process.send({type:'maintenance',requestId:m.requestId,leaseId:lease,nativeActivity:native,externalActivity:idle});}
 if(m.command==='maintenance-release')process.send({type:'maintenance',requestId:m.requestId,leaseId:m.leaseId===lease?lease:undefined});
});
`,
    );
    const releaseDir = join(layout.releasesDir, "candidate");
    await mkdir(releaseDir, { recursive: true });
    const supervisor = new Supervisor({
      layout,
      version: "test",
      launcher: {
        launch: (generation) =>
          fork(source, [String(generation), kind], {
            stdio: ["ignore", "ignore", "ignore", "ipc"],
          }),
      },
    });
    const releases = (supervisor as unknown as { releaseManager: ReleaseManager }).releaseManager;
    try {
      await supervisor.start();
      await until(() => supervisor.status().state === "ready");
      const pid = supervisor.status().pid;
      await releases.writePending({ version: "candidate", releaseDir });
      await assert.rejects(
        requestControl(layout.controlEndpoint, { command: "apply-update" }),
        /Active or uncertain tasks/,
      );
      await assert.rejects(
        requestControl(layout.controlEndpoint, { command: "begin-fallback-migration" }),
        /active, waiting or uncertain/,
      );
      await assert.rejects(
        requestControl(layout.controlEndpoint, {
          command: "confirm-uninstall",
          confirmation: "DELETE",
        }),
        /active, waiting or uncertain/,
      );
      assert.equal(supervisor.status().pid, pid);
      assert.equal(supervisor.status().state, "ready");
      assert.equal((await releases.readPending())?.version, "candidate");
      assert.equal(await releases.readCurrent(), null);
    } finally {
      await supervisor.stop("fixture-cleanup");
      await rm(dir, { recursive: true, force: true });
    }
  }
});
