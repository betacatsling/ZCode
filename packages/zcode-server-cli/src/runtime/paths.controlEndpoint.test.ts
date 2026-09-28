import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { resolveServerLayout } from "./paths.js";

test("short server roots keep the historical control endpoint", () => {
  const layout = resolveServerLayout(join("/tmp", "zcode-short", "server"));
  if (process.platform === "win32") {
    assert.match(layout.controlEndpoint, /^\\\\\.\\pipe\\zcode-server-[0-9a-f]+$/u);
    return;
  }
  assert.equal(layout.controlEndpoint, join(layout.runDir, "control.sock"));
});

test("only darwin shortens a control socket that would exceed sun_path", () => {
  const layout = resolveServerLayout(
    join("/var/folders", "aa", "b".repeat(80), "T", "nested", "server"),
  );
  const alongside = join(layout.runDir, "control.sock");
  assert.ok(Buffer.byteLength(alongside) > 103);

  if (process.platform === "win32") {
    assert.match(layout.controlEndpoint, /^\\\\\.\\pipe\\zcode-server-[0-9a-f]+$/u);
    return;
  }
  if (process.platform !== "darwin") {
    assert.equal(layout.controlEndpoint, alongside);
    return;
  }
  assert.notEqual(layout.controlEndpoint, alongside);
  assert.match(layout.controlEndpoint, /^\/tmp\/zcode-[0-9a-f]+\.sock$/u);
  assert.ok(Buffer.byteLength(layout.controlEndpoint) <= 103);
});
