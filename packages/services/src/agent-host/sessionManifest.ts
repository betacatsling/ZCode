import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  backendBindingSchema, backendBindingV2Schema, bindingPlanSchema,
  legacySessionSpecSchema, writableSessionSpecV2Schema,
  type BackendBindingV2, type LegacySessionSpec, type SessionSpecV2,
} from "@zcode/shared/agent-host";
import type { HarnessAdapter } from "./harnessRegistry.js";

const legacyManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  state: z.enum(["creating", "running", "terminated"]),
  spec: legacySessionSpecSchema,
  plan: bindingPlanSchema,
  binding: backendBindingSchema.optional(),
});
export const manifestSchema = z.strictObject({
  schemaVersion: z.literal(2),
  state: z.enum(["creating", "running", "terminated"]),
  spec: writableSessionSpecV2Schema,
  plan: bindingPlanSchema,
  binding: backendBindingV2Schema.optional(),
});
export type Manifest = z.infer<typeof manifestSchema>;
export const readableManifestSchema = z.union([legacyManifestSchema, manifestSchema]);
type ReadableManifest = z.infer<typeof readableManifestSchema>;

export function matchesScope(manifest: ReadableManifest, spec: LegacySessionSpec | SessionSpecV2): boolean {
  return JSON.stringify(manifest.spec) === JSON.stringify(spec);
}
export function assertBinding(spec: SessionSpecV2, binding: BackendBindingV2, adapter: HarnessAdapter): void {
  if (binding.hostSessionId !== spec.hostSessionId || binding.backendVersion !== adapter.version ||
    binding.targetId !== spec.execution.targetId || binding.workspaceId !== spec.workspaceId ||
    binding.worktreeGeneration !== spec.execution.worktreeGeneration || binding.harnessId !== spec.harness.id)
    throw new Error("backend identity mismatch");
}
export function manifestPath(root: string, spec: LegacySessionSpec | SessionSpecV2): string {
  const identity = [spec.execution.targetId, spec.execution.workspaceIdentity, spec.harness.id, spec.hostSessionId];
  return join(root, `${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}.session.json`);
}
export async function saveManifest(path: string, value: Manifest): Promise<void> {
  const checked = manifestSchema.parse(value);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(checked), { mode: 0o600 });
  await rename(tmp, path);
}
