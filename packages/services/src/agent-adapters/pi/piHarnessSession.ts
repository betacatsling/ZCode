import type { AgentCommand, AgentEvent } from "@zcode/shared/agent-host";
import { commandReceipt, commandResult, unsupportedCommandReason } from "./piCommandReceipt.js";
import { recordPiModelRoute } from "./piModelBindingBridge.js";
import type {
  PiCommandResult,
  PiModelRouteRecord,
  PiPeerFrame,
  PiPlannerHarness,
  PiTurnBindContext,
} from "./piControlProtocol.js";
import { PiPeerProjector } from "./piPeerProjector.js";
import type { PiRpcSession } from "./piRpcSession.js";

interface TurnWaiter {
  readonly promise: Promise<void>;
  finish(): void;
}

/** Owner of one hostSessionId: turn admission, approval gate, and history. */
export class PiHarnessSession {
  readonly #rpc: PiRpcSession;
  readonly #planner: Parameters<typeof recordPiModelRoute>[0]["planner"];
  readonly #harness: PiPlannerHarness;
  readonly #hostSessionId: string;
  readonly #runtimeEpoch: string;
  readonly #projector: PiPeerProjector;
  readonly #commands = new Map<string, PiCommandResult>();
  readonly #routes: PiModelRouteRecord[] = [];
  #waiter?: TurnWaiter;
  #backendSessionId?: string;

