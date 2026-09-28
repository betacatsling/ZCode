import type { AgentErrorCode } from "@zcode/shared/agent-host";

export class ClaudeCodeAdapterError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, message: string) {
    super(message);
    this.name = "ClaudeCodeAdapterError";
    this.code = code;
  }
}
