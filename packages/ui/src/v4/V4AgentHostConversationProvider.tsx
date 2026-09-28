import { useEffect, useState, type ReactNode } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { HarnessIdentityProvider } from "@/harness/HarnessIdentityContext.js";
import { remoteAgentServiceGeneration } from "@/lib/remoteAgentServiceGeneration.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import { createAgentHostConversationFacade } from "@/v4/agentHostConversationFacade.js";
import { createAgentHostConversationTransport } from "@/v4/agentHostConversationTransport.js";
import type { AgentHostConversationSelection } from "@/v4/agentHostConversationOwner.js";
import {
  agentHostConversationOwnerKey,
  isValidAgentHostConversationOwner,
} from "@/v4/agentHostConversationOwner.js";
import { SessionDataLayer } from "@/v4/sessionDataLayer.js";
import {
  createV4ConversationContextValue,
  V4ConversationContext,
  type V4ConversationContextValue,
} from "@/v4/V4ConversationContext.js";

type AgentHostConversationRouteState =
  | { readonly routeKey: string; readonly status: "checking" }
  | {
      readonly routeKey: string;
      readonly status: "unavailable";
      readonly reason: string;
    }
  | {
      readonly routeKey: string;
      readonly status: "ready";
      readonly services: IServiceAccessor;
      readonly value: V4ConversationContextValue;
    };

/** Mounts the existing V4 context over one verified, selected AgentHost owner. */
export function V4AgentHostConversationProvider({
  selection,
  isDesktop = false,
  children,
}: {
  selection: AgentHostConversationSelection;
  isDesktop?: boolean;
  children: ReactNode;
}): ReactNode {
  const workspacePath = selection.ownerRecord.workspacePath;
  const workspaceIdentity = selection.sessionSpec.execution.workspaceIdentity;
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    selection.remoteSessionId,
    selection.remoteSessionId ? workspaceIdentity : null,
  );
  const services = resolution.services;
  const nativeAgentService = services.zcodeAgentService;
  const agentHostService = services.agentHostService;
  const attachmentGeneration = remoteAgentServiceGeneration(nativeAgentService);
  const hostServiceGeneration = agentHostService
    ? remoteAgentServiceGeneration(agentHostService)
    : 0;
  const routeKey = JSON.stringify([
    agentHostConversationOwnerKey(selection),
    attachmentGeneration,
    hostServiceGeneration,
    resolution.connectionKind,
    resolution.remoteSessionId,
  ]);
  const [routeState, setRouteState] = useState<AgentHostConversationRouteState | null>(null);
  const { intl } = useZCodeIntl();

  useEffect(() => {
    let current = true;
    let layer: SessionDataLayer | null = null;
    let agentHostTransport: ReturnType<typeof createAgentHostConversationTransport> | null = null;
    const update = (state: AgentHostConversationRouteState) => {
      if (current) setRouteState(state);
    };
    const unavailable = (reason: string) => update({ routeKey, status: "unavailable", reason });

    if (!isValidAgentHostConversationOwner(selection)) {
      unavailable("agent-host-owner-locator-mismatch");
      return () => {
        current = false;
      };
    }
    if (!resolution.rpcReady) {
      update({ routeKey, status: "checking" });
      return () => {
        current = false;
      };
    }
    if (resolution.remoteSessionId !== selection.remoteSessionId) {
      unavailable("agent-host-attachment-scope-mismatch");
      return () => {
        current = false;
      };
    }
    if (!agentHostService) {
      unavailable("agent-host-capability-unavailable");
      return () => {
        current = false;
      };
    }

    update({ routeKey, status: "checking" });
    void agentHostService
      .getAvailability()
      .then((availability) => {
        if (!current) return;
        if (availability.target.id !== selection.sessionSpec.execution.targetId) {
          throw new Error("agent-host-target-scope-mismatch");
        }
        const nativeTransport = createAgentConversationTransport(nativeAgentService, {
          workspacePath,
          workspaceIdentity,
        });
        agentHostTransport = createAgentHostConversationTransport(agentHostService, {
          spec: selection.sessionSpec,
          clientMode: isDesktop ? "desktop-continuous" : "web-remote-replayable",
          runtimePolicy: "existing-only",
        });
        const transport = createAgentHostConversationFacade({
          native: nativeTransport,
          external: agentHostTransport,
          enabled: true,
          locateSession: (sessionId) =>
            sessionId === selection.sessionSpec.hostSessionId ? "external" : undefined,
        });
        layer = new SessionDataLayer({ transport });
        update({
          routeKey,
          status: "ready",
          services,
          value: createV4ConversationContextValue(transport, layer, "agent-host"),
        });
      })
      .catch((error: unknown) => {
        if (!current) return;
        unavailable(error instanceof Error ? error.message : "agent-host-route-unavailable");
      });

    return () => {
      current = false;
      layer?.dispose();
      agentHostTransport?.dispose();
    };
  }, [
    agentHostService,
    attachmentGeneration,
    isDesktop,
    nativeAgentService,
    resolution.remoteSessionId,
    resolution.rpcReady,
    routeKey,
    selection,
    services,
    workspaceIdentity,
    workspacePath,
  ]);

  const currentRoute = routeState?.routeKey === routeKey ? routeState : null;
  if (currentRoute?.status === "ready") {
    return (
      <HarnessIdentityProvider harnessId={selection.sessionSpec.harness.id}>
        <ServiceProvider services={currentRoute.services}>
          <V4ConversationContext.Provider value={currentRoute.value}>
            {children}
          </V4ConversationContext.Provider>
        </ServiceProvider>
      </HarnessIdentityProvider>
    );
  }

  const unavailable = currentRoute?.status === "unavailable";
  return (
    <div
      role="status"
      data-agent-host-conversation-route={unavailable ? "unavailable" : "checking"}
      data-agent-host-route-error={unavailable ? currentRoute.reason : undefined}
      className="flex h-full min-h-0 items-center justify-center px-4 text-ui-sm text-foreground-subtle"
    >
      {intl.formatMessage({
        id: unavailable
          ? "projectSidebar.externalConversationUnavailable"
          : "projectSidebar.externalConversationLoading",
      })}
    </div>
  );
}
