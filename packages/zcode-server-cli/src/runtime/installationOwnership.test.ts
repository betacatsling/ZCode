import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveServerLayout } from "./paths.js";
import {
  ensureServerInstallOwnership,
  validateServerInstallOwnership,
} from "./installationOwnership.js";

test("Desktop target binding preserves the standalone installation identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-target-identity-"));
  try {
    const layout = resolveServerLayout(join(root, "server"));
    const initial = await ensureServerInstallOwnership(layout);
    const bound = await ensureServerInstallOwnership(layout, "local:device-1");
    const persisted = await validateServerInstallOwnership(layout);

    assert.equal(bound.installationId, initial.installationId);
    assert.equal(bound.installedAt, initial.installedAt);
    assert.equal(persisted.targetId, "local:device-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("target identity is stable and conflicting bindings fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-target-identity-"));
  try {
    const layout = resolveServerLayout(join(root, "server"));
    const first = await ensureServerInstallOwnership(layout, "local:device-2");
    const repeated = await ensureServerInstallOwnership(layout, "local:device-2");

    assert.equal(repeated.installationId, first.installationId);
    assert.equal(repeated.targetId, first.targetId);
    await assert.rejects(
      ensureServerInstallOwnership(layout, "local:other-device"),
      /target identity conflicts/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
