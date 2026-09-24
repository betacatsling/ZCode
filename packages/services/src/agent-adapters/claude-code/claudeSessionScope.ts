import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { BindingPlan, SessionSpecV2 } from "@zcode/shared/agent-host";
import type { TrustedClaudeProfile } from "./contract.js";

export function claudeDir(root: string, spec: SessionSpecV2): string {
  return join(
    root,
    createHash("sha256")
      .update(
        JSON.stringify([
          spec.execution.targetId,
          spec.execution.workspaceIdentity,
          spec.execution.worktreeGeneration,
          spec.hostSessionId,
        ]),
      )
      .digest("hex"),
  );
}
export async function claudeCwd(
  profile: TrustedClaudeProfile,
  spec: SessionSpecV2,
): Promise<string> {
  const cwd = await profile.verifyCwd(spec);
  const within = relative(resolve(spec.execution.worktreePath), resolve(cwd));
  if (
    !isAbsolute(cwd) ||
    within === ".." ||
    within.startsWith("../") ||
    within.startsWith("..\\") ||
    isAbsolute(within)
  )
    throw new Error("Claude cwd outside trusted worktree");
  return cwd;
}
export function checkClaudePlan(spec: SessionSpecV2, plan: BindingPlan): void {
  if (
    spec.harness.id !== "claude-code" ||
    spec.harness.adapterVersion !== "2.1.263" ||
    plan.harnessId !== "claude-code" ||
    plan.adapterVersion !== "2.1.263" ||
    plan.hostSessionId !== spec.hostSessionId ||
    plan.targetId !== spec.execution.targetId ||
    plan.route !== "messages-gateway" ||
    plan.support.support !== "supported" ||
    plan.requested.kind !== "host-managed" ||
    spec.modelBinding.kind !== "host-managed" ||
    !plan.effective ||
    JSON.stringify(plan.requested) !== JSON.stringify(spec.modelBinding) ||
    JSON.stringify(plan.effective) !== JSON.stringify(spec.modelBinding.selection)
  )
    throw new Error("Claude requested/effective binding mismatch");
}
