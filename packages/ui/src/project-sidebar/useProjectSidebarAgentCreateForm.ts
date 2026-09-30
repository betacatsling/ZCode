import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type {
  AgentModelFailure,
  CapabilityReport,
  HarnessDirectoryEntry,
  WorkspaceSessionCreateRequest,
} from "@zcode/shared/agent-host";
import type { ProjectSidebarTargetOption, ProjectSidebarTargetServices } from "./contract.js";
import type { SidebarWorkspaceNode } from "@zcode/shared/agent-host";
import type { HarnessAssetLoader } from "@/harness/HarnessIcon.js";

function buildModelGroups(view: ModelSelectionView) {
  const selectionByValue = new Map<string, ModelSelection>();
  const groups: ModelSelectGroup[] = view.providers.map((provider) => ({
    key: `agent-provider:${provider.providerId}`,
    label: provider.providerName?.trim() || provider.providerId,
    items: provider.models.map(({ modelId }) => {
      const value = encodeCustomModelValue(provider.providerId, modelId);
      selectionByValue.set(value, { providerId: provider.providerId, modelId });
      return {
        key: `agent-model:${provider.providerId}:${modelId}`,
        value,
        name: modelId,
      };
    }),
  }));
  return { groups, selectionByValue };
}

export interface ProjectSidebarAgentCreateFormProps {
  workspace: SidebarWorkspaceNode;
  targetOption: ProjectSidebarTargetOption;
  targetServices: ProjectSidebarTargetServices | null;
  worktreeGeneration: string;
  appearance: "light" | "dark";
  targetLabel: string;
  onCancel(): void;
  onCreateAgent(
    request: Pick<
      WorkspaceSessionCreateRequest,
      "requestId" | "harnessId" | "modelBinding" | "title"
    >,
  ): Promise<void>;
  loadAsset?: HarnessAssetLoader;
}

/**
 * State, effects and submit handling of {@link ProjectSidebarAgentCreateForm}, moved verbatim out
 * of the component (same hooks in the same order); the component keeps only the markup.
 */
