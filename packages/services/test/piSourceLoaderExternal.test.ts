import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(
  new URL("./fixtures/piSourceLoaderExternal.fixture.ts", import.meta.url),
);

test(
  "Pi source worker starts and completes a fake turn from an external dependency-free cwd",
  { timeout: 35000 },
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "zcode-pi-source-external-"));
    try {
      // Only the parent gets an explicit absolute source loader. The worker must resolve its own.
      const loader = import.meta.resolve("tsx");
      const child = spawn(process.execPath, ["--import", loader, fixture], {
        cwd,
        env: { ...process.env, NODE_OPTIONS: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
      });
      const timer = setTimeout(() => child.kill(), 25000);
      try {
        const exit = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", resolve);
        });
        assert.equal(exit, 0, output);
        assert.match(output, /EXTERNAL_PI_SOURCE_READY_ACCEPTED_COMPLETED/);
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
