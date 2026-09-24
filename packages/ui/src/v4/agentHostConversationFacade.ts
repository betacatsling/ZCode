import {
  parseConversationTopic,
  type CommandEnvelope,
  type CommandQueryItem,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTransport } from "@/v4/transport.js";
import type { IAgentHostService } from "@zcode/services";
import {
  createAgentHostConversationTransport,
  type AgentHostConversationPort,
  type AgentHostConversationScope,
  type AgentHostConversationTransport,
  type HostSessionOwner,
} from "./agentHostConversationTransport.js";

// 编译期保持真实 Host 服务与 facade 端口可直接赋值，禁止装配时靠断言掩盖方法缺口。
const acceptHostPort = (host: IAgentHostService): AgentHostConversationPort => host;
void acceptHostPort;

export type ConversationOwner = "native" | "external";

/** Composition entry for the pane mount owner. The lookup must read native + Host persisted
 * ownership, including historical v1 records; it must never classify arbitrary IDs as native. */
export function createScopedAgentHostConversationFacade(options: {
  native: ConversationTransport;
  host: AgentHostConversationPort;
  scope: Omit<AgentHostConversationScope, "locateExternal">;
  locateOwner: (
    sessionId: string,
  ) => Promise<{ kind: "native" } | ({ kind: "external" } & HostSessionOwner) | undefined>;
  enabled: boolean;
  externalAdmissionEnabled: boolean;
}): { transport: ConversationTransport; dispose(): void } {
  if (!options.enabled) return { transport: options.native, dispose() {} };
  const external = createAgentHostConversationTransport(options.host, {
    ...options.scope,
    locateExternal: async (id) => {
      const owner = await options.locateOwner(id);
      return owner?.kind === "external"
        ? { spec: owner.spec, historyOnly: owner.historyOnly }
        : undefined;
    },
  });
  return {
    transport: createAgentHostConversationFacade({
      native: options.native,
      external,
      enabled: true,
      externalAdmissionEnabled: options.externalAdmissionEnabled,
      owners: { locateSession: async (id) => (await options.locateOwner(id))?.kind },
    }),
    dispose() {
      external.dispose();
    },
  };
}
/** Only a trusted persisted native/Host metadata index may implement this resolver. */
export interface ConversationOwnerResolver {
  locateSession(sessionId: string): Promise<ConversationOwner | undefined>;
}

