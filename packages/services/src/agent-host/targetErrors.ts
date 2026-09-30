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
