import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AcpDescriptor } from "./acpTransport.js";

export type ObjectValue = Record<string, unknown>;
export function record(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function rpcId(value: unknown): value is string | number {
  return (
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}
const execFileAsync = promisify(execFile);
export async function probeAcpDescriptor(descriptor: AcpDescriptor): Promise<string> {
  const { stdout } = await execFileAsync(descriptor.executable, [...descriptor.version.argv], {
    cwd: descriptor.cwd,
    env: descriptor.env,
    timeout: 5000,
    maxBuffer: 4096,
  });
  return stdout.trim();
}
