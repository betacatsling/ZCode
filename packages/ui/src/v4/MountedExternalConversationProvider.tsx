import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type {
  CommandEnvelope,
  V4AttachmentPutParams,
  V4ConversationFileChangesParams,
  V4ConversationFileRewindPreviewParams,
  V4ConversationWorkflowRunEventsParams,
  V4ConversationWorkflowRunsParams,
  V4ConversationWorkflowRunArtifactsParams,
  V4ConversationWorkflowRunArtifactDataParams,
  V4ConversationWorkflowRunArtifactReadParams,
  V4ConversationWorkflowRunWorkspaceParams,
  V4ConversationWorkflowRunNodeResultParams,
} from "@zcode/shared/zcode-protocol-v4";
import { ServiceProvider, useServices } from "@/hooks/useServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import { createScopedAgentHostConversationFacade } from "@/v4/agentHostConversationFacade.js";
import {
  matchesMountedSessionOwner,
  sameMountedExternalOwner,
  type MountedSessionOwner,
} from "@/v4/mountedSessionOwner.js";
import { SessionDataLayer } from "@/v4/sessionDataLayer.js";
import {
  V4ConversationContext,
  type V4ConversationContextValue,
} from "@/v4/V4ConversationContext.js";
import type { ConversationTransport, ConversationAttachmentReadParams } from "@/v4/transport.js";
import type { AttachmentUploadOptions } from "@/v4/attachmentUploadTransaction.js";

export function MountedExternalConversationProvider({
  owner,
  children,
}: {
  owner: Extract<MountedSessionOwner, { kind: "external" }>;
  children: ReactNode;
}) {
  const services = useServices();
  const platform = usePlatform();
  const { locale } = useZCodeIntl();
  const labels =
    locale === "zh-CN"
      ? {
          missing: "外部会话所有者或服务不可用",
          changed: "外部会话所有者已变更",
          offline: "无法验证外部会话所有者",
          loading: "正在加载会话…",
        }
      : {
          missing: "External session owner or service unavailable",
          changed: "External session owner changed",
          offline: "External session owner unavailable",
          loading: "Loading session…",
        };
  const hierarchy = services.workspaceHierarchyService;
  const host = services.agentHostService;
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { scope, spec } = owner;

  useEffect(() => {
    let active = true;
    setVerified(false);
    setError(null);
    if (
      !hierarchy ||
      !host ||
      !matchesMountedSessionOwner(owner, spec.hostSessionId, {
        workspacePath: scope.workspacePath,
        workspaceIdentity: scope.workspaceIdentity,
        remoteSessionId: scope.remoteSessionId,
      })
    ) {
      setError(labels.missing);
      return () => {
        active = false;
      };
    }
    void hierarchy
      .resolveOwner({
        targetId: scope.targetId,
        workspaceId: scope.workspaceId,
        sessionId: spec.hostSessionId,
      })
      .then((current) => {
        if (!active) return;
        if (current?.kind !== "external" || !sameMountedExternalOwner(current, owner)) {
          setError(labels.changed);
        } else setVerified(true);
      })
      .catch(() => {
        if (active) setError(labels.offline);
      });
    return () => {
      active = false;
    };
  }, [hierarchy, host, owner, scope, spec, locale]);

  if (error)
    return (
      <div role="alert" className="p-4 text-ui-sm text-destructive">
        {error}
      </div>
    );
  if (!verified || !hierarchy || !host)
    return (
      <div role="status" className="p-4 text-ui-sm text-foreground-subtle">
        {labels.loading}
      </div>
    );
  return (
    <ReadyMountedExternalConversationProvider
      owner={owner}
      services={services}
      hierarchy={hierarchy}
      host={host}
      platform={platform}
    >
      {children}
    </ReadyMountedExternalConversationProvider>
  );
}

