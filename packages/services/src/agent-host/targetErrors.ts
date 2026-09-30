/**
 * The target is open but has not mounted this session: never attached here, its attach/create
 * failed, or another target owner holds it. Not host-closed: attaching (or asking the owner that
 * holds it) is the remedy, and history reads still work. Crosses @zcode/rpc as name + code.
 */
export class SessionNotAttachedError extends Error {
  readonly code = "not-attached" as const;
  constructor() {
    super("external session is not attached; query history or explicitly attach first");
    this.name = "SessionNotAttachedError";
  }
}

/**
 * AgentHostTargetService.close() after closing every mounted host, when more than one failed
 * (a single failure is rethrown unchanged). `errors` / `failures` keep close order; each cause
 * keeps its own type (EventStreamFailure, SessionHostBusyError, I/O errors...).
 */
export class TargetHostsCloseError extends AggregateError {
  readonly code = "target-close-failed" as const;
  readonly failures: readonly { hostSessionId: string; error: unknown }[];
  constructor(failures: readonly { hostSessionId: string; error: unknown }[]) {
    super(
      failures.map((failure) => failure.error),
      `${failures.length} session hosts failed to close: ${failures
        .map(({ hostSessionId, error }) => `${hostSessionId}: ${messageOf(error)}`)
        .join("; ")}`,
    );
    this.name = "TargetHostsCloseError";
    this.failures = failures;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