/** Feature-off is the identical native object; unknown IDs never silently route to native. */
export function createAgentHostConversationFacade(options: {
  native: ConversationTransport;
  external: AgentHostConversationTransport;
  enabled: boolean;
  owners: ConversationOwnerResolver;
  /** Admission only: existing external records remain readable after this is disabled. */
  externalAdmissionEnabled?: boolean;
}): ConversationTransport {
  const { native, external, enabled, owners } = options;
  if (!enabled) return native;
  const subscriptions = new Map<string, ConversationTransport>();
  const bySession = async (id: string): Promise<ConversationTransport> => {
    const owner = await owners.locateSession(id);
    if (owner === "native") return native;
    if (owner === "external") return external;
    throw new Error(`unknown session owner: ${id}`);
  };
  const bySubscription = (id: string): ConversationTransport => {
    const transport = subscriptions.get(id);
    if (!transport) throw new Error(`unknown subscription: ${id}`);
    return transport;
  };
  const createTarget = async (envelope: CommandEnvelope): Promise<ConversationTransport> => {
    if (envelope.sessionId !== null) return bySession(envelope.sessionId);
    if (envelope.type !== "createSession") throw new Error("unknown null-session command owner");
    const metadata = (
      envelope.payload as { agentHost?: { spec?: { harness?: { id?: unknown } } } } | null
    )?.agentHost;
    if (metadata === undefined) return native;
    if (options.externalAdmissionEnabled === false)
      throw new Error("external session admission disabled");
    if (
      typeof metadata.spec?.harness?.id !== "string" ||
      !metadata.spec.harness.id ||
      metadata.spec.harness.id === "zcode"
    ) {
      throw new Error("invalid external session create metadata");
    }
    return external;
  };
  return {
    async subscribe(params) {
      const sessionId = parseConversationTopic(params.topic);
      if (!sessionId) throw new Error("unsupported conversation topic");
      const transport = await bySession(sessionId);
      const result = await transport.subscribe(params);
      if (subscriptions.has(result.ack.subscriptionId)) {
        await transport.unsubscribe(result.ack.subscriptionId);
        throw new Error("subscription ID collision across session owners");
      }
      subscriptions.set(result.ack.subscriptionId, transport);
      return result;
    },
    activate(id) {
      bySubscription(id).activate(id);
    },
    resync(params) {
      return bySubscription(params.subscriptionId).resync(params);
    },
    async unsubscribe(id) {
      const transport = bySubscription(id);
      await transport.unsubscribe(id);
      subscriptions.delete(id);
    },
    async sendCommand(envelope) {
      return (await createTarget(envelope)).sendCommand(envelope);
    },
    async queryCommands(params) {
      // Null-session IDs have TWO durable create buckets. An in-memory intent map cannot
      // prove ownership after a lost ACK or a process restart. Clock is native-only.
      const nullKeys = params.commands.filter((key) => key.sessionId === null);
      const nativeKeys = [...nullKeys];
      const externalKeys = [...nullKeys];
      for (const key of params.commands) {
        if (key.sessionId === null) continue;
        ((await bySession(key.sessionId)) === native ? nativeKeys : externalKeys).push(key);
      }
      const [n, e] = await Promise.all([
        nativeKeys.length
          ? native.queryCommands({
              commands: nativeKeys,
              ...(params.clock ? { clock: true as const } : {}),
            })
          : undefined,
        externalKeys.length ? external.queryCommands({ commands: externalKeys }) : undefined,
      ]);
      const find = (
        items: readonly CommandQueryItem[] | undefined,
        key: { sessionId: string | null; commandId: string },
      ) =>
        items?.find(
          (item) => item.key.sessionId === key.sessionId && item.key.commandId === key.commandId,
        )?.result;
      return {
        results: params.commands.map((key) => {
          const nativeResult = find(n?.results, key);
          const externalResult = find(e?.results, key);
          if (
            key.sessionId === null &&
            nativeResult !== undefined &&
            externalResult !== undefined &&
            nativeResult !== "unknown" &&
            externalResult !== "unknown"
          )
            throw new Error(`ambiguous create command owner: ${key.commandId}`);
          const result =
            nativeResult !== "unknown" && nativeResult !== undefined
              ? nativeResult
              : (externalResult ?? nativeResult);
          if (result === undefined) throw new Error("command query owner omitted a result");
          return { key, result };
        }),
        ...(n?.clock ? { clock: n.clock } : {}),
      };
    },
    async rowsRange(params) {
      return (await bySession(params.sessionId)).rowsRange(params);
    },
    async plans(params) {
      return (await bySession(params.sessionId)).plans(params);
    },
    async workflowRunEvents(params) {
      return (await bySession(params.sessionId)).workflowRunEvents(params);
    },
    async workflowRuns(params) {
      return (await bySession(params.sessionId)).workflowRuns(params);
    },
    async workflowRunArtifacts(params) {
      return (await bySession(params.sessionId)).workflowRunArtifacts(params);
    },
    async workflowRunArtifactData(params) {
      return (await bySession(params.sessionId)).workflowRunArtifactData(params);
    },
    async workflowRunArtifactRead(params) {
      return (await bySession(params.sessionId)).workflowRunArtifactRead(params);
    },
    async workflowRunWorkspace(params) {
      return (await bySession(params.sessionId)).workflowRunWorkspace(params);
    },
    async workflowRunNodeResult(params) {
      return (await bySession(params.sessionId)).workflowRunNodeResult(params);
    },
    async fileChanges(params) {
      return (await bySession(params.sessionId)).fileChanges(params);
    },
    async fileRewindPreview(params) {
      return (await bySession(params.sessionId)).fileRewindPreview(params);
    },
    async attachmentPut(params, upload) {
      return (await bySession(params.sessionId)).attachmentPut(params, upload);
    },
    async attachmentRead(params) {
      return (await bySession(params.sessionId)).attachmentRead(params);
    },
    async attachmentReadRange(params) {
      return (await bySession(params.sessionId)).attachmentReadRange(params);
    },
    onFrame(listener) {
      const attach = (transport: ConversationTransport) =>
        transport.onFrame((frame, context) => {
          if (subscriptions.get(frame.subscriptionId) === transport) listener(frame, context);
        });
      const n = attach(native);
      const e = attach(external);
      return () => {
        n();
        e();
      };
    },
    onAssemblyFault(listener) {
      const n = native.onAssemblyFault((fault) => {
        if (subscriptions.get(fault.subscriptionId) === native) listener(fault);
      });
      const e = external.onAssemblyFault((fault) => {
        if (subscriptions.get(fault.subscriptionId) === external) listener(fault);
      });
      return () => {
        n();
        e();
      };
    },
    onRuntimeRestart(listener) {
      const n = native.onRuntimeRestart(listener);
      const e = external.onRuntimeRestart(listener);
      return () => {
        n();
        e();
      };
    },
    onRuntimeLifecycle(listener) {
      const n = native.onRuntimeLifecycle?.(listener);
      const e = external.onRuntimeLifecycle?.(listener);
      return () => {
        n?.();
        e?.();
      };
    },
  };
}