export function useProjectSidebarAgentCreateForm({
  workspace,
  targetOption,
  targetServices,
  worktreeGeneration,
  onCreateAgent,
}: Pick<
  ProjectSidebarAgentCreateFormProps,
  "workspace" | "targetOption" | "targetServices" | "worktreeGeneration" | "onCreateAgent"
>) {
  const { intl } = useZCodeIntl();
  const agentHostService = targetServices?.agentHostService ?? null;
  const targetIsLive = workspace.targetFreshness === "live" && targetOption.writable;
  const workspaceIsCurrent =
    workspace.worktreePath !== null &&
    workspace.verification === "verified" &&
    workspace.lifecycle === "active";
  const modelSelectionRead = useModelSelectionServiceView(
    targetServices?.modelSelectionService,
    targetIsLive && workspaceIsCurrent,
    "remote-waiting",
  );
  const [directoryState, setDirectoryState] = useState<
    | { status: "loading" }
    | {
        status: "ready";
        entries: readonly HarnessDirectoryEntry[];
        targetAvailable: boolean;
        admissionEnabled: boolean;
        targetId: string;
      }
    | { status: "unavailable" }
  >({ status: "loading" });
  const [harnessId, setHarnessId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<ModelSelection | null>(null);
  const selectedHarnessRef = useRef(false);
  const selectedModelRef = useRef(false);
  const [title, setTitle] = useState("");
  const [capabilityState, setCapabilityState] = useState<
    | { status: "checking" }
    | { status: "ready"; report: CapabilityReport; credentialAttention?: AgentModelFailure }
    | { status: "unavailable" }
    | null
  >(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  const [acceptedGeneration, setAcceptedGeneration] = useState(worktreeGeneration);
  const intentRef = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const isSubmittingRef = useRef(false);

  useEffect(() => {
    let current = true;
    if (!agentHostService) {
      setDirectoryState({ status: "unavailable" });
      return () => {
        current = false;
      };
    }
    setDirectoryState({ status: "loading" });
    void Promise.all([agentHostService.getAvailability(), agentHostService.getDirectory()]).then(
      ([availability, directory]) => {
        if (!current) return;
        if (
          availability.target.id !== targetOption.targetId ||
          directory.targetId !== targetOption.targetId ||
          directory.status !== "available"
        ) {
          setDirectoryState({ status: "unavailable" });
          return;
        }
        setDirectoryState({
          status: "ready",
          entries: directory.entries,
          targetAvailable: availability.target.available,
          admissionEnabled: availability.admissionEnabled,
          targetId: directory.targetId,
        });
      },
      () => {
        if (current) setDirectoryState({ status: "unavailable" });
      },
    );
    return () => {
      current = false;
    };
  }, [agentHostService, targetOption.targetId, targetOption.attachmentGeneration]);

  const modelView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const { groups: modelGroups, selectionByValue } = useMemo(
    () => (modelView ? buildModelGroups(modelView) : { groups: [], selectionByValue: new Map() }),
    [modelView],
  );
  useEffect(() => {
    if (selectedHarnessRef.current || directoryState.status !== "ready") return;
    const available = directoryState.entries.filter((entry) => entry.status === "registered");
    const availableIds = new Set(available.map((entry) => entry.manifest.id));
    const previousHarness = [...workspace.sessions]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .find((session) => availableIds.has(session.harnessId))?.harnessId;
    const defaultHarness =
      previousHarness ?? (available.length === 1 ? available[0]?.manifest.id : null);
    if (defaultHarness) setHarnessId(defaultHarness);
    selectedHarnessRef.current = true;
  }, [directoryState, workspace.sessions]);

  useEffect(() => {
    if (selectedModelRef.current || !modelView?.preferredSelection) return;
    const preferred = modelView.preferredSelection;
    const available = [...selectionByValue.values()].some(
      (selection) =>
        selection.providerId === preferred.providerId && selection.modelId === preferred.modelId,
    );
    if (available) setSelectedModel(preferred);
    selectedModelRef.current = true;
  }, [modelView, selectionByValue]);

  const selectedBinding = useMemo(() => {
    if (!harnessId || !selectedModel) return null;
    return harnessId === "zcode"
      ? { kind: "native-selection" as const, selection: selectedModel }
      : { kind: "host-managed" as const, selection: selectedModel };
  }, [harnessId, selectedModel]);
  const bindingKey = selectedBinding ? JSON.stringify([harnessId, selectedBinding]) : "";

  useEffect(() => {
    if (
      !agentHostService ||
      !selectedBinding ||
      !harnessId ||
      !targetIsLive ||
      !workspaceIsCurrent
    ) {
      setCapabilityState(null);
      return;
    }
    let current = true;
    setCapabilityState({ status: "checking" });
    void agentHostService
      .getWorkspaceSessionCapability({ harnessId, modelBinding: selectedBinding })
      .then((result) => {
        if (!current) return;
        setCapabilityState(
          result.targetId === targetOption.targetId
            ? {
                status: "ready",
                report: result.report,
                credentialAttention: result.credentialAttention,
              }
            : { status: "unavailable" },
        );
      })
      .catch(() => {
        if (current) setCapabilityState({ status: "unavailable" });
      });
    return () => {
      current = false;
    };
  }, [
    agentHostService,
    bindingKey,
    harnessId,
    selectedBinding,
    targetIsLive,
    targetOption.targetId,
    workspaceIsCurrent,
  ]);

  const selectedValue = selectedModel
    ? encodeCustomModelValue(selectedModel.providerId, selectedModel.modelId)
    : "";
  const selectedProviderName =
    modelView?.providers.find((provider) => provider.providerId === selectedModel?.providerId)
      ?.providerName ?? selectedModel?.providerId;
  const modelLabel =
    selectedModel?.modelId ?? intl.formatMessage({ id: "projectSidebar.chooseModel" });
  const registeredHarness =
    directoryState.status === "ready" &&
    directoryState.entries.some(
      (entry) => entry.manifest.id === harnessId && entry.status === "registered",
    );
  const capability = capabilityState?.status === "ready" ? capabilityState.report : null;
  const workspaceGenerationChanged = acceptedGeneration !== worktreeGeneration;
  const canSubmit =
    Boolean(
      agentHostService &&
      targetIsLive &&
      workspaceIsCurrent &&
      !workspaceGenerationChanged &&
      directoryState.status === "ready" &&
      directoryState.targetAvailable &&
      directoryState.admissionEnabled &&
      directoryState.targetId === targetOption.targetId &&
      registeredHarness &&
      selectedBinding &&
      capability?.support === "supported",
    ) && !isSubmitting;

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (isSubmittingRef.current || !canSubmit || !harnessId || !selectedBinding) return;
      isSubmittingRef.current = true;
      setIsSubmitting(true);
      setSubmitError(false);
      const normalizedTitle = title.trim();
      const fingerprint = JSON.stringify([
        targetOption.targetId,
        targetOption.attachmentGeneration,
        workspace.workspaceId,
        acceptedGeneration,
        harnessId,
        selectedBinding,
        normalizedTitle,
      ]);
      const requestId =
        intentRef.current?.fingerprint === fingerprint
          ? intentRef.current.requestId
          : globalThis.crypto.randomUUID();
      intentRef.current = { fingerprint, requestId };
      try {
        await onCreateAgent({
          requestId,
          harnessId,
          modelBinding: selectedBinding,
          ...(normalizedTitle ? { title: normalizedTitle } : {}),
        });
        intentRef.current = null;
      } catch {
        setSubmitError(true);
      } finally {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
      }
    },
    [
      acceptedGeneration,
      canSubmit,
      harnessId,
      onCreateAgent,
      selectedBinding,
      targetOption.attachmentGeneration,
      targetOption.targetId,
      title,
      workspace.workspaceId,
    ],
  );

  const submitDisabledReason = workspaceGenerationChanged
    ? intl.formatMessage({ id: "projectSidebar.agentCreateWorkspaceChanged" })
    : !targetIsLive ||
        !workspaceIsCurrent ||
        (directoryState.status === "ready" && !directoryState.targetAvailable)
      ? intl.formatMessage({ id: "projectSidebar.cachedReadOnly" })
      : null;

  return {
    intl,
    directoryState,
    harnessId,
    setHarnessId,
    selectedHarnessRef,
    targetIsLive,
    workspaceIsCurrent,
    modelView,
    modelGroups,
    selectionByValue,
    selectedValue,
    modelLabel,
    selectedProviderName,
    selectedModel,
    selectedModelRef,
    setSelectedModel,
    isSubmitting,
    modelSelectionRead,
    capabilityState,
    capability,
    title,
    setTitle,
    submitDisabledReason,
    workspaceGenerationChanged,
    intentRef,
    setAcceptedGeneration,
    submitError,
    canSubmit,
    handleSubmit,
  };
}
