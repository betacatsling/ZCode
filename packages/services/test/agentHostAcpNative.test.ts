import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createAcpTransport } from "../src/agent-adapters/acp/acpTransport.js";

/** Public pinned package, isolated HOME, no auth/key/provider request. Not session/tool certification. */
test(
  "pinned real ACP binary initializes without an account or provider call",
  {
    skip: !process.env.ACP_REAL_BIN ? "set ACP_REAL_BIN to an isolated pinned installation" : false,
    timeout: 10000,
  },
  async () => {
    const bin = resolve(process.env.ACP_REAL_BIN!);
    const packageJson = JSON.parse(
      await readFile(resolve(dirname(bin), "../package.json"), "utf8"),
    ) as {
      name: string;
      version: string;
    };
    assert.equal(packageJson.name, "@zed-industries/claude-code-acp");
    assert.equal(packageJson.version, "0.16.2");
    const home = await mkdtemp(join(tmpdir(), "zcode-acp-no-account-"));
    const client = await createAcpTransport(
      {
        executable: process.execPath,
        argv: [bin],
        cwd: home,
        env: {
          HOME: home,
          PATH: process.env.PATH,
          LANG: "C.UTF-8",
          ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
        },
        version: { argv: [], exact: "0.16.2" },
      },
      {
        probeVersion: async () => packageJson.version,
        launch: (descriptor) =>
          spawn(descriptor.executable, [...descriptor.argv], {
            cwd: descriptor.cwd,
            env: descriptor.env,
            stdio: ["pipe", "pipe", "pipe"],
          }),
      },
    );
    assert.equal(client.capabilities.loadSession, true);
    await client.close();
  },
);
