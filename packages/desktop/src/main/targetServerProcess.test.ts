import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { invokeUserOwnedServer } from "./targetServerProcess.js";

test("packaged CLI invocation isolates stdin, drains output and opts out of global service registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "target-server-process-"));
  const script = join(root, "cli.cjs");
  try {
    await writeFile(
      script,
      `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), stdin: process.stdin.isTTY ?? false, registration: process.env.ZCODE_SERVER_SKIP_SERVICE_REGISTRATION }) + '\\n');`,
    );
    const result = await invokeUserOwnedServer(
      { node: process.execPath, cli: script, serverRoot: root },
      "serve",
    );
    assert.deepEqual(result, {
      args: ["serve", "--daemon", "--server-root", root, "--json"],
      stdin: false,
      registration: "1",
    });
    assert((await readFile(script, "utf8")).includes("process.stdout"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
