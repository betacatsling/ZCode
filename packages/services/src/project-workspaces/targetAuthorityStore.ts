import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { PendingTargetCreation, TargetBindingRecord } from "./worktreeService.js";
import type { TargetWorkspaceRecord } from "./worktreeReconciler.js";

function validIdentity(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const identity = value as { device?: unknown; inode?: unknown };
  return Number.isSafeInteger(identity.device) && Number.isSafeInteger(identity.inode);
}

export interface TargetSnapshot {
  schemaVersion: 1;
  revision: number;
  executionTargetId: string;
  bindings: TargetBindingRecord[];
  workspaces: TargetWorkspaceRecord[];
  /** Durable intent written before Git mutation; never replay an uncertain create automatically. */
  pendingCreations?: PendingTargetCreation[];
  /** Deny sets are target-owned; older snapshots without these fields default to empty. */
  archivedBindings?: string[];
  archivedWorkspaces?: string[];
}

/** One target namespace has one writer; stale locks fail closed until explicitly recovered. */
export class TargetAuthorityStore {
  private constructor(
    private readonly dataFile: string,
    private readonly leaseFile: string,
    private readonly leaseToken: string,
    public state: TargetSnapshot,
  ) {}

  static async open(
    directory: string,
    targetId: string,
    recoverStaleOwner = false,
  ): Promise<TargetAuthorityStore> {
    await mkdir(directory, { recursive: true });
    const prefix = createHash("sha256").update(targetId).digest("hex");
    const dataFile = path.join(directory, `${prefix}.json`);
    const leaseFile = path.join(directory, `${prefix}.owner`);
    const token = randomUUID();
    if (recoverStaleOwner) {
      const recoveryFile = `${leaseFile}.recovery`;
      const recovery = await open(recoveryFile, "wx");
      try {
        const previous = await readFile(leaseFile, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (previous !== null) {
          const pid = (JSON.parse(previous) as { pid: number }).pid;
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Unknown target owner");
          try {
            process.kill(pid, 0);
            throw new Error("Target owner is still running");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
          await rm(leaseFile);
        }
        return await this.openUnderRecovery(dataFile, leaseFile, token, targetId);
      } finally {
        await recovery.close();
        await rm(recoveryFile);
      }
    }
    return this.openUnderRecovery(dataFile, leaseFile, token, targetId);
  }

  private static async openUnderRecovery(
    dataFile: string,
    leaseFile: string,
    token: string,
    targetId: string,
  ): Promise<TargetAuthorityStore> {
    const lease = await open(leaseFile, "wx");
    try {
      await lease.writeFile(JSON.stringify({ token, pid: process.pid }));
      const persisted = await readFile(dataFile, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const state: TargetSnapshot = persisted
        ? (JSON.parse(persisted) as TargetSnapshot)
        : {
            schemaVersion: 1,
            revision: 0,
            executionTargetId: targetId,
            bindings: [],
            workspaces: [],
          };
      if (
        state.schemaVersion !== 1 ||
        state.executionTargetId !== targetId ||
        !Array.isArray(state.bindings) ||
        !Array.isArray(state.workspaces) ||
        !Number.isSafeInteger(state.revision) ||
        ![state.archivedBindings, state.archivedWorkspaces].every(
          (ids) =>
            ids === undefined ||
            (Array.isArray(ids) &&
              ids.every((id) => typeof id === "string" && id.length > 0) &&
              new Set(ids).size === ids.length),
        ) ||
        !state.bindings.every(
          (binding) =>
            binding &&
            typeof binding.id === "string" &&
            (binding.projectId === undefined || typeof binding.projectId === "string") &&
            binding.executionTargetId === targetId &&
            typeof binding.repositoryPath === "string" &&
            validIdentity(binding.commonIdentity) &&
            typeof binding.instanceMarker === "string",
        ) ||
        !state.workspaces.every(
          (workspace) =>
            workspace &&
            typeof workspace.id === "string" &&
            typeof workspace.bindingId === "string" &&
            typeof workspace.path === "string" &&
            typeof workspace.generation === "string" &&
            validIdentity(workspace.adminIdentity) &&
            typeof workspace.instanceMarker === "string" &&
            ["active", "needsVerification", "pendingRemoval", "removed"].includes(
              workspace.lifecycle,
            ),
        ) ||
        new Set(state.bindings.map((binding) => binding.id)).size !== state.bindings.length ||
        new Set(state.workspaces.map((workspace) => workspace.id)).size !== state.workspaces.length
      )
        throw new Error("Invalid target registry snapshot");
      return new TargetAuthorityStore(dataFile, leaseFile, token, state);
    } catch (error) {
      await rm(leaseFile, { force: true });
      throw error;
    } finally {
      await lease.close();
    }
  }

  async assertLease(): Promise<void> {
    const lease = JSON.parse(await readFile(this.leaseFile, "utf8")) as { token: string };
    if (lease.token !== this.leaseToken) throw new Error("Target owner lease lost");
  }

  async save(next: TargetSnapshot): Promise<void> {
    await this.assertLease();
    const updated = { ...next, revision: this.state.revision + 1 };
    const temp = `${this.dataFile}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, "wx");
      try {
        await handle.writeFile(JSON.stringify(updated));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.dataFile);
      this.state = updated;
    } finally {
      await rm(temp, { force: true });
    }
  }

  async close(): Promise<void> {
    await this.assertLease();
    await rm(this.leaseFile);
  }
}
