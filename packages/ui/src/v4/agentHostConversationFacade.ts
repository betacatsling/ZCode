import { parseConversationTopic, type CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTransport } from "@/v4/transport.js";

/**
 * Routes only known, owner-tagged sessions. Unknown IDs never fall back to native;
 * disabling the new path returns the original transport object unchanged.
 */
export function createAgentHostConversationFacade(options: {
  native: ConversationTransport;
  external: ConversationTransport;
  enabled: boolean;
  locateSession: (sessionId: string) => "native" | "external" | undefined;
}): ConversationTransport {
  const { native, external, enabled, locateSession } = options;
  if (!enabled) return native;
  const subscriptions = new Map<string, ConversationTransport>();
  const bySession = (id: string): ConversationTransport => {
    const owner = locateSession(id);
    if (owner === "native") return native;
    if (owner === "external") return external;
    throw new Error(`unknown session owner: ${id}`);
  };
  const bySubscription = (id: string): ConversationTransport => {
    const transport = subscriptions.get(id);
    if (!transport) throw new Error(`unknown subscription: ${id}`);
    return transport;
  };
  const createTarget = (envelope: CommandEnvelope): ConversationTransport => {
    if (envelope.sessionId !== null) return bySession(envelope.sessionId);
    if (envelope.type !== "createSession") return native;
    const metadata = (envelope.payload as { agentHost?: { harnessId?: unknown } } | null)?.agentHost;
    if (metadata === undefined) return native;
    if (typeof metadata.harnessId !== "string" || !metadata.harnessId || metadata.harnessId === "zcode") {
      throw new Error("invalid external session create metadata");
    }
    return external;
  };
  return {
    async subscribe(params) {
      const sessionId = parseConversationTopic(params.topic);
      if (!sessionId) throw new Error("unsupported external topic");
      const transport = bySession(sessionId);
      const result = await transport.subscribe(params);
      if (subscriptions.has(result.ack.subscriptionId)) {
        await transport.unsubscribe(result.ack.subscriptionId);
        throw new Error("subscription ID collision across session owners");
      }
      subscriptions.set(result.ack.subscriptionId, transport);
      return result;
    },
    activate(id) { bySubscription(id).activate(id); },
    resync(params) { return bySubscription(params.subscriptionId).resync(params); },
    async unsubscribe(id) {
      const transport = bySubscription(id);
      await transport.unsubscribe(id);
      subscriptions.delete(id);
    },
    sendCommand(envelope) { return createTarget(envelope).sendCommand(envelope); },
    async queryCommands(params) {
      if (params.clock) return native.queryCommands(params);
      const nativeKeys = params.commands.filter((key) => key.sessionId === null || bySession(key.sessionId) === native);
      const externalKeys = params.commands.filter((key) => key.sessionId !== null && bySession(key.sessionId) === external);
      const [n, e] = await Promise.all([
        nativeKeys.length ? native.queryCommands({ commands: nativeKeys }) : undefined,
        externalKeys.length ? external.queryCommands({ commands: externalKeys }) : undefined,
      ]);
      const resultByKey = new Map([...n?.results ?? [], ...e?.results ?? []].map((item) => [JSON.stringify(item.key), item]));
      return { results: params.commands.map((key) => {
        const result = resultByKey.get(JSON.stringify(key));
        if (!result) throw new Error("command query owner omitted a result");
        return result;
      }) };
    },
    rowsRange(params) { return bySession(params.sessionId).rowsRange(params); },
    plans(params) { return bySession(params.sessionId).plans(params); },
    workflowRunEvents(params) { return bySession(params.sessionId).workflowRunEvents(params); },
    workflowRuns(params) { return bySession(params.sessionId).workflowRuns(params); },
    workflowRunArtifacts(params) { return bySession(params.sessionId).workflowRunArtifacts(params); },
    workflowRunArtifactData(params) { return bySession(params.sessionId).workflowRunArtifactData(params); },
    workflowRunArtifactRead(params) { return bySession(params.sessionId).workflowRunArtifactRead(params); },
    workflowRunWorkspace(params) { return bySession(params.sessionId).workflowRunWorkspace(params); },
    workflowRunNodeResult(params) { return bySession(params.sessionId).workflowRunNodeResult(params); },
    fileChanges(params) { return bySession(params.sessionId).fileChanges(params); },
    fileRewindPreview(params) { return bySession(params.sessionId).fileRewindPreview(params); },
    attachmentPut(params, upload) { return bySession(params.sessionId).attachmentPut(params, upload); },
    attachmentRead(params) { return bySession(params.sessionId).attachmentRead(params); },
    attachmentReadRange(params) { return bySession(params.sessionId).attachmentReadRange(params); },
    onFrame(listener) {
      const attach = (transport: ConversationTransport) => transport.onFrame((frame, context) => {
        const owner = subscriptions.get(frame.subscriptionId);
        if (owner === transport || (!owner && parseConversationTopic(frame.topic) && locateSession(parseConversationTopic(frame.topic)!) === (transport === native ? "native" : "external"))) {
          listener(frame, context);
        }
      });
      const offNative = attach(native);
      const offExternal = attach(external);
      return () => { offNative(); offExternal(); };
    },
    onAssemblyFault(listener) {
      const n = native.onAssemblyFault((fault) => { if (subscriptions.get(fault.subscriptionId) === native) listener(fault); });
      const e = external.onAssemblyFault((fault) => { if (subscriptions.get(fault.subscriptionId) === external) listener(fault); });
      return () => { n(); e(); };
    },
    onRuntimeRestart(listener) {
      const n = native.onRuntimeRestart(listener);
      const e = external.onRuntimeRestart(listener);
      return () => { n(); e(); };
    },
    onRuntimeLifecycle(listener) {
      const n = native.onRuntimeLifecycle?.(listener);
      const e = external.onRuntimeLifecycle?.(listener);
      return () => { n?.(); e?.(); };
    },
  };
}
