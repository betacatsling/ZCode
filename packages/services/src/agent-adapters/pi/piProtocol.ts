import type { ModelRequest, ModelStreamEvent } from "@zcode/contracts";
import type { CapturedHostModel } from "../../agent-host/modelBinding.js";
import type {
  AgentEvent,
  BackendBindingV2,
  BindingPlan,
  SessionSpecV2,
} from "@zcode/shared/agent-host";

export interface PiWorkerBoot {
  spec: SessionSpecV2;
  plan: BindingPlan;
  binding: BackendBindingV2;
  sessionDir: string;
  isolatedAgentDir: string;
  attach: boolean;
  sequence: number;
  pauseBeforeReadResolver?: boolean;
  enableNodeTestCrash?: boolean;
  model: {
    providerId: string;
    modelId: string;
    identity?: CapturedHostModel["identity"];
    displayName?: string;
    properties: { contextWindow: number };
    optionSpecs: { maxOutputTokens: { max: number } };
    options: { reasoningLevel: string };
  };
}

export type ToPiWorker =
  | {
      type: "prepare";
      commandId: string;
      turnId: string;
      runtimeEpoch: string;
      model: PiWorkerBoot["model"];
    }
  | { type: "send"; commandId: string; turnId: string; text: string }
  | { type: "cancel"; commandId: string; turnId: string }
  | {
      type: "resolve";
      commandId: string;
      turnId: string;
      interactionId: string;
      decision: "allow" | "deny";
    }
  | { type: "terminate"; commandId: string }
  | { type: "model.event"; requestId: string; event: ModelStreamEvent }
  | { type: "model.done"; requestId: string }
  | { type: "model.failure"; requestId: string }
  | { type: "model.cancel"; requestId: string }
  | { type: "broker.reply"; requestId: string; result?: unknown; error?: string }
  | { type: "bash.reply"; requestId: string; exitCode?: number | null; error?: string }
  | { type: "bash.data"; requestId: string; data: Uint8Array }
  | { type: "read.resume"; requestId: string }
  | { type: "nodeTest.crash" };

export type FromPiWorker =
  | { type: "ready"; backendSessionId: string }
  | { type: "event"; event: AgentEvent }
  | { type: "ack"; commandId: string; outcome: "completed" | "failed" }
  | {
      type: "model.request";
      requestId: string;
      turnId: string;
      request: Omit<ModelRequest, "abortSignal">;
    }
  | { type: "model.abort"; requestId: string }
  | { type: "fatal"; message: string }
  | {
      type: "broker.request";
      requestId: string;
      callId: string;
      action: "open" | "read" | "write" | "close";
      cwd?: string;
      leaf?: string;
      mode?: "read" | "edit" | "write";
      rootDev?: string;
      rootIno?: string;
      content?: string;
    }
  | {
      type: "bash.request";
      requestId: string;
      command: string;
      cwd: string;
      timeout?: number;
      env: NodeJS.ProcessEnv;
    }
  | { type: "bash.abort"; requestId: string }
  | { type: "read.pause"; requestId: string; alias: string };
