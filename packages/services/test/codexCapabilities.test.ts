import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { probeCodexTarget } from "../src/agent-adapters/codex/codexCapabilities.js";

test(
  "Codex probe rejects a CLI build outside the pinned app-server version",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-codex-version-probe-"));
    const executable = join(root, "codex");
    await writeFile(
      executable,
      "#!/usr/bin/env node\nprocess.stdout.write('codex-cli 0.157.2\\n');\n",
      {
        mode: 0o700,
      },
    );
    t.after(() => rm(root, { recursive: true, force: true }));

    const report = await probeCodexTarget(
      {
        id: "version-probe-target",
        kind: "local",
        platform: process.platform as "darwin" | "linux" | "win32",
        available: true,
      },
      executable,
    );

    assert.deepEqual(report, {
      support: "unsupported",
      reason: "Codex CLI version does not match the pinned app-server contract",
    });
  },
);
