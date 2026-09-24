import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentCommand,
  AgentCommandReceipt,
  HarnessCapabilitiesV2,
} from "@zcode/shared/agent-host";
import { useServices } from "@/hooks/useServices.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { readV4ComposerDraft, persistV4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import {
  externalCommandMarkerKey,
  readExternalCommandMarker,
  writeExternalCommandMarker,
  clearExternalCommandMarker,
} from "@/v4/externalCommandMarker.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { sameMountedExternalOwner, type MountedSessionOwner } from "@/v4/mountedSessionOwner.js";
import type { SidebarIconAsset } from "@/agent-host/harnessAssetResolver.js";

/** Renderer overlay: durable command ID, unsent draft and view lease. Host owns all execution. */
export function useExternalSessionController({
  owner,
  readOnly,
  storageUnavailable,
}: {
  owner: Extract<MountedSessionOwner, { kind: "external" }>;
  readOnly?: boolean;
  storageUnavailable: string;
}) {
  const { layer } = useV4Conversation();
  const { workspaceHierarchyService: hierarchy, agentHostService: host } = useServices();
  const { spec, scope, historyOnly } = owner;
  const [lease, setLease] = useState<SessionLease | null>(null);
  const [capabilities, setCapabilities] = useState<HarnessCapabilitiesV2 | null>(null);
  const [catalog, setCatalog] = useState<
    Awaited<ReturnType<NonNullable<typeof hierarchy>["listHarnesses"]>>
  >([]);
  const [iconAssets, setIconAssets] = useState<ReadonlyMap<string, SidebarIconAsset>>(new Map());
  // Bug 原因：pane 切换会卸载视图；草稿必须以 target/worktree/Host 会话 ID
  // 复用已有 per-session 草稿存储，而不能落入原生 task DB 或只存组件实例。
  const draftScopeId = `agent-host:${scope.targetId}:${scope.workspaceId}:${spec.hostSessionId}`;
  const [draft, setDraft] = useState(
    () =>
      readV4ComposerDraft(scope.workspacePath, scope.workspaceIdentity, draftScopeId)?.text ?? "",
  );
  const latestDraftRef = useRef(draft);
  const markerKey = externalCommandMarkerKey({
    targetId: scope.targetId,
    workspaceId: scope.workspaceId,
    sessionId: spec.hostSessionId,
  });
  const [pendingMarker, setPendingMarker] = useState(() => readExternalCommandMarker(markerKey));
  const inFlightRef = useRef(false);
  const pendingMarkerRef = useRef(pendingMarker);
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateDraft = useCallback(
    (text: string) => {
      latestDraftRef.current = text;
      setDraft(text);
      persistV4ComposerDraft(scope.workspacePath, scope.workspaceIdentity, draftScopeId, { text });
    },
    [scope.workspacePath, scope.workspaceIdentity, draftScopeId],
  );

  useEffect(() => {
    const next = layer.acquire(spec.hostSessionId);
    setLease(next);
    return () => {
      next.release();
      setLease(null);
    };
  }, [layer, spec.hostSessionId]);
  const state = useConversationProjection(lease);
  const snapshot = state.snapshot;

  useEffect(() => {
    let active = true;
    setCapabilities(null);
    if (!hierarchy || !host) {
      setError("Host or hierarchy unavailable");
      return () => {
        active = false;
      };
    }
    void Promise.all([hierarchy.capabilities(owner), hierarchy.listHarnesses(scope.workspaceId)])
      .then(async ([caps, entries]) => {
        const assets = new Map<string, SidebarIconAsset>();
        const assetIds = entries.flatMap((entry) =>
          [entry.manifest.icon?.light, entry.manifest.icon?.dark].filter((id): id is string =>
            Boolean(id),
          ),
        );
        await Promise.all(
          assetIds.map(async (id) => {
            const asset = await hierarchy.asset(id);
            if (asset) assets.set(id, asset);
          }),
        );
        if (active) {
          setCapabilities(caps);
          setCatalog(entries);
          setIconAssets(assets);
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [hierarchy, host, owner, scope.workspaceId]);

  const reconcile = useCallback(async () => {
    const id = pendingMarkerRef.current;
    if (!id || !host) return;
    try {
      const receipt = await host.queryCommand(spec, id);
      if (!receipt || receipt.status === "execution-unknown") return;
      if (clearExternalCommandMarker(markerKey, id)) {
        pendingMarkerRef.current = null;
        setPendingMarker(null);
        if (
          receipt.status === "accepted" ||
          receipt.status === "completed" ||
          receipt.status === "duplicate"
        ) {
          // Reattach reads the owner receipt instead of resending the submitted prompt.
          updateDraft("");
        }
      }
    } catch {
      /* Offline is not a rejection. Keep the marker until authoritative query succeeds. */
    }
  }, [host, spec, markerKey, updateDraft]);
  useEffect(() => {
    void reconcile();
  }, [reconcile]);

  const writable = !readOnly && !historyOnly && Boolean(host) && !pendingMarker;
  const canSend = writable && capabilities?.text.support === "supported";
  const activeTurn = snapshot?.control.activeWorks.find(
    (work) => work.kind === "primaryTurn",
  )?.foregroundExecutionId;
  const canCancel =
    writable && capabilities?.cancelTurn.support === "supported" && Boolean(activeTurn);
  const canApprove = writable && capabilities?.approvals.support === "supported";

  const dispatch = useCallback(
    async (command: AgentCommand): Promise<AgentCommandReceipt> => {
      if (
        !host ||
        !hierarchy ||
        historyOnly ||
        readOnly ||
        inFlightRef.current ||
        pendingMarkerRef.current ||
        !capabilities
      )
        throw new Error("Session is not writable");
      inFlightRef.current = true;
      setInFlight(true);
      setError(null);
      try {
        const current = await hierarchy.resolveOwner({
          targetId: scope.targetId,
          workspaceId: scope.workspaceId,
          sessionId: spec.hostSessionId,
        });
        if (
          current?.kind !== "external" ||
          current.historyOnly ||
          !sameMountedExternalOwner(current, owner)
        )
          throw new Error("Session owner changed");
        // The recovery marker is recorded before the only dispatch; a late/absent reply
        // cannot cause a second admission after view detach or reload.
        if (!writeExternalCommandMarker(markerKey, command.commandId))
          throw new Error(storageUnavailable);
        pendingMarkerRef.current = command.commandId;
        setPendingMarker(command.commandId);
        const receipt = await host.dispatch(spec, command);
        if (
          receipt.status !== "execution-unknown" &&
          clearExternalCommandMarker(markerKey, command.commandId)
        ) {
          pendingMarkerRef.current = null;
          setPendingMarker(null);
        }
        if (
          receipt.status !== "accepted" &&
          receipt.status !== "completed" &&
          receipt.status !== "duplicate"
        ) {
          throw new Error(receipt.reasonCode ?? receipt.message ?? receipt.status);
        }
        return receipt;
      } catch (cause) {
        // Bug 原因：通信异常或 execution-unknown 无法证明 Host 未受理；禁止重发或乐观确认审批。
        setError(String(cause));
        throw cause;
      } finally {
        inFlightRef.current = false;
        setInFlight(false);
      }
    },
    [
      host,
      hierarchy,
      historyOnly,
      readOnly,
      capabilities,
      markerKey,
      storageUnavailable,
      scope.targetId,
      scope.workspaceId,
      spec,
      owner,
    ],
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!canSend || !text || !snapshot || inFlight) return;
    const commandId = crypto.randomUUID();
    try {
      await dispatch({
        type: "send",
        hostSessionId: spec.hostSessionId,
        commandId,
        turnId: commandId,
        text,
      });
      if (latestDraftRef.current === draft) updateDraft("");
    } catch {
      /* draft retained, no auto-retry */
    }
  }, [
    canSend,
    draft,
    snapshot,
    inFlight,
    dispatch,
    spec.hostSessionId,
    scope.workspacePath,
    scope.workspaceIdentity,
    draftScopeId,
    updateDraft,
  ]);

  const stop = useCallback(async () => {
    if (!canCancel || !snapshot || !activeTurn) return;
    try {
      const latest = await host?.snapshot(spec);
      if (
        !latest ||
        latest.logEpoch !== snapshot.logEpoch ||
        !latest.control.activeWorks.some((work) => work.foregroundExecutionId === activeTurn)
      )
        throw new Error("Stale turn");
      await dispatch({
        type: "cancelTurn",
        hostSessionId: spec.hostSessionId,
        commandId: crypto.randomUUID(),
        turnId: activeTurn,
        runtimeEpoch: latest.logEpoch,
      });
    } catch (cause) {
      setError(String(cause));
    }
  }, [canCancel, snapshot, activeTurn, host, spec, dispatch]);

  const decide = useCallback(
    async (interactionId: string, decision: "allow" | "deny") => {
      if (!canApprove || !snapshot || !activeTurn) return;
      try {
        const latest = await host?.snapshot(spec);
        if (
          !latest ||
          latest.logEpoch !== snapshot.logEpoch ||
          !latest.pendingInteractions.some(
            (item) => item.kind === "permission" && item.interactionId === interactionId,
          ) ||
          !latest.control.activeWorks.some((work) => work.foregroundExecutionId === activeTurn)
        )
          throw new Error("Stale approval");
        await dispatch({
          type: "resolveInteraction",
          hostSessionId: spec.hostSessionId,
          commandId: crypto.randomUUID(),
          turnId: activeTurn,
          runtimeEpoch: latest.logEpoch,
          interactionId,
          decision,
        });
      } catch (cause) {
        setError(String(cause));
      }
    },
    [canApprove, snapshot, activeTurn, host, spec, dispatch],
  );

  return {
    lease,
    state,
    snapshot,
    catalog,
    iconAssets,
    draft,
    updateDraft,
    inFlight,
    error,
    pendingMarker,
    reconcile,
    canSend,
    canCancel,
    canApprove,
    activeTurn,
    send,
    stop,
    decide,
    capabilities,
  };
}
