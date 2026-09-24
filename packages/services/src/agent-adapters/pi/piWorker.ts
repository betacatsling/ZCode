import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentEvent } from "@zcode/shared/agent-host";
import type { Model, ModelRequest, ModelStreamEvent } from "@zcode/contracts";
import type { FromPiWorker, PiWorkerBoot, ToPiWorker } from "./piProtocol.js";

const boot = workerData as PiWorkerBoot;
if (!parentPort) throw new Error("Pi worker must have a parent host");
const port = parentPort;
let sequence = boot.sequence;
let activeTurn: string | undefined;
let preparedTurn: string | undefined;
let cwd: string;
let activeMessageId: string | undefined;
let lastAssistantOutcome: "success" | "failed" | "cancelled" = "success";
const approvals = new Map<
  string,
  { turnId: string; settle: (decision: "allow" | "deny") => void }
>();
const modelStreams = new Map<
  string,
  {
    values: ModelStreamEvent[];
    waiting?: () => void;
    done: boolean;
    failed: boolean;
  }
>();

function post(value: FromPiWorker): void {
  port.postMessage(value);
}
function emit(kind: AgentEvent["kind"], payload: Record<string, unknown>): void {
  const event = {
    hostSessionId: boot.spec.hostSessionId,
    runtimeEpoch: boot.binding.runtimeEpoch,
    sequence: ++sequence,
    eventId: randomUUID(),
    at: Date.now(),
    kind,
    ...payload,
  } as AgentEvent;
  post({ type: "event", event });
}
function reply(commandId: string, outcome: "completed" | "failed"): void {
  post({ type: "ack", commandId, outcome });
}

function modelProxy(): Model {
  return {
    ...boot.model,
    async *streamText(request: ModelRequest) {
      if (!activeTurn || activeTurn !== preparedTurn)
        throw new Error("model request outside prepared Pi turn");
      const requestId = randomUUID();
      const state = {
        values: [] as ModelStreamEvent[],
        waiting: undefined as (() => void) | undefined,
        done: false,
        failed: false,
      };
      modelStreams.set(requestId, state);
      const onAbort = () => post({ type: "model.abort", requestId });
      request.abortSignal?.addEventListener("abort", onAbort, { once: true });
      if (request.abortSignal?.aborted) onAbort();
      try {
        const { abortSignal: _signal, ...serializable } = request;
        post({ type: "model.request", requestId, turnId: activeTurn, request: serializable });
        while (!state.done || state.values.length) {
          if (!state.values.length) {
            await new Promise<void>((wake) => {
              state.waiting = wake;
            });
            continue;
          }
          yield state.values.shift()!;
        }
        if (state.failed) throw new Error("ZCode model executor failed");
      } finally {
        request.abortSignal?.removeEventListener("abort", onAbort);
        modelStreams.delete(requestId);
      }
    },
  } as unknown as Model;
}

