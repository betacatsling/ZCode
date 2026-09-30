import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { PiModelFailure, ToPiWorker } from "./piProtocol.js";

// Source-mode workers run as plain .ts without a resolver that maps relative `.js` to `.ts`
// (same reason main() imports piModelStream this way), so runtime-relative modules are loaded
// with an explicit extension; bundlers resolve both branches (inlined, or a chunk when
// splitting). Types stay exact via `typeof import(...)`.
const sourceMode = import.meta.url.endsWith(".ts");
const {
  boot,
  emit,
  modelProxy,
  modelStreams,
  pathWithinWorkspace,
  port,
  post,
  reply,
}: typeof import("./piWorkerRuntime.js") = await import(
  sourceMode ? "./piWorkerRuntime.ts" : "./piWorkerRuntime.js"
);
const {
  toProviderReconfigureFailure,
}: typeof import("../../agent-host/modelFailureClassification.js") = await import(
  sourceMode
    ? "../../agent-host/modelFailureClassification.ts"
    : "../../agent-host/modelFailureClassification.js"
);

let activeTurn: string | undefined;
let activeMessageId: string | undefined;
let lastAssistantOutcome: "success" | "failed" | "cancelled" = "success";
const approvals = new Map<
  string,
  { turnId: string; settle: (decision: "allow" | "deny") => void }
>();

async function main(): Promise<void> {
  if (boot.model.options.reasoningLevel !== "off" && boot.model.options.reasoningLevel !== "low")
    throw new Error("Pi host bridge supports only reasoningLevel=off or low");
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
    cwd: boot.spec.execution.worktreePath,
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
        SessionManager.findById(
          boot.spec.execution.worktreePath,
          boot.binding.backendSessionId,
          boot.sessionDir,
        ) ?? "",
        boot.sessionDir,
        boot.spec.execution.worktreePath,
      )
    : SessionManager.create(boot.spec.execution.worktreePath, boot.sessionDir);
  if (boot.attach && manager.getSessionId() !== boot.binding.backendSessionId)
    throw new Error("Pi native session missing or changed");
  const { session } = await createAgentSession({
    cwd: boot.spec.execution.worktreePath,
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
        if (message.stopReason === "error") {
          lastAssistantOutcome = "failed";
          const stage =
            message.errorMessage?.match(/ZCode model bridge failed at ([a-z-]+)/)?.[1] ?? "unknown";
          // "zcode-model-failure" = PI_MODEL_FAILURE_DIAGNOSTIC in piModelStream (dynamically imported here).
          const failure = toProviderReconfigureFailure(
            message.diagnostics?.find((entry) => entry.type === "zcode-model-failure")?.details as
              | PiModelFailure
              | undefined,
          );
          if (failure) {
            const status = failure.statusCode === undefined ? "" : ` (HTTP ${failure.statusCode})`;
            emit("session.error", {
              code: "provider-reconfigure-required",
              failure,
              message:
                `Provider ${failure.providerId} rejected the credentials for ${failure.modelId}${status}: ${failure.reason}. Reconfigure this Provider or explicitly choose another model; no other Provider was used.`.slice(
                  0,
                  1024,
                ),
            });
          } else {
            emit("session.error", {
              code: `pi-model-${stage}`,
              message: "Pi model request failed; inspect target-host diagnostics",
            });
          }
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
        if (raw.type === "model.failure" && raw.failure) state.failure = raw.failure;
      }
      state.waiting?.();
      state.waiting = undefined;
      return;
    }
    if (raw.type === "model.cancel") return;
    if (raw.type === "send") {
      if (activeTurn) {
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
          reply(raw.commandId, "completed");
        },
        () => {
          emit("session.error", { code: "pi-backend-failure", message: "Pi worker run failed" });
          emit("turn.finished", { turnId: raw.turnId, outcome: "failed" });
          activeTurn = undefined;
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
