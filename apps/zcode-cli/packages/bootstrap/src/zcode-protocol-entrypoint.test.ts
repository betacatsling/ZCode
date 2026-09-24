import assert from "node:assert/strict";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runZCodeProtocolAgent } from "./zcode-protocol-entrypoint.js";

// The process cwd deliberately differs from launch cwd; no global chdir or user profile is touched.
test("prepare and normal startup select the same configured relative database at launch cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-native-bootstrap-"));
  const cwd = join(root, "launch");
  const path = join(cwd, "sessions.sqlite");
  const env = {
    ...process.env,
    HOME: root,
    ZCODE_DATA_BASE_DIR: root,
    ZCODE_SESSION_DB_PATH: "sessions.sqlite",
    ZCODE_TELEMETRY_ENABLED: "false",
  };
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    const prepare = runZCodeProtocolAgent({ cwd, env, input, output, prepareStorageOnly: true });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("prepare path not emitted")), 5000);
      output.on("data", () => {
        if (!text.includes('"method":"startup/storagePath"')) return;
        clearTimeout(timeout);
        resolve();
      });
    });
    const pathFrame = text.split("\n").map((line) => line && JSON.parse(line)).find((frame) => frame?.method === "startup/storagePath");
    assert.equal(pathFrame.params.path, path);
    input.write(JSON.stringify({ method: "startup/storagePathReady", reuse: false }) + "\n");
    await prepare;
    await access(path);

    let factoryCalled = 0;
    await assert.rejects(
      runZCodeProtocolAgent({ cwd, env, input: new PassThrough(), output: new PassThrough() }, {
        startProviderRegistryRuntime: async () => {
          factoryCalled++;
          throw new Error("after-storage-open");
        },
      }),
      /after-storage-open/,
    );
    assert.equal(factoryCalled, 1);
    await access(path);
    await assert.rejects(access(join(process.cwd(), "sessions.sqlite")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
