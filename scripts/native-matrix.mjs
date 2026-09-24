// Run ONLY the deterministic fake native stdio/V4 matrix. Never reads saved provider credentials.
// Invoke from repository root under the shared heavy-slot wrapper; do not make this a paid test.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 2)
  throw new Error("native-matrix takes no routes, credentials, or arguments");
const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "apps/zcode-cli/packages/core/src/agent/model-role-compat.test.ts",
    "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.test.ts",
    "apps/zcode-cli/packages/bootstrap/src/native-bootstrap-subprocess.test.ts",
    "apps/zcode-cli/packages/bootstrap/src/native-private-evidence.test.ts",
    "apps/zcode-cli/packages/bootstrap/src/native-private-effects.test.ts",
    "apps/zcode-cli/packages/bootstrap/src/native-private-observer.test.ts",
    "apps/zcode-cli/packages/bootstrap/src/native-private-redirect.test.ts",
  ],
  {
    cwd: root,
    env: { ...process.env, ZCODE_TELEMETRY_ENABLED: "false" },
    stdio: "inherit",
  },
);
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
const code = await new Promise((resolve) =>
  child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0))),
);
process.exitCode = code;
