import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requestControl } from "../ipc/controlClient.js";
import {
  ensurePrivateControlSocketDir,
  relocatedControlSocketDir,
} from "../ipc/controlSocketDir.js";
import { createControlServer } from "../ipc/controlServer.js";
import {
  DARWIN_SOCKET_PATH_MAX,
  resolveControlSocketPath,
  resolveServerLayout,
  stablePathId,
} from "./paths.js";

// 模拟 macOS 默认临时目录下的测试数据根：/var/folders/<2>/<~30>/T/<mkdtemp>/server/run/control.sock。
const LONG_ROOT = join("/var/folders", "aa", "b".repeat(80), "T", "nested", "server");
const SHORT_ROOT = join("/tmp", "zcode-short", "server");

test("short server roots keep the historical control endpoint", () => {
  const layout = resolveServerLayout(SHORT_ROOT);
  if (process.platform === "win32") {
    assert.match(layout.controlEndpoint, /^\\\\\.\\pipe\\zcode-server-[0-9a-f]+$/u);
    return;
  }
  assert.equal(layout.controlEndpoint, join(layout.runDir, "control.sock"));
  assert.equal(relocatedControlSocketDir(layout.controlEndpoint), undefined);
});

test("non-darwin platforms keep an overlong control socket inside the run dir", () => {
  const runDir = join(LONG_ROOT, "run");
  const alongside = join(runDir, "control.sock");
  assert.ok(Buffer.byteLength(alongside) > DARWIN_SOCKET_PATH_MAX);
  assert.equal(resolveControlSocketPath(LONG_ROOT, runDir, "linux", 501), alongside);
  assert.equal(
    resolveControlSocketPath(SHORT_ROOT, join(SHORT_ROOT, "run"), "darwin", 501),
    join(SHORT_ROOT, "run", "control.sock"),
  );
});

test("darwin relocates only an overlong control socket into a per-uid short dir", () => {
  const runDir = join(LONG_ROOT, "run");
  const endpoint = resolveControlSocketPath(LONG_ROOT, runDir, "darwin", 501);
  assert.equal(endpoint, `/tmp/zcode-501/${stablePathId(LONG_ROOT)}.sock`);
  assert.ok(Buffer.byteLength(endpoint) <= DARWIN_SOCKET_PATH_MAX);
  assert.equal(relocatedControlSocketDir(endpoint), "/tmp/zcode-501");
  // 同一数据根稳定；不同数据根或不同用户不共用 endpoint。
  assert.equal(resolveControlSocketPath(LONG_ROOT, runDir, "darwin", 501), endpoint);
  const otherRoot = join(LONG_ROOT, "..", "other-server");
  assert.notEqual(
    resolveControlSocketPath(otherRoot, join(otherRoot, "run"), "darwin", 501),
    endpoint,
  );
  assert.notEqual(resolveControlSocketPath(LONG_ROOT, runDir, "darwin", 502), endpoint);
});

test(
  "relocated control socket dirs must be private to the current user",
  {
    skip: process.platform === "win32" ? "POSIX permissions only" : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-control-dir-"));
    try {
      const privateDir = join(root, "private");
      await ensurePrivateControlSocketDir(privateDir, { create: true });
      await ensurePrivateControlSocketDir(privateDir, { create: false });

      const missing = join(root, "missing");
      await assert.rejects(ensurePrivateControlSocketDir(missing, { create: false }), {
        code: "ENOENT",
      });

      const shared = join(root, "shared");
      await mkdir(shared);
      await chmod(shared, 0o777);
      await assert.rejects(ensurePrivateControlSocketDir(shared, { create: true }), /not private/u);

      const link = join(root, "link");
      await symlink(privateDir, link);
      await assert.rejects(ensurePrivateControlSocketDir(link, { create: true }), /not private/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "control server and client work through a relocated short socket",
  {
    skip: process.platform === "win32" ? "Unix domain sockets only" : false,
  },
  async () => {
    const uid = process.getuid?.() ?? 0;
    const endpoint = join(`/tmp/zcode-${uid}`, `test-${randomUUID().slice(0, 8)}.sock`);
    assert.equal(relocatedControlSocketDir(endpoint), `/tmp/zcode-${uid}`);
    const control = await createControlServer(endpoint, async (request) => ({
      echoed: request.command,
    }));
    try {
      assert.deepEqual(await requestControl(endpoint, { command: "status" }, 2_000), {
        echoed: "status",
      });
    } finally {
      await control.close();
    }
  },
);
