import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { resolveWorkspaceAdmissionKey } from "@zcode/shared/agent-host";

const stableId = z.string().trim().min(1).max(256);

export const workspaceSessionCreationReceiptSchema = z
  .strictObject({
    targetId: stableId,
    requestId: z.string().trim().min(1).max(256),
    requestFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    workspaceId: stableId,
    worktreeGeneration: stableId,
    /** Optional explicit identity. Older receipts stored the resolved key here. */
    workspaceIdentity: z.string().min(1).max(2048).optional(),
    /** Original opaque filesystem path, including path-fallback bytes. */
    workspacePath: z.string().min(1).max(4096).optional(),
    harnessId: stableId,
    ownerKind: z.enum(["native-v4", "agent-host"]),
    ownerSessionId: stableId,
    title: z.string().max(256).optional(),
    state: z.enum(["reserved", "created"]),
  })
  .superRefine((receipt, context) => {
    if (!receipt.workspaceIdentity && !receipt.workspacePath) {
      context.addIssue({
        code: "custom",
        path: ["workspacePath"],
        message: "receipt requires a path or an identity key",
      });
    }
  });
export type WorkspaceSessionCreationReceipt = z.infer<typeof workspaceSessionCreationReceiptSchema>;

function workspaceKey(receipt: WorkspaceSessionCreationReceipt): string | undefined {
  if (receipt.workspacePath !== undefined) {
    // path fallback 按字节保留；只有显式 identity 才经过 trim。
    return resolveWorkspaceAdmissionKey(receipt.workspaceIdentity, receipt.workspacePath);
  }
  // V1 receipts stored the resolved key in workspaceIdentity.
  return receipt.workspaceIdentity;
}

const workspaceSessionReceiptFileSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    receipts: z.array(workspaceSessionCreationReceiptSchema).max(50_000),
  })
  .superRefine((file, context) => {
    const keys = new Set<string>();
    for (const [index, receipt] of file.receipts.entries()) {
      const key = `${receipt.targetId}\0${receipt.requestId}`;
      if (keys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["receipts", index],
          message: "duplicate target request receipt",
        });
      }
      keys.add(key);
    }
  });

export interface WorkspaceSessionReceiptStore {
  reserve(
    receipt: Omit<WorkspaceSessionCreationReceipt, "state">,
  ): Promise<WorkspaceSessionCreationReceipt>;
  markCreated(targetId: string, requestId: string, requestFingerprint: string): Promise<void>;
  listNative(
    targetId: string,
    workspaceId: string,
    worktreeGeneration: string,
    workspaceIdentity: string,
  ): Promise<readonly WorkspaceSessionCreationReceipt[]>;
  listCreatedHistory(
    targetId: string,
    workspaceId: string,
  ): Promise<readonly WorkspaceSessionCreationReceipt[]>;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function createFileWorkspaceSessionReceiptStore(
  filePath: string,
): WorkspaceSessionReceiptStore {
  async function readFileValue() {
    try {
      return workspaceSessionReceiptFileSchema.parse(
        JSON.parse(await readFile(filePath, "utf8")) as unknown,
      );
    } catch (error) {
      if (isNotFound(error)) return { schemaVersion: 1 as const, receipts: [] };
      throw error;
    }
  }

  async function write(receipts: readonly WorkspaceSessionCreationReceipt[]) {
    const next = workspaceSessionReceiptFileSchema.parse({ schemaVersion: 1, receipts });
    await atomicWritePrivateTextFile(filePath, `${JSON.stringify(next, null, 2)}\n`);
  }

  return {
    async reserve(raw) {
      const receipt = workspaceSessionCreationReceiptSchema.parse({ ...raw, state: "reserved" });
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      return withFileLock(filePath, async () => {
        const current = await readFileValue();
        const existing = current.receipts.find(
          (item) => item.targetId === receipt.targetId && item.requestId === receipt.requestId,
        );
        if (existing) {
          if (
            existing.requestFingerprint !== receipt.requestFingerprint ||
            existing.workspaceId !== receipt.workspaceId ||
            existing.worktreeGeneration !== receipt.worktreeGeneration ||
            workspaceKey(existing) !== workspaceKey(receipt) ||
            existing.harnessId !== receipt.harnessId ||
            existing.ownerKind !== receipt.ownerKind ||
            existing.ownerSessionId !== receipt.ownerSessionId ||
            existing.title !== receipt.title
          ) {
            throw new Error("workspace-session-idempotency-conflict");
          }
          return existing;
        }
        await write([...current.receipts, receipt]);
        return receipt;
      });
    },
    async markCreated(targetId, requestId, requestFingerprint) {
      await withFileLock(filePath, async () => {
        const current = await readFileValue();
        const existing = current.receipts.find(
          (item) => item.targetId === targetId && item.requestId === requestId,
        );
        if (!existing || existing.requestFingerprint !== requestFingerprint) {
          throw new Error("workspace-session-create-receipt-missing");
        }
        if (existing.state === "created") return;
        await write(
          current.receipts.map((item) =>
            item.targetId === targetId && item.requestId === requestId
              ? { ...item, state: "created" as const }
              : item,
          ),
        );
      });
    },
    async listNative(targetId, workspaceId, worktreeGeneration, workspaceIdentity) {
      const current = await readFileValue();
      return current.receipts.filter(
        (receipt) =>
          receipt.state === "created" &&
          receipt.ownerKind === "native-v4" &&
          receipt.targetId === targetId &&
          receipt.workspaceId === workspaceId &&
          receipt.worktreeGeneration === worktreeGeneration &&
          workspaceKey(receipt) === workspaceIdentity,
      );
    },
    async listCreatedHistory(targetId, workspaceId) {
      const current = await readFileValue();
      return current.receipts.filter(
        (receipt) =>
          receipt.state === "created" &&
          receipt.targetId === targetId &&
          receipt.workspaceId === workspaceId,
      );
    },
  };
}
