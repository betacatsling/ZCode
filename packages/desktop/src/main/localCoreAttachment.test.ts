import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, writeFile, rm, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ZCODE_VERSION } from "@zcode/shared";
import {
  prepareLocalCoreAttachment,
  packagedLocalCoreServer,
  prepareWindowLocalCore,
} from "./localCoreAttachment.js";

test("stale window generation never starts Core and never publishes a late endpoint", async () => {
  let current = false;
  let calls = 0;
  const endpoint = {
    endpoint: "http://127.0.0.1:1",
    installationId: randomUUID(),
    version: ZCODE_VERSION,
    generation: 1,
  };
  assert.equal(
    await prepareWindowLocalCore(
      async () => {
        calls++;
        return endpoint;
      },
      () => current,
    ),
    undefined,
  );
  assert.equal(calls, 0);
  current = true;
  let finish!: (value: typeof endpoint) => void;
  const pending = prepareWindowLocalCore(
    () => {
      calls++;
      return new Promise<typeof endpoint>((resolve) => {
        finish = resolve;
      });
    },
    () => current,
  );
  current = false;
  finish(endpoint);
  assert.equal(await pending, undefined);
  assert.equal(calls, 1);
});

test("owned root identity and CLI generation pin the actual Core endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-core-owned-"));
  try {
    const installationId = randomUUID();
    const script = join(root, "cli.cjs");
    const canonical = await realpath(root);
    await writeFile(
      join(root, "install.json"),
      JSON.stringify({
        product: "zcode-server",
        schemaVersion: 1,
        canonicalServerRoot: canonical,
        installationId,
        installedAt: Date.now(),
      }),
    );
    await writeFile(
      script,
      `process.stdout.write(JSON.stringify({ state: 'ready', host: '127.0.0.1', port: 42341,
      version: ${JSON.stringify(ZCODE_VERSION)}, generation: 8 }) + '\\n')`,
    );
    const server = { node: process.execPath, cli: script, serverRoot: root };
    assert.deepEqual(await prepareLocalCoreAttachment(server), {
      endpoint: "http://127.0.0.1:42341",
      installationId,
      version: ZCODE_VERSION,
      generation: 8,
    });
    await writeFile(
      join(root, "install.json"),
      JSON.stringify({
        product: "zcode-server",
        schemaVersion: 1,
        canonicalServerRoot: canonical,
        installationId: randomUUID(),
        installedAt: Date.now(),
      }),
    );
    const changed = await prepareLocalCoreAttachment(server);
    assert.notEqual(changed.installationId, installationId);
    await writeFile(
      script,
      `process.stdout.write(JSON.stringify({ state: 'ready', host: '127.0.0.1', port: 42341,
      version: ${JSON.stringify(ZCODE_VERSION)}, generation: process.argv[2] === 'serve' ? 8 : 9 }) + '\\n')`,
    );
    await assert.rejects(prepareLocalCoreAttachment(server), /generation changed/);
    await writeFile(
      script,
      `process.stdout.write(JSON.stringify({ state: 'ready', host: '0.0.0.0', port: 42341,
      version: ${JSON.stringify(ZCODE_VERSION)}, generation: 8 }) + '\\n')`,
    );
    await assert.rejects(prepareLocalCoreAttachment(server), /status\/loopback/);
    await writeFile(
      script,
      `process.stdout.write(JSON.stringify({ state: 'ready', host: '127.0.0.1', port: 42341,
      version: ${JSON.stringify(ZCODE_VERSION)}, generation: 8 }) + '\\n')`,
    );
    await rename(join(root, "install.json"), join(root, "moved-install.json"));
    await symlink(join(root, "moved-install.json"), join(root, "install.json"));
    await assert.rejects(prepareLocalCoreAttachment(server), /marker/);
    assert.equal(
      packagedLocalCoreServer("/tmp/resources", root).cli,
      "/tmp/resources/zcode-server/runtime/server-cli.js",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
