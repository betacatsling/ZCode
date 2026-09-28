import { basename } from "node:path";
import type {
  FilesystemEvidence,
  WorktreeCandidate,
  WorktreeWorkspaceRecord,
} from "../contract.js";

export function equalEvidence(left: FilesystemEvidence, right: FilesystemEvidence): boolean {
  if (
    left.device === null ||
    left.inode === null ||
    left.birthtimeMs === null ||
    right.device === null ||
    right.inode === null ||
    right.birthtimeMs === null
  ) {
    return false;
  }
  return (
    left.canonicalPath === right.canonicalPath &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeMs === right.birthtimeMs
  );
}

export function sameEvidenceRecord(left: FilesystemEvidence, right: FilesystemEvidence): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeMs === right.birthtimeMs
  );
}

export function preserveLifecycle(
  stored: WorktreeWorkspaceRecord,
  observed: "active" | "missing",
): WorktreeWorkspaceRecord["lifecycle"] {
  return stored.lifecycle === "archived" || stored.lifecycle === "removed"
    ? stored.lifecycle
    : observed;
}

export function titleForCandidate(candidate: WorktreeCandidate): string {
  return candidate.head.kind === "branch" ? candidate.head.ref : basename(candidate.worktreePath);
}
