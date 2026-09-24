import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiHarnessAdapter } from "../src/agent-adapters/pi/piHarnessAdapter.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";

test("Pi rejects its unsupported native-account mode before a worker or journal is created", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-pi-native-reject-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const journalRoot = join(root, "journal");
  const registry = new HarnessRegistry();
  registry.register(new PiHarnessAdapter({ root: join(root, "workers"), modelFactory: () => { throw new Error("must not bind model"); } }));
  try {
    await assert.rejects(SessionHost.create({
      root: journalRoot,
      spec: { schemaVersion: 2, projectId: "fixture-project", workspaceId: "fixture-workspace", hostSessionId: "pi-no-native", execution: { targetId: "local", workspaceIdentity: "w", worktreePath: worktree, worktreeGeneration: "fixture-generation", cwdRelativeToWorktree: "." },
        harness: { id: "pi", adapterVersion: "0.87.1" }, modelBinding: { kind: "harness-managed" } },
      target: { id: "local", kind: "local", platform: process.platform as "darwin" | "linux", available: true },
      registry, catalog: { fingerprint: "v1", validateSelection: () => ({ ok: true }) },
    }), /native-account|harness-managed/i);
    await assert.rejects(readdir(journalRoot), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