function ReadyMountedExternalConversationProvider({
  owner,
  services,
  hierarchy,
  host,
  platform,
  children,
}: {
  owner: Extract<MountedSessionOwner, { kind: "external" }>;
  services: IServiceAccessor;
  hierarchy: NonNullable<IServiceAccessor["workspaceHierarchyService"]>;
  host: NonNullable<IServiceAccessor["agentHostService"]>;
  platform: ReturnType<typeof usePlatform>;
  children: ReactNode;
}) {
  const { scope } = owner;
  const bundle = useMemo(() => {
    const native = createAgentConversationTransport(services.zcodeAgentService, {
      workspacePath: scope.workspacePath,
      workspaceIdentity: scope.workspaceIdentity,
      ...(scope.remoteSessionId
        ? {}
        : platform.createLocalMediaPreviewUrl
          ? { createLocalMediaPreviewUrl: platform.createLocalMediaPreviewUrl }
          : {}),
    });
    // Bug 原因：按路径/未知 ID 退回 native 会把外部 session ID 发往 ZCode CLI。
    // facade 必须先于 SessionDataLayer 建立，并且每次订阅/命令都查持久 owner。
    const facade = createScopedAgentHostConversationFacade({
      native,
      host,
      scope: {
        targetId: scope.targetId,
        workspaceId: scope.workspaceId,
        workspaceIdentity: scope.workspaceIdentity,
        worktreePath: scope.workspacePath,
      },
      enabled: true,
      externalAdmissionEnabled: false,
      locateOwner: async (sessionId) => {
        const current = await hierarchy.resolveOwner({
          targetId: scope.targetId,
          workspaceId: scope.workspaceId,
          sessionId,
        });
        if (
          !current ||
          !matchesMountedSessionOwner(current, sessionId, {
            workspacePath: scope.workspacePath,
            workspaceIdentity: scope.workspaceIdentity,
            remoteSessionId: scope.remoteSessionId,
          })
        )
          return undefined;
        return current.kind === "native"
          ? { kind: "native" as const }
          : { kind: "external" as const, spec: current.spec, historyOnly: current.historyOnly };
      },
    });
    const transport = facade.transport;
    const layer = new SessionDataLayer({ transport });
    return {
      layer,
      facade,
      value: {
        layer,
        sendCommand: (envelope: CommandEnvelope) => transport.sendCommand(envelope),
        fileChanges: (params: V4ConversationFileChangesParams) => transport.fileChanges(params),
        fileRewindPreview: (params: V4ConversationFileRewindPreviewParams) =>
          transport.fileRewindPreview(params),
        workflowRunEvents: (params: V4ConversationWorkflowRunEventsParams) =>
          transport.workflowRunEvents(params),
        workflowRuns: (params: V4ConversationWorkflowRunsParams) => transport.workflowRuns(params),
        workflowRunArtifacts: (params: V4ConversationWorkflowRunArtifactsParams) =>
          transport.workflowRunArtifacts(params),
        workflowRunArtifactData: (params: V4ConversationWorkflowRunArtifactDataParams) =>
          transport.workflowRunArtifactData(params),
        workflowRunArtifactRead: (params: V4ConversationWorkflowRunArtifactReadParams) =>
          transport.workflowRunArtifactRead(params),
        workflowRunWorkspace: (params: V4ConversationWorkflowRunWorkspaceParams) =>
          transport.workflowRunWorkspace(params),
        workflowRunNodeResult: (params: V4ConversationWorkflowRunNodeResultParams) =>
          transport.workflowRunNodeResult(params),
        attachmentPut: (params: V4AttachmentPutParams, options?: AttachmentUploadOptions) =>
          transport.attachmentPut(params, options),
        attachmentRead: (params: ConversationAttachmentReadParams) =>
          transport.attachmentRead(params),
        attachmentReadRange: (
          params: Parameters<ConversationTransport["attachmentReadRange"]>[0],
        ) => transport.attachmentReadRange(params),
        onRuntimeRestart: (listener: () => void) => transport.onRuntimeRestart(listener),
        onRuntimeLifecycle: (listener: (state: "available" | "unavailable") => void) =>
          transport.onRuntimeLifecycle?.(listener) ?? (() => {}),
      } satisfies V4ConversationContextValue,
    };
  }, [services.zcodeAgentService, hierarchy, host, platform.createLocalMediaPreviewUrl, scope]);
  useEffect(
    () => () => {
      bundle.layer.dispose();
      bundle.facade.dispose();
    },
    [bundle],
  );
  return (
    <ServiceProvider services={services}>
      <V4ConversationContext.Provider value={bundle.value}>
        {children}
      </V4ConversationContext.Provider>
    </ServiceProvider>
  );
}
