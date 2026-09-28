import type { IAgentHostService } from "../../../services/src/agent-host/serviceContract.js";

type AgentHostBrowserClient = Pick<
  IAgentHostService,
  | "getAvailability"
  | "onConversationFrame"
  | "createExternalSession"
  | "subscribeConversation"
  | "resyncConversation"
  | "unsubscribeConversation"
  | "conversationRowsRange"
  | "dispatch"
  | "snapshot"
  | "queryCommand"
>;

async function rpc<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`/__agent-host/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as { error?: string } & T;
  if (!response.ok) throw new Error(result.error ?? `agent-host-http-${response.status}`);
  return result;
}

/** Browser-side service port; the Vite proxy forwards to the real Node Host test driver. */
export function createProjectSidebarAgentHostBrowserClient(): AgentHostBrowserClient {
  return {
    getAvailability: () => rpc("getAvailability"),
    onConversationFrame(listener) {
      const source = new EventSource("/__agent-host/frames");
      source.onmessage = (event) => {
        try {
          listener(JSON.parse(event.data));
        } catch {
          source.close();
        }
      };
      return { dispose: () => source.close() };
    },
    createExternalSession: (request) => rpc("createExternalSession", { request }),
    subscribeConversation: (request) => rpc("subscribeConversation", { request }),
    resyncConversation: (request) => rpc("resyncConversation", { request }),
    unsubscribeConversation: (request) => rpc("unsubscribeConversation", { request }),
    conversationRowsRange: (request) => rpc("conversationRowsRange", { request }),
    dispatch: (spec, command) => rpc("dispatch", { spec, command }),
    snapshot: (spec) => rpc("snapshot", { spec }),
    queryCommand: (spec, commandId) => rpc("queryCommand", { spec, commandId }),
  };
}
