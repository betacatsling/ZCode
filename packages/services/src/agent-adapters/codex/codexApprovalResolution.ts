import type { AgentCommand } from "@zcode/shared/agent-host";
import { codexApprovalRequestKey } from "./codexApprovalProtocol.js";
import type { CodexSessionRuntime } from "./codexRuntime.js";

export async function resolveCodexApproval(
  runtime: CodexSessionRuntime,
  command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  onFailure: (error: Error) => void,
): Promise<void> {
  const turn = runtime.activeTurn;
  const pending = runtime.pendingApprovals.get(command.interactionId);
  if (
    runtime.binding.runtimeEpoch !== command.runtimeEpoch ||
    !turn ||
    turn.hostTurnId !== command.turnId ||
    !pending ||
    pending.hostTurnId !== command.turnId ||
    pending.backendTurnId !== turn.backendTurnId
  ) {
    throw new Error("stale Codex approval interaction");
  }
  const requestKey = codexApprovalRequestKey(pending.hostTurnId, pending.rpcId);
  if (runtime.resolvedRequestIds.has(requestKey) || runtime.resolvingRequestIds.has(requestKey))
    throw new Error("Codex approval request already has a winning resolution");
  runtime.resolvingRequestIds.add(requestKey);
  try {
    await runtime.process.respondToServerRequest(pending.rpcId, {
      decision: command.decision === "allow" ? "accept" : "decline",
    });
    if (runtime.activeTurn !== turn) return;
    runtime.pendingApprovals.delete(command.interactionId);
    runtime.resolvedRequestIds.add(requestKey);
    runtime.emit("interaction.resolved", {
      turnId: turn.hostTurnId,
      interactionId: pending.interactionId,
      decision: command.decision,
    });
  } catch (error) {
    onFailure(error instanceof Error ? error : new Error("Codex approval response failed"));
    throw error;
  } finally {
    runtime.resolvingRequestIds.delete(requestKey);
  }
}
