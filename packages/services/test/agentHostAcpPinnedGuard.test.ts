import assert from "node:assert/strict";
import test from "node:test";
import type { BindingPlan, SessionSpecV2 } from "@zcode/shared/agent-host";
import {
  AcpHarnessAdapter,
  type TrustedAcpProfile,
} from "../src/agent-adapters/acp/acpHarnessAdapter.js";

const target = { id: "t", kind: "local" as const, platform: "darwin" as const, available: true };
const descriptor = {
  executable: process.execPath,
  argv: ["/trusted/package/dist/index.js"],
  cwd: "/work",
  env: { HOME: "/isolated/home" },
  version: { argv: [], exact: "0.16.2" },
};
const profile: TrustedAcpProfile = {
  id: "claude-acp",
  version: "0.16.2",
  certified: true, // Deliberately misconfigured; cannot grant permission certainty.
  targetFor: () => target,
  verifyCwd: async () => "/work",
  descriptor: () => descriptor,
  probeDescriptor: () => descriptor,
  transport: {
    probeVersion: async () => "0.16.2",
    launch: () => {
      throw new Error("must not launch");
    },
  },
};
const spec: SessionSpecV2 = {
  schemaVersion: 2,
  hostSessionId: "s",
  projectId: "p",
  workspaceId: "w",
  execution: {
    targetId: "t",
    workspaceIdentity: "id",
    worktreePath: "/work",
    worktreeGeneration: "g",
    cwdRelativeToWorktree: ".",
  },
  harness: { id: "claude-acp", adapterVersion: "0.16.2" },
  modelBinding: { kind: "harness-managed" },
};
const plan: BindingPlan = {
  schemaVersion: 1,
  hostSessionId: "s",
  targetId: "t",
  harnessId: "claude-acp",
  adapterVersion: "0.16.2",
  catalogFingerprint: "p",
  requested: { kind: "harness-managed" },
  route: "harness-managed",
  support: { support: "supported" },
  capabilities: {},
};

test("pinned Claude ACP cannot be promoted by a mistaken certified flag or forged supported plan", async () => {
  const adapter = new AcpHarnessAdapter(profile);
  assert.equal((await adapter.probe(target)).support, "experimental");
  assert.equal((await adapter.capabilities(target)).approvals.support, "experimental");
  await assert.rejects(adapter.create(spec, plan), /uncertified.*settings/i);
});
