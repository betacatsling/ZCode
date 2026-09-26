import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPrivateEffectPorts } from "./native-private-effects.js";

test("existing filesystem/execution adapters deny out-of-scope Read, Write and Bash before I/O", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "native-io-"));
  const readPath = join(cwd, "input.txt");
  const writePath = join(cwd, "output.txt");
  await writeFile(readPath, "seed\n");
  const ports = createPrivateEffectPorts({
    cwd,
    readPath,
    writePath,
    writeContent: "approved",
    bashCommand: "node verify.cjs",
    processEnv: process.env,
  });
  try {
    await assert.rejects(
      ports.fileSystemPort.readTextFileRange({ path: readPath }),
      /scope denied/,
    );
    ports.setPhase(1);
    await assert.rejects(
      ports.fileSystemPort.readTextFileRange({ path: join(cwd, "wrong.txt") }),
      /scope denied/,
    );
    await assert.rejects(ports.fileSystemPort.readBinaryFile({ path: readPath }), /scope denied/);
    await assert.rejects(
      ports.fileSystemPort.writeTextFile({ path: writePath, content: "wrong" }),
      /scope denied/,
    );
    await assert.rejects(ports.fileSystemPort.removeFile({ path: readPath }), /scope denied/);
    assert.equal(await readFile(readPath, "utf8"), "seed\n");
    await assert.rejects(
      ports.executionPort.run({
        cwd,
        command: { mode: "shell", command: "node other.cjs", shellProfile: "posix-bash" },
      }),
      /scope denied/,
    );
    await assert.rejects(
      ports.executionPort.run({
        cwd: tmpdir(),
        command: { mode: "shell", command: "node verify.cjs", shellProfile: "posix-bash" },
      }),
      /scope denied/,
    );
    await assert.rejects(
      ports.executionPort.run({
        cwd,
        command: { mode: "shell", command: "node verify.cjs", shellProfile: "posix-bash" },
        env: { set: { SECRET: "not-allowed" } },
      }),
      /scope denied/,
    );
    assert.equal(
      (await ports.fileSystemPort.readTextFileRange({ path: readPath })).content.trim(),
      "seed",
    );
    ports.setPhase(2);
    await assert.rejects(
      ports.fileSystemPort.readTextFileRange({ path: readPath }),
      /scope denied/,
    );
    await ports.fileSystemPort.writeTextFile({ path: writePath, content: "approved" });
    assert.equal(await readFile(writePath, "utf8"), "approved");
    ports.setPhase(3);
    assert.equal(
      (await ports.fileSystemPort.readTextFileRange({ path: readPath })).content.trim(),
      "seed",
    );
  } finally {
    await ports.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
