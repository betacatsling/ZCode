import { join } from "node:path";

export const PRIVATE_SHELL_SCRIPT =
  "if (process.env.ZCODE_NATIVE_SHELL_PROOF !== 'shell-assignment' || process.cwd() !== __dirname) process.exit(91); require('node:fs').writeFileSync('bash-effect.txt', 'bash-verified|' + process.execPath); console.log('exit=0')\n";

// Bash quoting only for this pinned, local fixture executable; no model-controlled interpolation.
export function privateShellCommand(nodeBinary: string): string {
  const quoted = `'${nodeBinary.replaceAll("'", "'\\''")}'`;
  return `ZCODE_NATIVE_SHELL_PROOF=shell-assignment ${quoted} verify.cjs`;
}

export function privateShellScriptPath(cwd: string): string {
  return join(cwd, "verify.cjs");
}
