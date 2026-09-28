import type { CodexJsonRpcMessage } from "./codexAppServerProcess.js";
import { codexTurnItemId, emitTurnStarted, ensureToolStarted } from "./codexEventTranslator.js";
import type { CodexSessionRuntime } from "./codexRuntime.js";

export async function handleCodexServerRequest(
  runtime: CodexSessionRuntime,
  message: CodexJsonRpcMessage,
): Promise<void> {
  if (message.id === undefined || !isJsonRpcId(message.id)) return;
  const method = message.method ?? "";
  if (
    method !== "item/commandExecution/requestApproval" &&
    method !== "item/fileChange/requestApproval"
  ) {
    await runtime.process.rejectServerRequest(
      message.id,
      -32601,
      "Unsupported Codex app-server request",
    );
    runtime.emit("session.error", {
      code: "unsupported-codex-request",
      message: "Codex app-server requested an unsupported operation.",
    });
    return;
  }
  const params = isRecord(message.params) ? message.params : undefined;
  const turn = runtime.activeTurn;
  const itemId = params && typeof params.itemId === "string" ? params.itemId : "";
  if (
    !params ||
    params.threadId !== runtime.threadId ||
    !turn ||
    typeof params.turnId !== "string" ||
    params.turnId !== turn.backendTurnId ||
    !itemId
  ) {
    await runtime.process.rejectServerRequest(
      message.id,
      -32600,
      "Stale or malformed Codex approval request",
    );
    runtime.emit("session.error", {
      code: "stale-codex-approval",
      message: "Codex app-server approval did not match the active Host turn.",
    });
    return;
  }
  const requestKey = codexApprovalRequestKey(turn.hostTurnId, message.id);
  if (
    runtime.resolvedRequestIds.has(requestKey) ||
    runtime.resolvingRequestIds.has(requestKey) ||
    [...runtime.pendingApprovals.values()].some(
      (item) => codexApprovalRequestKey(item.hostTurnId, item.rpcId) === requestKey,
    )
  ) {
    await runtime.process.rejectServerRequest(
      message.id,
      -32600,
      "Duplicate Codex approval request id",
    );
    runtime.emit("session.error", {
      code: "duplicate-codex-approval",
      message: "Codex app-server repeated an approval request id.",
    });
    return;
  }
  emitTurnStarted(runtime.emit, turn);
  const isCommand = method === "item/commandExecution/requestApproval";
  const toolName = isCommand ? "exec_command" : "file_change";
  const toolCallId = codexTurnItemId(turn.hostTurnId, itemId);
  const command = isCommand && typeof params.command === "string" ? params.command : undefined;
  const reason = typeof params.reason === "string" ? params.reason : undefined;
  const summary =
    [command, reason].filter(Boolean).join("\n").slice(0, 16_000) ||
    (isCommand ? "Codex requested command execution." : "Codex requested file changes.");
  ensureToolStarted(runtime.emit, runtime, turn, toolCallId, toolName, summary);
  // JSON-RPC IDs are process-local and Codex may reuse them after a cold thread/resume.
  // The UI envelope carries only this public ID plus the stable Host epoch, so bind it
  // to the originating Host turn while retaining the exact native ID below for reply.
  const interactionId = `codex:${runtime.binding.runtimeEpoch}:${requestKey}`;
  runtime.pendingApprovals.set(interactionId, {
    rpcId: message.id,
    interactionId,
    hostTurnId: turn.hostTurnId,
    backendTurnId: turn.backendTurnId!,
    itemId,
    toolCallId,
    toolName,
    summary,
  });
  runtime.emit("interaction.requested", {
    turnId: turn.hostTurnId,
    interactionId,
    toolCallId,
    summary,
  });
}

export function codexJsonRpcIdKey(value: string | number): string {
  return `${typeof value}:${String(value)}`;
}

export function codexApprovalRequestKey(hostTurnId: string, value: string | number): string {
  return `${hostTurnId}:${codexJsonRpcIdKey(value)}`;
}

function isJsonRpcId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
