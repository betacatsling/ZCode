import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { mkdtemp, access, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolveNativeSessionDbPath } from "./index.js";

test("native DB path resolves config precedence relative to actual launch cwd without DB IO", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "native-path-"));
  try {
    const userConfigPath = join(cwd, "config.json");
    await writeFile(userConfigPath, JSON.stringify({ storage: { sessionDbPath: "user/sessions.sqlite" } }));
    const user = resolveNativeSessionDbPath({ cwd, userConfigPath, env: {} });
    assert.equal(user, join(cwd, "user/sessions.sqlite"));
    const overridden = resolveNativeSessionDbPath({
      cwd, userConfigPath, env: { ZCODE_SESSION_DB_PATH: "env/custom.sqlite" },
    });
    assert.equal(overridden, join(cwd, "env/custom.sqlite"));
    const absolute = resolveNativeSessionDbPath({
      cwd, userConfigPath, env: { ZCODE_SESSION_DB_PATH: join(cwd, "absolute.sqlite") },
    });
    assert.equal(absolute, join(cwd, "absolute.sqlite"));
    await assert.rejects(access(join(cwd, "env")));
    await assert.rejects(access(join(cwd, "user")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
