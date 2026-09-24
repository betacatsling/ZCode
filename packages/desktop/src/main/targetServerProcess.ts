import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export interface PackagedTargetServer {
  node: string;
  cli: string;
  serverRoot: string;
}

/** Invokes the packaged standalone CLI, never a window-scoped Host or a global service install. */
export async function invokeUserOwnedServer(
  target: PackagedTargetServer,
  action: "serve" | "status" | "stop",
): Promise<unknown> {
  if (![target.node, target.cli, target.serverRoot].every(isAbsolute)) {
    throw new Error("Packaged runtime and target data root must be absolute paths");
  }
  const args = [
    target.cli,
    action,
    ...(action === "serve" ? ["--daemon"] : []),
    "--server-root",
    target.serverRoot,
    "--json",
  ];
  const child = spawn(target.node, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ZCODE_SERVER_SKIP_SERVICE_REGISTRATION: "1" },
  });
  let output = "";
  let errors = "";
  const MAX_OUTPUT = 64 * 1024;
  child.stdout.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-MAX_OUTPUT);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors = (errors + chunk.toString()).slice(-MAX_OUTPUT);
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0)
    throw new Error(`Target server ${action} failed (${exitCode}): ${errors.trim()}`);
  // Serve's detached child owns the data-root lock and Core; this invocation only waits for its ready ack.
  return JSON.parse(output.trim());
}
