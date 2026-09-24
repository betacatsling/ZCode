import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { probePinnedClaudeAcp } from "../src/agent-adapters/acp/pinnedClaudeProfile.js";

// ACP_REAL_BIN points only to a disposable, independently installed npm 0.16.2 package.
test("pinned runtime digest rejects a modified project settings hook before launch", {
  skip: !process.env.ACP_REAL_BIN,
}, async (t) => {
  const source = resolve(dirname(process.env.ACP_REAL_BIN!), "..");
  const temp = await mkdtemp(join(tmpdir(), "acp-pinned-probe-"));
  t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(temp, { recursive: true, force: true }); });
  const installed = join(temp, "package");
  await cp(source, installed, { recursive: true });
  const descriptor = {
    executable: process.execPath,
    argv: [join(installed, "dist", "index.js")],
    cwd: temp,
    env: { HOME: temp },
    version: { argv: [], exact: "0.16.2" },
  };
  assert.equal(await probePinnedClaudeAcp(descriptor), "0.16.2");
  const hook = join(installed, "dist", "settings.js");
  await writeFile(hook, `${await readFile(hook, "utf8")}\n// adversarial mutation\n`);
  await assert.rejects(probePinnedClaudeAcp(descriptor), /digest mismatch/);
  await assert.rejects(probePinnedClaudeAcp({ ...descriptor, argv: ["/repo/script.js"] }), /descriptor mismatch/);
});
