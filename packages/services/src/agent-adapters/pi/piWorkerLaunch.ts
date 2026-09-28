import { createRequire } from "node:module";

/** Source-mode Workers need Node >=24 so `--import tsx` loads `.ts` (and deps like node:sqlite). */
export function assertPiWorkerNodeRuntime(): void {
  const major = Number(process.versions.node.split(".")[0] ?? 0);
  if (Number.isFinite(major) && major >= 24) return;
  throw new Error(
    `Pi worker requires Node.js >=24.0.0 (engines); current process is ${process.versions.node}`,
  );
}

export function piWorkerExecArgv(sourceMode: boolean): string[] | undefined {
  if (!sourceMode) return undefined;
  try {
    const require = createRequire(import.meta.url);
    return ["--import", require.resolve("tsx")];
  } catch {
    return ["--import", "tsx"];
  }
}
