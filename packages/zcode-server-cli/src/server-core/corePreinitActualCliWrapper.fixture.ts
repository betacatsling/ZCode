import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";

const held = process.env.ZCODE_CORE_BOOT_ADMISSION === "held";
const sessionId = process.env.CORE_PREINIT_EARLY_SESSION_ID;
if (held && !sessionId) throw new Error("missing prior public session for pre-constructor probe");
const ackPath = process.env.CORE_PREINIT_EARLY_ACK_FILE;
const pidDirectory = process.env.CORE_PREINIT_CLI_PID_DIR;
const probeId = "core-preinit-early-v4-probe";
const cliMain = fileURLToPath(
  new URL("../../../../apps/zcode-cli/packages/cli/src/main.ts", import.meta.url),
);
const barrier = fileURLToPath(new URL("./corePreinitActualCliBarrier.fixture.ts", import.meta.url));
// CLI 的 cwd 是隔离的 Git 工作区，不能在该目录解析仓库依赖；使用父夹具钉住的本地 loader。
const tsx = process.env.CORE_PREINIT_TSX_LOADER;
if (!tsx?.startsWith("file:")) throw new Error("missing pinned source CLI loader");
const args = ["--import", tsx];
if (held) args.push("--import", barrier);
args.push(cliMain, "app-server", "--stdio");
const child = spawn(process.execPath, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: held ? ["pipe", "pipe", "inherit", "pipe"] : ["pipe", "pipe", "inherit"],
});

let outputTail = "";
let earlyAckWritten = false;
child.stdout?.on("data", (chunk: Buffer) => {
  if (held && !earlyAckWritten && ackPath) {
    outputTail += chunk.toString();
    const lines = outputTail.split("\n");
    outputTail = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const frame = JSON.parse(line) as {
          id?: unknown;
          error?: { message?: unknown };
          result?: { status?: unknown; reasonCode?: unknown };
        };
        if (frame.id !== probeId) continue;
        earlyAckWritten = true;
        void mkdir(dirname(ackPath), { recursive: true })
          .then(() =>
            writeFile(
              ackPath,
              JSON.stringify({
                cliPid: child.pid,
                id: frame.id,
                errorMessage: typeof frame.error?.message === "string" ? frame.error.message : null,
                result: frame.result ?? null,
              }),
              { flag: "wx" },
            ),
          )
          .catch((error: unknown) => {
            process.stderr.write(`early CLI probe receipt failed: ${String(error)}\n`);
          });
        break;
      } catch {
        // This is the real CLI's NDJSON stream; unrelated log/protocol lines are forwarded as-is.
      }
    }
  }
  process.stdout.write(chunk);
});
child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
child.once("error", (error) => {
  process.stderr.write(`actual CLI spawn failed: ${String(error)}\n`);
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  process.stderr.write(`actual CLI process closed code=${code} signal=${signal}\n`);
  process.exitCode = code ?? (signal ? 1 : 0);
  process.stdin.unpipe(child.stdin!);
  process.stdin.pause();
  process.stdout.end();
});

if (held) {
  const earlyCommand = JSON.stringify({
    id: probeId,
    method: V4_METHODS.command,
    params: {
      commandId: probeId,
      clientId: "core-preinit-early-fixture",
      sessionId,
      type: "sendText",
      issuedAt: Date.now(),
      payload: { text: "early input must remain held across cold boot" },
    },
  });
  const input = child.stdin;
  const release = child.stdio[3] as Writable | null;
  if (!input || !release) throw new Error("pre-constructor CLI barrier pipes unavailable");
  await new Promise<void>((resolve, reject) => {
    input.write(`${earlyCommand}\n`, (error?: Error | null) => (error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    release.write("continue\n", (error?: Error | null) =>
      error ? reject(error) : release.end(resolve),
    );
  });
  if (pidDirectory) {
    await mkdir(pidDirectory, { recursive: true });
    await writeFile(
      join(pidDirectory, "held-cli.json"),
      JSON.stringify({ wrapperPid: process.pid, cliPid: child.pid }),
      { flag: "wx" },
    );
  }
} else if (pidDirectory) {
  await mkdir(pidDirectory, { recursive: true });
  await writeFile(
    join(pidDirectory, "open-cli.json"),
    JSON.stringify({ wrapperPid: process.pid, cliPid: child.pid }),
    { flag: "wx" },
  );
}

process.stdin.pipe(child.stdin!);
process.stdin.on("error", () => child.kill("SIGTERM"));
process.stdin.on("end", () => child.kill("SIGTERM"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
process.once("SIGINT", () => child.kill("SIGTERM"));
