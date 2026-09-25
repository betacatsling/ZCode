import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isolatedReleaseEnv } from "./supervisorRealProcessEnv.fixture.js";

test("installed-process allowlist rejects benign synthetic inherited preload and poisoned PATH", async () => {
  const dir = await mkdtemp(join(tmpdir(), "release-env-"));
  const poison = join(dir, "poison");
  const marker = join(dir, "preload-used");
  try {
    await mkdir(poison);
    await mkdir(join(dir, "tmp"));
    const preload = join(poison, "preload.cjs");
    await writeFile(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1")`);
    const env = isolatedReleaseEnv(
      {
        NODE_OPTIONS: `--require=${preload}`,
        PATH: poison,
        ZCODE_MEMORY_HEAVY_SLOT_OWNER: process.env.ZCODE_MEMORY_HEAVY_SLOT_OWNER,
      },
      dir,
      join(dir, "empty-provider.json"),
    );
    assert.equal(env.NODE_OPTIONS, "--max-old-space-size=2048");
    assert.ok(!env.PATH?.includes(poison));
    assert.equal(env.ZCODE_MEMORY_HEAVY_SLOT_OWNER, process.env.ZCODE_MEMORY_HEAVY_SLOT_OWNER);
    assert.equal(env.GOMAXPROCS, "1");
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      cwd: dir,
      env,
      stdio: "ignore",
    });
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(exit, 0);
    assert.equal(
      await access(marker).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
