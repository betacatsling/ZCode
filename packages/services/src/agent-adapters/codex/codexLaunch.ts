import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const VERSION = "codex-cli 0.156.1";

export interface CodexLaunchOptions {
  cwd: string;
  sessionHome: string;
  gatewayUrl: string;
  gatewayToken: string;
  executable?: string;
  spawnProcess?: typeof spawn;
}

function safeGatewayUrl(raw: string): string {
  const url = new URL(raw);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/v1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.port
  )
    throw new Error("Codex Gateway must be a loopback /v1 endpoint");
  return url.toString().replace(/\/$/, "");
}

async function probeVersion(
  command: string,
  start: typeof spawn,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const child = start(command, ["--version"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  let output = "";
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error("Codex version probe timed out"));
    }, 5000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 256) {
        child.kill();
        fail(new Error("Codex version output too large"));
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 && output.trim() === VERSION) done();
      else fail(new Error("Unsupported Codex CLI version"));
    });
  });
}

export async function launchCodex(
  options: CodexLaunchOptions,
): Promise<ChildProcessWithoutNullStreams> {
  if (
    !isAbsolute(options.cwd) ||
    !isAbsolute(options.sessionHome) ||
    resolve(options.cwd) === resolve(options.sessionHome) ||
    resolve(options.sessionHome) === resolve(process.env.HOME ?? "")
  )
    throw new Error("Codex requires a separate absolute private session home and cwd");
  if (!options.gatewayToken) throw new Error("Codex Gateway token is required");
  const url = safeGatewayUrl(options.gatewayUrl);
  await mkdir(options.sessionHome, { recursive: true, mode: 0o700 });
  await mkdir(join(options.sessionHome, "codex-home"), { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: options.sessionHome,
    CODEX_HOME: join(options.sessionHome, "codex-home"),
    ZCODE_CODEX_GATEWAY_TOKEN: options.gatewayToken,
  };
  const start = options.spawnProcess ?? spawn;
  const executable = options.executable ?? "codex";
  await probeVersion(executable, start, options.cwd, env);
  const args = [
    "app-server",
    "--stdio",
    "--strict-config",
    "-c",
    'model_providers.zcode.name="ZCode Gateway"',
    "-c",
    `model_providers.zcode.base_url=${JSON.stringify(url)}`,
    "-c",
    'model_providers.zcode.env_key="ZCODE_CODEX_GATEWAY_TOKEN"',
    "-c",
    'model_providers.zcode.wire_api="responses"',
    "-c",
    'model_provider="zcode"',
  ];
  return start(executable, args, {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
}
