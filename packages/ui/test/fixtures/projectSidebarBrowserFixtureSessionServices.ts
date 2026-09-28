import type { IServiceAccessor } from "@zcode/services";
import type { SidebarBrowserFixtureState } from "./projectSidebarBrowserFixtureData.js";

function noEventSubscription() {
  return { dispose() {} };
}

const noEvent = Object.assign(() => noEventSubscription(), { dispose() {} });

function recordNativeServiceCall(
  state: SidebarBrowserFixtureState,
  service: string,
  method: string,
  args: readonly unknown[],
): void {
  const sessionId = args.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    const nestedCommand = record.command;
    if (typeof record.sessionId === "string") return [record.sessionId];
    if (nestedCommand && typeof nestedCommand === "object") {
      const commandSessionId = (nestedCommand as Record<string, unknown>).sessionId;
      if (typeof commandSessionId === "string") return [commandSessionId];
    }
    return [];
  })[0];
  state.nativeServiceCalls.push({ service, method, ...(sessionId ? { sessionId } : {}) });
}

/** Fill unrelated shell services with stable ports while tracking all native session IDs. */
export function createProjectSidebarBrowserServiceAccessor(
  state: SidebarBrowserFixtureState,
  knownServices: Record<string, unknown>,
): IServiceAccessor {
  const nativeAgentMethods = new Map<string, unknown>();
  const zcodeAgentService = new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_target, property) {
      const method = String(property);
      const cached = nativeAgentMethods.get(method);
      if (cached) return cached;
      let value: unknown;
      if (method === "onDynamicConversationFrame" || method === "onDynamicLocalTtftFacts") {
        value = () => noEvent;
      } else if (method === "onAgentRuntimeRestarted" || method === "onAgentRuntimeLifecycle") {
        value = noEvent;
      } else if (method.startsWith("on")) {
        value = noEvent;
      } else {
        value = (...args: readonly unknown[]) => {
          recordNativeServiceCall(state, "zcodeAgentService", method, args);
          return Promise.reject(new Error(`unexpected-native-agent-api:${method}`));
        };
      }
      nativeAgentMethods.set(method, value);
      return value;
    },
  });

  const taskMethods = new Map<string, unknown>();
  const zcodeTaskService = knownServices.zcodeTaskService as Record<string, unknown>;
  const trackedTaskService = new Proxy(zcodeTaskService, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      const method = String(property);
      const cached = taskMethods.get(method);
      if (cached) return cached;
      const handler = (...args: readonly unknown[]) => {
        recordNativeServiceCall(state, "zcodeTaskService", method, args);
        return Promise.reject(new Error(`unexpected-native-task-api:${method}`));
      };
      taskMethods.set(method, handler);
      return handler;
    },
  });

  const emptyServices = new Map<string, object>();
  const emptyService = (service: string) => {
    const existing = emptyServices.get(service);
    if (existing) return existing;
    const methods = new Map<string, unknown>();
    const created = new Proxy(Object.create(null) as Record<string, unknown>, {
      get(_target, property) {
        const method = String(property);
        if (method.startsWith("on")) return noEvent;
        const cached = methods.get(method);
        if (cached) return cached;
        const handler =
          service === "systemService" && method === "info"
            ? async () => ({ homedir: "/tmp" })
            : (...args: readonly unknown[]) => {
                recordNativeServiceCall(state, service, method, args);
                return Promise.resolve({});
              };
        methods.set(method, handler);
        return handler;
      },
    });
    emptyServices.set(service, created);
    return created;
  };

  const services = {
    ...knownServices,
    zcodeTaskService: trackedTaskService,
    zcodeAgentService,
    modelSelectionService: {
      onDidChange: noEvent,
      async getView() {
        return { revision: 0, providers: [] };
      },
    },
    providerSettingsService: {
      onDidChange: noEvent,
      async getView() {
        return { revision: 0, providers: [] };
      },
    },
  };
  return new Proxy(services, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      return emptyService(String(property));
    },
  }) as unknown as IServiceAccessor;
}
