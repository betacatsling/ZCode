import type { CodexSessionRuntime } from "./codexRuntime.js";

/** Target-local runtime lookup and create/attach reservation; it is not an accepted command queue. */
export class CodexSessionRegistry {
  readonly #sessions = new Map<string, CodexSessionRuntime>();
  readonly #starting = new Map<string, Promise<CodexSessionRuntime>>();

  get(hostSessionId: string): CodexSessionRuntime | undefined {
    return this.#sessions.get(hostSessionId);
  }

  add(hostSessionId: string, runtime: CodexSessionRuntime): void {
    this.#sessions.set(hostSessionId, runtime);
  }

  remove(hostSessionId: string, expected?: CodexSessionRuntime): void {
    if (!expected || this.#sessions.get(hostSessionId) === expected)
      this.#sessions.delete(hostSessionId);
  }

  hasStarting(hostSessionId: string): boolean {
    return this.#starting.has(hostSessionId);
  }

  reserveStart(
    hostSessionId: string,
    start: () => Promise<CodexSessionRuntime>,
  ): Promise<CodexSessionRuntime> {
    if (this.#sessions.has(hostSessionId) || this.#starting.has(hostSessionId)) {
      throw new Error("duplicate Codex Host session");
    }
    const pending = start();
    this.#starting.set(hostSessionId, pending);
    return pending;
  }

  releaseStart(hostSessionId: string, pending: Promise<CodexSessionRuntime>): void {
    if (this.#starting.get(hostSessionId) === pending) this.#starting.delete(hostSessionId);
  }

  pendingStarts(): readonly Promise<CodexSessionRuntime>[] {
    return [...this.#starting.values()];
  }

  values(): readonly CodexSessionRuntime[] {
    return [...this.#sessions.values()];
  }

  clear(): void {
    this.#sessions.clear();
  }
}
