import { createHash } from "node:crypto";
import { join } from "node:path";
import type { BindingPlan, SessionSpecV2 } from "@zcode/shared/agent-host";

/** Private directory is keyed by target + workspace identity + Host ID, never a path-only alias. */
export function codexSessionProfile(root: string, spec: SessionSpecV2): string {
  return join(
    root,
    createHash("sha256")
      .update(
        JSON.stringify([
          spec.execution.targetId,
          spec.execution.workspaceIdentity,
          spec.workspaceId,
          spec.execution.worktreeGeneration,
          spec.hostSessionId,
        ]),
      )
      .digest("hex"),
  );
}

export function assertCodexBinding(spec: SessionSpecV2, plan: BindingPlan): void {
  if (
    spec.schemaVersion !== 2 ||
    spec.harness.id !== "codex" ||
    spec.harness.adapterVersion !== "0.156.1" ||
    plan.adapterVersion !== "0.156.1" ||
    plan.harnessId !== spec.harness.id ||
    plan.hostSessionId !== spec.hostSessionId ||
    plan.targetId !== spec.execution.targetId ||
    plan.route !== "responses-gateway" ||
    plan.support.support !== "supported" ||
    plan.requested.kind !== "host-managed" ||
    !plan.effective ||
    plan.effective.options?.reasoningLevel !== "off" ||
    JSON.stringify(plan.effective) !== JSON.stringify(plan.requested.selection)
  )
    throw new Error("Codex requires an exact supported off-only host-managed binding");
}
