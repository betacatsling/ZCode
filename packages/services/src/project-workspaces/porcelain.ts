import type { WorktreeWorkspace } from "./planTypes.js";
import { ProjectWorkspaceError } from "./errors.js";

export interface PorcelainRecord {
  path: string;
  head: WorktreeWorkspace["head"];
  locked: boolean;
  bare: boolean;
}

function parseRecord(tokens: readonly string[]): PorcelainRecord | null {
  if (tokens.length === 0) return null;
  const worktree = tokens.find((token) => token.startsWith("worktree "));
  const head = tokens.find((token) => token.startsWith("HEAD "));
  if (!worktree || !head) throw new ProjectWorkspaceError("invalid-porcelain");
  const path = worktree.slice("worktree ".length);
  const oid = head.slice("HEAD ".length);
  if (!path || !/^[0-9a-fA-F]{4,128}$/.test(oid)) {
    throw new ProjectWorkspaceError("invalid-porcelain");
  }
  const bare = tokens.includes("bare");
  const branch = tokens.find((token) => token.startsWith("branch "));
  const detached = tokens.includes("detached");
  const locked = tokens.some((token) => token === "locked" || token.startsWith("locked "));
  if (bare) return { path, head: { kind: "detached", oid }, locked, bare: true };
  if (branch && detached) throw new ProjectWorkspaceError("invalid-porcelain");
  if (branch) {
    const ref = branch.slice("branch ".length);
    if (!ref.startsWith("refs/heads/")) throw new ProjectWorkspaceError("unsupported-branch-ref");
    return {
      path,
      head: { kind: "branch", ref: ref.slice("refs/heads/".length), oid },
      locked,
      bare: false,
    };
  }
  if (detached) return { path, head: { kind: "detached", oid }, locked, bare: false };
  throw new ProjectWorkspaceError("invalid-porcelain");
}

/** 只按 NUL 切 porcelain -z，路径里的空格和换行留在同一字段。 */
export function parsePorcelainZ(stdout: string): PorcelainRecord[] {
  const records: PorcelainRecord[] = [];
  let tokens: string[] = [];
  for (const token of stdout.split("\0")) {
    if (token.length === 0) {
      const record = parseRecord(tokens);
      if (record) records.push(record);
      tokens = [];
    } else {
      tokens.push(token);
    }
  }
  const tail = parseRecord(tokens);
  if (tail) records.push(tail);
  return records;
}

export function isUnknownZSwitch(stderr: string): boolean {
  return /unknown switch ['"]?`?z|unknown option.*\bz\b|invalid option.*\bz\b/i.test(stderr);
}