  constructor(options: {
    rpc: PiRpcSession;
    planner: Parameters<typeof recordPiModelRoute>[0]["planner"];
    harness: PiPlannerHarness;
    hostSessionId: string;
    runtimeEpoch: string;
    now: () => number;
    ids: () => string;
  }) {
    this.#rpc = options.rpc;
    this.#planner = options.planner;
    this.#harness = options.harness;
    this.#hostSessionId = options.hostSessionId;
    this.#runtimeEpoch = options.runtimeEpoch;
    this.#projector = new PiPeerProjector({
      rpc: options.rpc,
      hostSessionId: options.hostSessionId,
      runtimeEpoch: options.runtimeEpoch,
      now: options.now,
      ids: options.ids,
      onTurnFinished: () => this.#waiter?.finish(),
    });
  }

  attachBackend(backendSessionId: string): void {
    this.#backendSessionId = backendSessionId;
  }

  get backendSessionId(): string {
    return this.#backendSessionId ?? "pending";
  }

  get runtimeEpoch(): string {
    return this.#runtimeEpoch;
  }

  routes(): readonly PiModelRouteRecord[] {
    return this.#routes;
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    return this.#projector.subscribe(listener);
  }

  handlePeer(frame: PiPeerFrame): void {
    this.#projector.handle(frame);
  }

  async command(command: AgentCommand, bind?: PiTurnBindContext): Promise<PiCommandResult> {
    if (this.#commands.has(command.commandId)) {
      return { receipt: commandReceipt(command.commandId, "duplicate") };
    }
    this.#commands.set(command.commandId, {
      receipt: commandReceipt(command.commandId, "accepted"),
    });
    if (command.hostSessionId !== this.#hostSessionId) {
      return this.#remember(
        command.commandId,
        commandResult(
          command.commandId,
          "rejected",
          "invalid-binding",
          "command belongs to another Pi session",
        ),
      );
    }
    if (command.type === "send") return this.#send(command, bind);
    if (command.type === "cancelTurn") return this.#cancel(command);
    if (command.type === "resolveInteraction") return this.#resolve(command);
    if (command.type === "viewHistory") return this.#history(command.commandId);
    if (command.type === "detach") return this.#detach(command.commandId);
    if (command.type === "terminateSession") return this.#terminate(command.commandId);
    return this.#remember(
      command.commandId,
      commandResult(
        command.commandId,
        "rejected",
        "unsupported",
        unsupportedCommandReason(command.type),
      ),
    );
  }

  async close(): Promise<void> {
    await this.#rpc.close();
  }

  async #send(
    command: Extract<AgentCommand, { type: "send" }>,
    bind?: PiTurnBindContext,
  ): Promise<PiCommandResult> {
    if (!bind || bind.spec.hostSessionId !== this.#hostSessionId) {
      return this.#remember(
        command.commandId,
        commandResult(
          command.commandId,
          "rejected",
          "invalid-binding",
          "Pi turn is missing its binding context",
        ),
      );
    }
    if (this.#projector.activeTurn) {
      return this.#remember(
        command.commandId,
        commandResult(command.commandId, "rejected", "stale-turn", "a Pi turn is already active"),
      );
    }
    const decision = await recordPiModelRoute({
      planner: this.#planner,
      harness: this.#harness,
      turnId: command.turnId,
      bind,
    });
    this.#routes.push(decision.record);
    if (!decision.hint || !decision.record.accepted) {
      return this.#remember(
        command.commandId,
        commandResult(
          command.commandId,
          "rejected",
          "invalid-binding",
          decision.record.reason ?? "binding plan rejected",
        ),
      );
    }
    this.#projector.setActiveTurn(command.turnId);
    this.#waiter = turnWaiter();
    this.#projector.emit({ kind: "turn.started", turnId: command.turnId });
    try {
      await this.#rpc.send({
        type: "turn.prompt",
        turnId: command.turnId,
        text: command.text,
        model: decision.hint,
      });
      await this.#waiter.promise;
      return this.#remember(command.commandId, commandResult(command.commandId, "completed"));
    } catch {
      this.#projector.setActiveTurn(undefined);
      this.#waiter?.finish();
      return this.#remember(
        command.commandId,
        commandResult(
          command.commandId,
          "execution-unknown",
          "execution-unknown",
          "Pi turn ended before the transport confirmed it",
        ),
      );
    }
  }

  async #cancel(command: Extract<AgentCommand, { type: "cancelTurn" }>): Promise<PiCommandResult> {
    if (command.runtimeEpoch !== this.#runtimeEpoch) {
      return this.#remember(
        command.commandId,
        commandResult(
          command.commandId,
          "rejected",
          "stale-epoch",
          "cancel belongs to an older Pi runtime epoch",
        ),
      );
    }
    if (!this.#projector.activeTurn || command.turnId !== this.#projector.activeTurn) {
      return this.#remember(
        command.commandId,
        commandResult(
          command.commandId,
          "rejected",
          "stale-turn",
          "cancel does not match the active Pi turn",
        ),
      );
    }
    // 先标记取消，再解开审批等待。若先放行拒绝帧，对端会把本轮收成成功。
    this.#projector.settlePending("deny");
    await this.#rpc.send({
      type: "turn.cancel",
      turnId: command.turnId,
      runtimeEpoch: this.#runtimeEpoch,
    });
    await this.#waiter?.promise;
    return this.#remember(command.commandId, commandResult(command.commandId, "completed"));
  }

  async #resolve(
    command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): Promise<PiCommandResult> {
    if (command.runtimeEpoch !== this.#runtimeEpoch) {
      return this.#remember(
        command.commandId,
        commandResult(
          command.commandId,
          "rejected",
          "stale-epoch",
          "approval belongs to an older Pi runtime epoch",
        ),
      );
    }
    const pending = this.#projector.pending;
    if (!pending || pending.turnId !== command.turnId) {
      return this.#remember(
        command.commandId,
        commandResult(
          command.commandId,
          "rejected",
          "stale-turn",
          "approval does not match the active Pi turn",
        ),
      );
    }
    if (pending.interactionId !== command.interactionId) {
      return this.#remember(
        command.commandId,
        commandResult(
          command.commandId,
          "rejected",
          "stale-interaction",
          "approval does not match the pending tool",
        ),
      );
    }
    this.#projector.clearPending();
    this.#projector.emit({
      kind: "interaction.resolved",
      turnId: pending.turnId,
      interactionId: pending.interactionId,
      decision: command.decision,
    });
    if (command.decision === "allow") {
      // 放行帧在 tool.started 之后才送出，对端在这之前不能执行工具。
      this.#projector.markStarted(pending.interactionId);
      this.#projector.emit({
        kind: "tool.started",
        turnId: pending.turnId,
        toolCallId: pending.interactionId,
        name: pending.name,
      });
    }
    await this.#rpc.send({
      type: "approval.decision",
      turnId: pending.turnId,
      interactionId: pending.interactionId,
      decision: command.decision,
    });
    return this.#remember(command.commandId, commandResult(command.commandId, "completed"));
  }

  #history(commandId: string): PiCommandResult {
    const value = {
      receipt: commandReceipt(commandId, "completed"),
      events: [...this.#projector.events()],
    };
    this.#commands.set(commandId, value);
    return value;
  }

  #detach(commandId: string): PiCommandResult {
    this.#projector.clearListeners();
    return this.#remember(commandId, commandResult(commandId, "completed"));
  }

  async #terminate(commandId: string): Promise<PiCommandResult> {
    this.#projector.settlePending("deny");
    await this.#rpc.send({ type: "session.terminate", hostSessionId: this.#hostSessionId });
    await this.#waiter?.promise;
    await this.#rpc.close();
    return this.#remember(commandId, commandResult(commandId, "completed"));
  }

  #remember(commandId: string, value: PiCommandResult): PiCommandResult {
    this.#commands.set(commandId, value);
    return value;
  }
}

function turnWaiter(): TurnWaiter {
  let finish = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let settled = false;
  return {
    promise,
    finish() {
      if (settled) return;
      settled = true;
      finish();
    },
  };
}
