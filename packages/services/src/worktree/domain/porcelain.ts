import { z } from "zod";
import { worktreeWorkspaceSchema } from "@zcode/shared/agent-host";

const oidSchema = z.string().regex(/^[0-9a-fA-F]{4,128}$/);
const headSchema = worktreeWorkspaceSchema.shape.head;
export type ParsedWorktreeHead = z.infer<typeof headSchema>;

export interface ParsedWorktree {
  path: string;
  head: ParsedWorktreeHead;
  locked: boolean;
}

function parseRecord(tokens: readonly string[]): ParsedWorktree | null {
  const worktree = tokens.find((token) => token.startsWith("worktree "));
  const head = tokens.find((token) => token.startsWith("HEAD "));
  if (!worktree || !head) return null;
  const path = worktree.slice("worktree ".length);
  const oid = head.slice("HEAD ".length);
  oidSchema.parse(oid);
  const branch = tokens.find((token) => token.startsWith("branch "));
  const locked = tokens.some((token) => token === "locked" || token.startsWith("locked "));
  if (branch) {
    const ref = branch.slice("branch ".length);
    if (!ref.startsWith("refs/heads/")) throw new Error(`unsupported worktree branch ref: ${ref}`);
    return { path, head: { kind: "branch", ref: ref.slice("refs/heads/".length), oid }, locked };
  }
  if (tokens.includes("detached")) return { path, head: { kind: "detached", oid }, locked };
  throw new Error(`unsupported worktree record: ${path}`);
}

/** Parse the NUL-delimited porcelain format without splitting paths on whitespace/newlines. */
export function parsePorcelainZ(stdout: string): ParsedWorktree[] {
  const records: ParsedWorktree[] = [];
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
  return /unknown switch ['"]?`?z|unknown option.*-z|invalid option.*-z/i.test(stderr);
}
