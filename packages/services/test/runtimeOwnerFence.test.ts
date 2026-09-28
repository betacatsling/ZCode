import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CommandJournal } from "../src/agent-host/commandJournal.js";
import {
  assertResidentLifetime,
  countRunningTasks,
  ownerFencePath,
  planAttachmentClose,
  reserveOwnerLease,
} from "../src/agent-host/runtimeSupervisor.js";

function forkChild(
  root: string,
  targetId: string,
  hostSessionId: string,
  generation: string,
): Promise<{ status: string; message?: string }> {
  const childPath = fileURLToPath(new URL("./fixtures/ownerFenceChild.ts", import.meta.url));
  const child = fork(childPath, [root, targetId, hostSessionId, generation], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`owner fence child exited ${code}`));
    });
  });
}

test("a second OS process cannot steal a live owner fence, even with a newer generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-owner-fence-live-"));
  const lease = await reserveOwnerLease({
    root,
    targetId: "host-a",
    hostSessionId: "session-1",
    generation: 1,
    ownerToken: "parent",
  });
  try {
    const blocked = await forkChild(root, "host-a", "session-1", "2");
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.message ?? "", /runtime-host-live-owner/);
    await lease.assertCurrent();
  } finally {
    await lease.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("a dead owner is adopted with the next fence and does not replay an accepted prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-owner-fence-adopt-"));
  const holderPath = fileURLToPath(new URL("./fixtures/ownerFenceChild.ts", import.meta.url));
  const holder = fork(holderPath, [root, "host-a", "session-1", "1"], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    const acquired = await new Promise<{ status: string }>((resolve, reject) => {
      holder.once("message", resolve);
      holder.once("error", reject);
    });
    assert.equal(acquired.status, "acquired");
    const crashed = new Promise<void>((resolve, reject) => {
      holder.once("exit", (code, signal) => {
        if (signal === "SIGKILL" || code === 0) resolve();
        else reject(new Error(`holder exited ${code ?? "null"} ${signal ?? ""}`));
      });
    });
    holder.kill("SIGKILL");
    await crashed;

    const identity = {
      targetId: "host-a",
      workspaceIdentity: "workspace-a",
      harnessId: "mock",
      hostSessionId: "session-1",
      runtimeEpoch: "epoch-1",
    };
    const journal = await CommandJournal.open(root, identity);
    await journal.accept({
      type: "send",
      commandId: "send-1",
      hostSessionId: "session-1",
      turnId: "turn-1",
      text: "do not replay",
    });
    await journal.close();

    let replays = 0;
    const adopted = await reserveOwnerLease({
      root,
      targetId: "host-a",
      hostSessionId: "session-1",
      generation: 2,
      ownerToken: "next-core",
    });
    assert.equal(adopted.fence, 2);
    assert.equal(adopted.generation, 2);
    const reopened = await CommandJournal.open(root, identity);
    const receipt = reopened.query("send-1");
    if (receipt?.status === "accepted") replays += 1;
    assert.equal(receipt?.status, "execution-unknown");
    assert.equal(replays, 0);
    await reopened.close();
    await adopted.release();
  } finally {
    if (holder.exitCode === null) holder.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("same worktree path on two targets does not share an owner fence", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-owner-fence-targets-"));
  const first = await reserveOwnerLease({
    root,
    targetId: "machine-a",
    hostSessionId: "session-1",
    generation: 1,
    ownerToken: "a",
  });
  const second = await reserveOwnerLease({
    root,
    targetId: "machine-b",
    hostSessionId: "session-1",
    generation: 1,
    ownerToken: "b",
  });
  try {
    const pathA = ownerFencePath(root, "machine-a", "session-1");
    const pathB = ownerFencePath(root, "machine-b", "session-1");
    assert.notEqual(pathA, pathB);
    const recordA = JSON.parse(await readFile(pathA, "utf8")) as { targetId: string };
    const recordB = JSON.parse(await readFile(pathB, "utf8")) as { targetId: string };
    assert.equal(recordA.targetId, "machine-a");
    assert.equal(recordB.targetId, "machine-b");
  } finally {
    await first.release();
    await second.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale fence cannot release the current owner's file", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-owner-fence-stale-"));
  const lease = await reserveOwnerLease({
    root,
    targetId: "host-a",
    hostSessionId: "session-1",
    generation: 1,
    ownerToken: "current",
  });
  const path = ownerFencePath(root, "host-a", "session-1");
  try {
    const current = JSON.parse(await readFile(path, "utf8")) as {
      fence: number;
      ownerToken: string;
    };
    await writeFile(
      path,
      JSON.stringify({ ...current, fence: current.fence + 1, ownerToken: "replacement" }),
    );
    await assert.rejects(lease.assertCurrent(), /runtime-host-stale-fence/);
    await assert.rejects(lease.release(), /runtime-host-stale-fence/);
    const surviving = JSON.parse(await readFile(path, "utf8")) as { ownerToken: string };
    assert.equal(surviving.ownerToken, "replacement");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external busy and unknown sessions count while client attachment does not", () => {
  const counted = countRunningTasks({
    nativeActiveSessions: 0,
    external: [{ state: "idle" }, { state: "busy" }, { state: "unknown" }],
    externalUncertain: true,
  });
  assert.equal(counted, 3);
  assert.equal(
    countRunningTasks({
      nativeActiveSessions: 0,
      external: [{ state: "idle" }],
      externalUncertain: false,
    }),
    0,
  );
});

test("window close, GUI quit, and SSH disconnect do not stop the resident Core", () => {
  assert.throws(() => assertResidentLifetime("connection-exec"), /connection-exec-not-persistent/);
  assertResidentLifetime("resident-service");
  for (const reason of ["window-close", "gui-quit", "ssh-disconnect"] as const) {
    const plan = planAttachmentClose(reason);
    assert.equal(plan.closeRpcScope, true);
    assert.equal(plan.stopSupervisor, false);
    assert.equal(plan.stopWorkers, false);
  }
  assert.equal(planAttachmentClose("ssh-disconnect").closeTunnel, true);
  assert.equal(planAttachmentClose("window-close").closeTunnel, false);
  assert.equal(planAttachmentClose("explicit-stop").stopSupervisor, true);
  assert.equal(planAttachmentClose("explicit-stop").stopWorkers, true);
});

test(
  "真实 SSH 断线后 Core 仍在运行",
  {
    skip: "未运行：当前环境没有可授权的真实 SSH 目标，direct-tcpip 只在假传输和上面的附着计划里验证",
  },
  () => {},
);
