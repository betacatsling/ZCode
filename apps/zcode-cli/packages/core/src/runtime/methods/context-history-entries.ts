import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { toCoreModelInputMessage } from "../../agent/model-input-entry.js";
import type { ContextBuildResult } from "../deps.js";

export function buildContextHistoryEntries(
  contextResult: ContextBuildResult,
): RuntimeMessageEntry[] {
  return [
    ...contextResult.systemMessages.map(
      (message): RuntimeMessageEntry => ({ message: toCoreModelInputMessage(message) }),
    ),
    ...contextResult.metaUserAttachments.map((attachment) =>
      systemReminderAttachmentEntry(attachment.source, attachment.content),
    ),
  ];
}
