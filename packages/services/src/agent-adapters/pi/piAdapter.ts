import { randomUUID } from "node:crypto";
import {
  backendBindingSchema,
  type AgentCommand,
  type AgentEvent,
  type BackendBinding,
  type CapabilityReport,
  type ExecutionTarget,
  type HarnessCapabilities,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import type { ModelSelection } from "@zcode/shared/model-selection";
import { createServiceLogger } from "../../logger/serviceLogger.js";
import type {
  PiCommandResult,
  PiModelBindingPlannerPort,
  PiModelRouteRecord,
  PiTurnBindContext,
} from "./piControlProtocol.js";
import { piControlPlaneCapabilities, piControlPlaneHostManagedSupport } from "./piCapabilities.js";
import { PiHarnessSession } from "./piHarnessSession.js";
import { PiRpcSession } from "./piRpcSession.js";
import type { PiTurnTransport } from "./piTurnTransport.js";

const logger = createServiceLogger("pi-control");

/**
 * One Pi session per hostSessionId.
 * Workspace plus harness is not a singleton key.
 */
export class PiAdapter {
  readonly id = "pi";
  readonly version: string;
  readonly hostManagedRoute = "pi-sdk" as const;
  readonly #planner: PiModelBindingPlannerPort;
  readonly #transportFactory: (spec: SessionSpec) => PiTurnTransport;
  readonly #now: () => number;
  readonly #ids: () => string;
  readonly #sessions = new Map<string, PiHarnessSession>();

  constructor(options: {
    planner: PiModelBindingPlannerPort;
    transportFactory: (spec: SessionSpec) => PiTurnTransport;
    version?: string;
    now?: () => number;
    ids?: () => string;
  }) {
    this.#planner = options.planner;
    this.#transportFactory = options.transportFactory;
    this.version = options.version ?? "0.87.1";
    this.#now = options.now ?? Date.now;
    this.#ids = options.ids ?? (() => randomUUID());
  }

  async probe(target: ExecutionTarget): Promise<CapabilityReport> {
    if (!target.available)
      return { support: "unsupported", reason: target.reason ?? "target unavailable" };
    if (target.kind === "ssh") {
      return {
        support: "unsupported",
        reason: "Pi RPC control plane has no remote runtime attachment in this revision",
      };
    }
    if (target.platform === "win32")
      return { support: "unsupported", reason: "Pi control plane is not certified on Windows" };
    return {
      support: "supported",
      reason:
        "Pi control plane probe only checks a local non-Windows target. It does not certify resumeExecution, images, or modelSwitch.",
    };
  }

  async capabilities(_target: ExecutionTarget): Promise<HarnessCapabilities> {
    return piControlPlaneCapabilities(this.hostManagedRoute);
  }

  async hostManagedSupport(
    target: ExecutionTarget,
    selection: ModelSelection,
  ): Promise<CapabilityReport> {
    return piControlPlaneHostManagedSupport(
      await this.probe(target),
      selection,
      this.hostManagedRoute,
    );
  }

  async harnessManagedSupport(target: ExecutionTarget): Promise<CapabilityReport> {
    const probe = await this.probe(target);
    if (probe.support !== "supported") return probe;
    return { support: "supported", constraints: { unifiedModelRouting: false } };
  }

  async open(spec: SessionSpec): Promise<BackendBinding> {
    if (spec.harness.id !== this.id || spec.harness.adapterVersion !== this.version) {
      throw new Error("Pi harness identity or adapter version mismatch");
    }
    if (this.#sessions.has(spec.hostSessionId)) throw new Error("duplicate Pi session");
    const runtimeEpoch = this.#ids();
    let session!: PiHarnessSession;
    const rpc = new PiRpcSession({
      transport: this.#transportFactory(spec),
      onPeer: (frame) => session.handlePeer(frame),
    });
    session = new PiHarnessSession({
      rpc,
      planner: this.#planner,
      harness: this,
      hostSessionId: spec.hostSessionId,
      runtimeEpoch,
      now: this.#now,
      ids: this.#ids,
    });
    this.#sessions.set(spec.hostSessionId, session);
    try {
      const backendSessionId = await rpc.open(spec.hostSessionId, runtimeEpoch);
      session.attachBackend(backendSessionId);
      logger.info(undefined, "pi control session opened", {
        hostSessionId: spec.hostSessionId,
        backendSessionId,
      });
      return backendBindingSchema.parse({
        hostSessionId: spec.hostSessionId,
        backendSessionId,
        backendVersion: this.version,
        runtimeEpoch,
      });
    } catch (error) {
      this.#sessions.delete(spec.hostSessionId);
      await rpc.close();
      throw error;
    }
  }

  async dispatch(command: AgentCommand, bind?: PiTurnBindContext): Promise<PiCommandResult> {
    const session = this.#sessions.get(command.hostSessionId);
    if (!session) {
      return {
        receipt: {
          commandId: command.commandId,
          status: "rejected",
          reasonCode: "backend-failure",
          message: "Pi backend not attached",
        },
      };
    }
    const result = await session.command(command, bind);
    if (command.type === "terminateSession" && result.receipt.status === "completed") {
      this.#sessions.delete(command.hostSessionId);
    }
    if (command.type === "send" && result.receipt.status !== "duplicate") {
      const route = session.routes().find((item) => item.turnId === command.turnId);
      if (route) this.#logRoute(route);
    }
    return result;
  }

  subscribe(hostSessionId: string, listener: (event: AgentEvent) => void): () => void {
    const session = this.#sessions.get(hostSessionId);
    if (!session) return () => {};
    return session.subscribe(listener);
  }

  modelRoutes(hostSessionId: string): readonly PiModelRouteRecord[] {
    return this.#sessions.get(hostSessionId)?.routes() ?? [];
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }

  #logRoute(route: PiModelRouteRecord): void {
    logger.info(undefined, "pi model route recorded", {
      hostSessionId: route.hostSessionId,
      turnId: route.turnId,
      route: route.route,
      accepted: route.accepted,
      providerId: route.effectiveProviderId,
      modelId: route.effectiveModelId,
      unifiedModelRouting: route.unifiedModelRouting,
    });
  }
}