async function pathWithinWorkspace(raw: unknown, allowMissing: boolean): Promise<boolean> {
  if (typeof raw !== "string" || !raw || raw.includes("\0")) return false;
  const root = await realpath(boot.spec.execution.worktreePath);
  const path = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  const resolved = await realpath(path).catch(async () =>
    allowMissing ? resolve(await realpath(dirname(path)), path.split("/").at(-1)!) : "",
  );
  const rel = relative(root, resolved);
  return !!resolved && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

async function main(): Promise<void> {
  if (boot.model.options.reasoningLevel !== "off")
    throw new Error("Pi host bridge currently certifies only reasoningLevel=off");
  const root = await realpath(boot.spec.execution.worktreePath);
  cwd = await realpath(resolve(root, boot.spec.execution.cwdRelativeToWorktree));
  const subdir = relative(root, cwd);
  if (subdir === ".." || subdir.startsWith("../") || isAbsolute(subdir))
    throw new Error("Pi cwd escapes worktree");
  const { createPiHostProvider } = await import(
    import.meta.url.endsWith(".ts") ? "./piModelStream.ts" : "./piModelStream.js"
  );
  const modelRuntime = await ModelRuntime.create({
    authPath: join(boot.isolatedAgentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(boot.isolatedAgentDir, "models-store.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(createPiHostProvider(modelProxy()));
  const modelId = `${boot.model.providerId}/${boot.model.modelId}`;
  const model = modelRuntime.getModel("zcode-host", modelId);
  if (!model) throw new Error("Pi SDK failed to register the ZCode host provider");
  const settings = SettingsManager.inMemory({ defaultThinkingLevel: "off" });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: boot.isolatedAgentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      (pi) => {
        pi.on("tool_call", async (call, ctx) => {
          if (!activeTurn) return { block: true, reason: "No active host turn" };
          if (!(["read", "write", "edit", "bash"] as string[]).includes(call.toolName))
            return { block: true, reason: "Uncertified tool" };
          if (
            call.toolName !== "bash" &&
            !(await pathWithinWorkspace(
              (call.input as { path?: unknown }).path,
              call.toolName === "write",
            ))
          ) {
            return { block: true, reason: "Tool path outside approved worktree" };
          }
          if (call.toolName === "read") return undefined;
          const summary =
            call.toolName === "bash"
              ? `Run Pi bash command: ${String((call.input as { command?: unknown }).command ?? "").slice(0, 512)}`
              : `Allow Pi ${call.toolName} in this worktree?`;
          if (
            summary.length > 700 ||
            (call.toolName === "bash" &&
              String((call.input as { command?: unknown }).command ?? "").length > 512)
          ) {
            return { block: true, reason: "Command too long for the approval preview" };
          }
          const decision = await new Promise<"allow" | "deny">((settle) => {
            approvals.set(call.toolCallId, { turnId: activeTurn!, settle });
            emit("interaction.requested", {
              turnId: activeTurn,
              interactionId: call.toolCallId,
              toolCallId: call.toolCallId,
              summary,
            });
            ctx.signal?.addEventListener(
              "abort",
              () => {
                if (approvals.delete(call.toolCallId)) {
                  emit("interaction.resolved", {
                    turnId: activeTurn,
                    interactionId: call.toolCallId,
                    decision: "deny",
                  });
                  settle("deny");
                }
              },
              { once: true },
            );
          });
          return decision === "allow"
            ? undefined
            : { block: true, reason: "User denied the tool before execution" };
        });
      },
    ],
  });
  await loader.reload();
  const manager = boot.attach
    ? SessionManager.open(
        SessionManager.findById(cwd, boot.binding.backendSessionId, boot.sessionDir) ?? "",
        boot.sessionDir,
        cwd,
      )
    : SessionManager.create(cwd, boot.sessionDir);
  if (boot.attach && manager.getSessionId() !== boot.binding.backendSessionId)
    throw new Error("Pi native session missing or changed");
  const { session } = await createAgentSession({
    cwd,
    agentDir: boot.isolatedAgentDir,
    sessionManager: manager,
    resourceLoader: loader,
    settingsManager: settings,
    modelRuntime,
    model,
  });
  session.setThinkingLevel("off");
  session.subscribe((event: AgentSessionEvent) => {
    if (!activeTurn) return;
    if (event.type === "message_start") activeMessageId = randomUUID();
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      activeMessageId ??= randomUUID();
      emit("text.delta", {
        turnId: activeTurn,
        messageId: activeMessageId,
        text: event.assistantMessageEvent.delta,
      });
    }
    if (event.type === "message_end") {
      const message = event.message;
      if (message.role !== "user" && message.role !== "assistant") {
        activeMessageId = undefined;
        return;
      }
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("\n");
      if (text) {
        emit("message.finished", {
          turnId: activeTurn,
          messageId: activeMessageId ?? randomUUID(),
          role: message.role,
          text,
        });
      }
      if (message.role === "assistant") {
        emit("usage.reported", {
          turnId: activeTurn,
          inputTokens: message.usage.input,
          outputTokens: message.usage.output,
        });
        // 修复：取消后 SDK 可能再发 error 终帧；已取消的轮次不能被迟到的失败覆盖。
        if (message.stopReason === "error" && lastAssistantOutcome !== "cancelled") {
          lastAssistantOutcome = "failed";
          const stage =
            message.errorMessage?.match(/ZCode model bridge failed at ([a-z-]+)/)?.[1] ?? "unknown";
          emit("session.error", {
            code: `pi-model-${stage}`,
            message: "Pi model request failed; inspect target-host diagnostics",
          });
        }
        if (message.stopReason === "aborted") lastAssistantOutcome = "cancelled";
      }
      activeMessageId = undefined;
    }
    if (event.type === "tool_execution_start") {
      emit("tool.started", {
        turnId: activeTurn,
        toolCallId: event.toolCallId,
        name: event.toolName,
      });
    }
    if (event.type === "tool_execution_end") {
      const outputText =
        event.result?.content
          ?.filter((part: { type: string }) => part.type === "text")
          .map((part: { text: string }) => part.text)
          .join("\n") ?? "";
      emit("tool.finished", {
        turnId: activeTurn,
        toolCallId: event.toolCallId,
        name: event.toolName,
        outcome: event.isError ? "error" : "success",
        outputText: outputText.slice(0, 4096),
      });
    }
  });
  post({ type: "ready", backendSessionId: manager.getSessionId() });
  port.on("message", (raw: ToPiWorker) => {
    if (raw.type === "model.event" || raw.type === "model.done" || raw.type === "model.failure") {
      const state = modelStreams.get(raw.requestId);
      if (!state) return;
      if (raw.type === "model.event") state.values.push(raw.event);
      else {
        state.done = true;
        state.failed = raw.type === "model.failure";
      }
      state.waiting?.();
      state.waiting = undefined;
      return;
    }
    if (raw.type === "model.cancel") return;
    if (raw.type === "prepare") {
      if (
        activeTurn ||
        preparedTurn ||
        raw.runtimeEpoch !== boot.binding.runtimeEpoch ||
        raw.model.providerId !== boot.model.providerId ||
        raw.model.modelId !== boot.model.modelId ||
        raw.model.options.reasoningLevel !== "off"
      ) {
        reply(raw.commandId, "failed");
        return;
      }
      modelRuntime.registerNativeProvider(
        createPiHostProvider({ ...modelProxy(), ...raw.model } as Model),
      );
      const selected = modelRuntime.getModel("zcode-host", modelId);
      if (!selected) {
        reply(raw.commandId, "failed");
        return;
      }
      void session.setModel(selected).then(
        () => {
          preparedTurn = raw.turnId;
          reply(raw.commandId, "completed");
        },
        () => reply(raw.commandId, "failed"),
      );
    } else if (raw.type === "send") {
      if (activeTurn || preparedTurn !== raw.turnId) {
        reply(raw.commandId, "failed");
        return;
      }
      activeTurn = raw.turnId;
      lastAssistantOutcome = "success";
      emit("turn.started", { turnId: raw.turnId });
      void session.prompt(raw.text).then(
        () => {
          emit("turn.finished", { turnId: raw.turnId, outcome: lastAssistantOutcome });
          activeTurn = undefined;
          preparedTurn = undefined;
          reply(raw.commandId, "completed");
        },
        () => {
          emit("session.error", { code: "pi-backend-failure", message: "Pi worker run failed" });
          emit("turn.finished", { turnId: raw.turnId, outcome: "failed" });
          activeTurn = undefined;
          preparedTurn = undefined;
          reply(raw.commandId, "failed");
        },
      );
    } else if (raw.type === "cancel") {
      if (raw.turnId !== activeTurn) {
        reply(raw.commandId, "failed");
        return;
      }
      lastAssistantOutcome = "cancelled";
      for (const [id, pending] of approvals) {
        approvals.delete(id);
        emit("interaction.resolved", { turnId: raw.turnId, interactionId: id, decision: "deny" });
        pending.settle("deny");
      }
      void session.abort().then(
        () => reply(raw.commandId, "completed"),
        () => reply(raw.commandId, "failed"),
      );
    } else if (raw.type === "resolve") {
      const pending = approvals.get(raw.interactionId);
      if (!pending || pending.turnId !== raw.turnId || activeTurn !== raw.turnId) {
        reply(raw.commandId, "failed");
        return;
      }
      approvals.delete(raw.interactionId);
      emit("interaction.resolved", {
        turnId: raw.turnId,
        interactionId: raw.interactionId,
        decision: raw.decision,
      });
      pending.settle(raw.decision);
      reply(raw.commandId, "completed");
    } else if (raw.type === "terminate") {
      for (const pending of approvals.values()) pending.settle("deny");
      approvals.clear();
      void session.abort().then(
        () => {
          session.dispose();
          reply(raw.commandId, "completed");
        },
        () => reply(raw.commandId, "failed"),
      );
    }
  });
}

void main().catch(() => {
  post({
    type: "fatal",
    message: "Pi worker failed to initialize; inspect isolated target diagnostics",
  });
  process.exitCode = 1;
});
