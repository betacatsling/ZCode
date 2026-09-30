import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

const bundle = resolve(process.argv[2] ?? "dist/piWorker.js");
const root = await mkdtemp(join(tmpdir(), "zcode-packaged-pi-"));
const worktree = join(root, "worktree");
const sessionDir = join(root, "sessions");
const isolatedAgentDir = join(root, "config");
await Promise.all([worktree, sessionDir, isolatedAgentDir].map((path) => mkdir(path)));
const hostSessionId = `packaged-${randomUUID()}`;
const targetId = `local-${randomUUID()}`;
const selection = {
  providerId: "fixture-provider",
  modelId: "fixture-model",
  options: { reasoningLevel: "off" },
};
const binding = {
  hostSessionId,
  backendSessionId: "pending",
  backendVersion: "0.87.1",
  runtimeEpoch: randomUUID(),
};
const worker = new Worker(bundle, {
  workerData: {
    spec: {
      schemaVersion: 1,
      hostSessionId,
      execution: { targetId, workspaceIdentity: "fixture", worktreePath: worktree },
      harness: { id: "pi", adapterVersion: "0.87.1" },
      modelBinding: { kind: "host-managed", selection },
    },
    plan: {
      schemaVersion: 1,
      hostSessionId,
      targetId,
      harnessId: "pi",
      adapterVersion: "0.87.1",
      catalogFingerprint: "fixture",
      requested: { kind: "host-managed", selection },
      effective: selection,
      route: "pi-sdk",
      support: { support: "supported" },
      capabilities: {},
    },
    binding,
    sessionDir,
    isolatedAgentDir,
    attach: false,
    sequence: 0,
    model: {
      ...selection,
      properties: { contextWindow: 32000 },
      optionSpecs: { maxOutputTokens: { max: 2048 } },
      options: { reasoningLevel: "off" },
    },
  },
  env: {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: isolatedAgentDir,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "C.UTF-8",
  },
});
try {
  await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(
      () => rejectPromise(new Error("packaged Pi worker initialization timed out")),
      20000,
    );
    worker.on("message", (message) => {
      if (message.type === "fatal") {
        clearTimeout(timeout);
        rejectPromise(new Error(message.message));
      }
      if (message.type === "ready") {
        clearTimeout(timeout);
        assert.ok(message.backendSessionId);
        resolvePromise();
      }
    });
    worker.once("error", rejectPromise);
    worker.once("exit", (code) => rejectPromise(new Error(`worker exited early: ${code}`)));
  });
  console.log("packaged Pi worker initialized with isolated config and no Provider credential");
} finally {
  await worker.terminate();
  await rm(root, { recursive: true, force: true });
}
