import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentCommandReceipt } from "@zcode/shared/agent-host";
import { CommandJournal } from "../commandJournal.js";
import { assertIsolatedDrillRoot } from "./drillRoot.js";
import { RELEASE_ACCEPTANCE } from "./versionLock.js";

export interface MacLocalDrillSession {
  readonly hostSessionId: string;
  readonly workspaceId: string;
  readonly harnessId: string;
  readonly activity: "running";
  readonly lastTurn: "unknown";
  dispatched: number;
  readonly commandId: string;
  readonly prompt: string | null;
}

/**
 * macOS 本机 launchd 宿主的内存假传输。
 * 不断开真实链路，也不注册其他平台的服务。
 */
export class MacLocalFakeTransport {
  readonly acceptance = RELEASE_ACCEPTANCE;
  readonly #root: string;
  readonly #sessions = new Map<string, MacLocalDrillSession>();
  readonly #journals = new Map<string, CommandJournal>();
  #link: "up" | "down" = "up";
  #deleting = false;

  constructor(root: string) {
    this.#root = assertIsolatedDrillRoot(root);
  }

  async createSession(input: {
    hostSessionId: string;
    workspaceId: string;
    harnessId: string;
  }): Promise<void> {
    if (this.#deleting) throw new Error("deletion-admission-rejected");
    if (this.#sessions.has(input.hostSessionId)) throw new Error("duplicate-id");
    this.#sessions.set(input.hostSessionId, {
      hostSessionId: input.hostSessionId,
      workspaceId: input.workspaceId,
      harnessId: input.harnessId,
      activity: "running",
      lastTurn: "unknown",
      dispatched: 0,
      commandId: `cmd-${input.hostSessionId}`,
      prompt: null,
    });
  }

  listSessions(): readonly MacLocalDrillSession[] {
    return [...this.#sessions.values()];
  }

  async sendPrompt(hostSessionId: string, text: string): Promise<AgentCommandReceipt> {
    if (this.#link === "down") throw new Error("link-down");
    const session = this.#require(hostSessionId);
    const journal = await this.#openJournal(session);
    const receipt = await journal.accept({
      type: "send",
      commandId: session.commandId,
      hostSessionId: session.hostSessionId,
      turnId: "turn-1",
      text,
    });
    if (receipt.status === "accepted") {
      session.dispatched += 1;
      this.#sessions.set(hostSessionId, { ...session, prompt: text });
    }
    return receipt;
  }

  queryPrompt(hostSessionId: string): AgentCommandReceipt | undefined {
    const session = this.#require(hostSessionId);
    return this.#journals.get(hostSessionId)?.query(session.commandId);
  }

  /** 断线只关 journal。活动保持 running，未确认 prompt 不会再派发。 */
  async disconnect(): Promise<void> {
    this.#link = "down";
    for (const journal of this.#journals.values()) await journal.close();
    this.#journals.clear();
  }

  async reconnect(): Promise<void> {
    this.#link = "up";
  }

  beginDelete(): void {
    this.#deleting = true;
  }

  #require(hostSessionId: string): MacLocalDrillSession {
    const session = this.#sessions.get(hostSessionId);
    if (!session) throw new Error("unknown-session");
    return session;
  }

  async #openJournal(session: MacLocalDrillSession): Promise<CommandJournal> {
    const open = this.#journals.get(session.hostSessionId);
    if (open) return open;
    const root = join(this.#root, "journals");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const journal = await CommandJournal.open(root, {
      targetId: "local-mac",
      workspaceIdentity: session.workspaceId,
      harnessId: session.harnessId,
      hostSessionId: session.hostSessionId,
      runtimeEpoch: "epoch-1",
    });
    this.#journals.set(session.hostSessionId, journal);
    return journal;
  }
}
