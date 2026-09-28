import type { ClaudeSessionRuntime } from "./claudeRuntime.js";

/** Runtime lookup and create/attach reservation; SessionHost still owns accepted commands. */
export class ClaudeSessionRegistry {
  readonly #sessions = new Map<string, ClaudeSessionRuntime>();
  readonly #starting = new Map<string, Promise<ClaudeSessionRuntime>>();

  get(hostSessionId: string): ClaudeSessionRuntime | undefined {
    return this.#sessions.get(hostSessionId);
  }

  add(hostSessionId: string, runtime: ClaudeSessionRuntime): void {
    this.#sessions.set(hostSessionId, runtime);
  }

  remove(hostSessionId: string, expected?: ClaudeSessionRuntime): void {
    if (!expected || this.#sessions.get(hostSessionId) === expected)
      this.#sessions.delete(hostSessionId);
  }

  hasStarting(hostSessionId: string): boolean {
    return this.#starting.has(hostSessionId);
  }

  reserveStart(
    hostSessionId: string,
    start: () => Promise<ClaudeSessionRuntime>,
  ): Promise<ClaudeSessionRuntime> {
    if (this.#sessions.has(hostSessionId) || this.#starting.has(hostSessionId))
      throw new Error("duplicate Claude Host session");
    const pending = start();
    this.#starting.set(hostSessionId, pending);
    return pending;
  }

  releaseStart(hostSessionId: string, pending: Promise<ClaudeSessionRuntime>): void {
    if (this.#starting.get(hostSessionId) === pending) this.#starting.delete(hostSessionId);
  }

  pendingStarts(): readonly Promise<ClaudeSessionRuntime>[] {
    return [...this.#starting.values()];
  }

  values(): readonly ClaudeSessionRuntime[] {
    return [...this.#sessions.values()];
  }

  clear(): void {
    this.#sessions.clear();
  }
}
