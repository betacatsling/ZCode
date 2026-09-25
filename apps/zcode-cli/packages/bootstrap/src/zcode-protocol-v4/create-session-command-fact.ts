import type { SessionStorePort } from "@zcode/contracts";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import { queueItemIdForCommand } from "./command-inbox.js";

/** 查询不改变已接受输入：启动恢复才有权按真正的 runtime 状态丢弃 admitted。 */
export async function lookupGlobalCreateSessionCommand(
  store: SessionStorePort | undefined,
  commandId: string,
  isLive: (sessionId: string) => boolean = () => false,
): Promise<CommandAck | null> {
  const receipt = await store?.getNativeCreateReceipt?.(commandId);
  const record = await store?.getSessionInputById?.(queueItemIdForCommand(commandId));
  if (!receipt) return null;
  const sessionId = String(receipt.originalSessionId);
  if (receipt.status !== "completed") {
    return {
      commandId,
      status: "failed",
      reasonCode: "fault.command.createPending",
      revisionAtDecision: 0,
      result: { type: "createSession", sessionId },
    };
  }
  if (receipt.hasFirstInput) {
    if (
      !record ||
      String(record.sessionID) !== sessionId ||
      record.payload.sourceCommandType !== "createSession" ||
      (record.payload.conversationInputIntent as { sourceCommandId?: unknown } | undefined)
        ?.sourceCommandId !== commandId
    ) {
      return {
        commandId,
        status: "failed",
        reasonCode: "fault.command.inputPending",
        revisionAtDecision: 0,
        result: { type: "createSession", sessionId },
      };
    }
    if (record.status === "admitted" && !isLive(sessionId)) {
      return {
        commandId,
        status: "failed",
        reasonCode: "fault.command.inputPending",
        revisionAtDecision: 0,
        result: { type: "createSession", sessionId },
      };
    }
    if (record.status !== "admitted" && record.status !== "promoted") {
      return {
        commandId,
        status: "failed",
        reasonCode:
          record.status === "discarded" && record.statusReason === "session_resumed"
            ? "fault.command.inputDiscardedOnRestart"
            : "fault.command.inputCancelled",
        revisionAtDecision: 0,
        result: { type: "createSession", sessionId },
      };
    }
  }
  return {
    commandId,
    status: "accepted",
    revisionAtDecision: 0,
    result: {
      type: "createSession",
      sessionId,
      ...(receipt.hasFirstInput &&
      record &&
      String(record.sessionID) === sessionId &&
      (record.status === "promoted" || (record.status === "admitted" && isLive(sessionId)))
        ? {
            input: {
              delivery: record.delivery,
              inputId: commandId,
              ...(record.promotedMessageID ? { messageId: String(record.promotedMessageID) } : {}),
            },
          }
        : {}),
    },
  };
}
