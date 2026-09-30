import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ModelConfigSelect, type ModelSelectGroup } from "@/ModelConfigSelect.js";
import { Button } from "@/components/ui/button.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { HarnessPicker } from "@/harness/HarnessPicker.js";
import { CapabilityProviderReconfigureNotice } from "@/v4/ProviderReconfigureNotice.js";
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

const SAFE_CAPABILITY_REASONS = [
  "target-unavailable",
  "admission-disabled",
  "model-binding-mismatch",
  "harness-unavailable",
  "harness-experimental",
  "harness-not-ready",
  "model-binding-experimental",
  "model-binding-unsupported",
  "model-unavailable",
  "model-route-unavailable",
  "capability-query-failed",
] as const;

function capabilityReasonId(reason: string | undefined): string {
  return SAFE_CAPABILITY_REASONS.includes(reason as (typeof SAFE_CAPABILITY_REASONS)[number])
    ? `projectSidebar.capabilityReason.${reason}`
    : "projectSidebar.agentCreateCapabilityUnknown";
}

function buildModelGroups(
  view: ModelSelectionView,
) {
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

export function ProjectSidebarAgentCreateForm({
  workspace,
  targetOption,
  targetServices,
  worktreeGeneration,
  appearance,
  targetLabel,
  onCancel,
  onCreateAgent,
  loadAsset,
}: {
  workspace: SidebarWorkspaceNode;
  targetOption: ProjectSidebarTargetOption;
  targetServices: ProjectSidebarTargetServices | null;
  worktreeGeneration: string;
  appearance: "light" | "dark";
  targetLabel: string;
  onCancel(): void;
  onCreateAgent(
    request: Pick<WorkspaceSessionCreateRequest, "requestId" | "harnessId" | "modelBinding" | "title">,
  ): Promise<void>;
  loadAsset?: HarnessAssetLoader;
}) {
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

  const modelView = modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
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
    const defaultHarness = previousHarness ?? (available.length === 1 ? available[0]?.manifest.id : null);
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
    if (!agentHostService || !selectedBinding || !harnessId || !targetIsLive || !workspaceIsCurrent) {
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
  const modelLabel = selectedModel?.modelId ?? intl.formatMessage({ id: "projectSidebar.chooseModel" });
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
    : !targetIsLive || !workspaceIsCurrent ||
        (directoryState.status === "ready" && !directoryState.targetAvailable)
      ? intl.formatMessage({ id: "projectSidebar.cachedReadOnly" })
      : null;

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      data-project-sidebar-agent-create="true"
      className="mt-2 space-y-2 rounded-md border border-border bg-card px-2 py-2"
    >
      <p className="text-ui-sm font-medium text-foreground">
        {intl.formatMessage(
          { id: "projectSidebar.agentCreateFor" },
          { target: targetLabel, workspace: workspace.title },
        )}
      </p>
      <p className="text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "projectSidebar.agentSharedWorkspaceHint" })}
      </p>

      <div className="space-y-1">
        <span className="block text-ui-xs font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "projectSidebar.chooseHarness" })}
        </span>
        <HarnessPicker
          entries={directoryState.status === "ready" ? directoryState.entries : []}
          value={harnessId}
          appearance={appearance}
          loadAsset={loadAsset}
          disabled={directoryState.status !== "ready" || !targetIsLive || !workspaceIsCurrent}
          onValueChange={(nextHarnessId) => {
            selectedHarnessRef.current = true;
            setHarnessId(nextHarnessId);
          }}
        />
      </div>

      <div className="space-y-1">
        <span className="block text-ui-xs font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "projectSidebar.chooseModel" })}
        </span>
        {modelView ? (
          <ModelConfigSelect
            modelGroups={modelGroups}
            normalizedValue={selectedValue}
            triggerLabel={modelLabel}
            triggerLabelPrefix={selectedProviderName}
            triggerLabelValue={selectedModel?.modelId}
            showManageModelsAction={false}
            lockReasonMessage={intl.formatMessage({
              id: "projectSidebar.agentCreateNeedSelection",
            })}
            isItemLocked={() => false}
            onValueChange={(value) => {
              const next = selectionByValue.get(value);
              if (!next) return;
              selectedModelRef.current = true;
              setSelectedModel(next);
            }}
            disabled={!targetIsLive || !workspaceIsCurrent || isSubmitting || !modelGroups.length}
            tooltipTitle={intl.formatMessage(
              { id: "projectSidebar.modelSelectionFor" },
              { model: modelLabel },
            )}
            labelVisibilityClassName="inline-flex"
            triggerClassName="min-h-9 w-full justify-between"
            showProviderLevel={modelGroups.length > 1}
            contentSide="bottom"
          />
        ) : (
          <p role="status" className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({
              id:
                modelSelectionRead.state.status === "loading"
                  ? "projectSidebar.agentCreateModelLoading"
                  : "projectSidebar.agentCreateModelUnavailable",
            })}
          </p>
        )}
      </div>

      {capabilityState?.status === "checking" ? (
        <p role="status" className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "projectSidebar.agentCreateCapabilityChecking" })}
        </p>
      ) : capability ? (
        <div
          role="status"
          data-harness-model-support={capability.support}
          className={
            capability.support === "supported"
              ? "text-ui-xs text-success"
              : capability.support === "unsupported" || capability.support === "experimental"
                ? "text-ui-xs text-warning"
                : "text-ui-xs text-foreground-subtle"
          }
        >
          <span>
            {intl.formatMessage({
              id:
                capability.support === "supported"
                  ? "projectSidebar.agentCreateCapabilitySupported"
                  : capability.support === "unsupported"
                    ? "projectSidebar.agentCreateCapabilityUnsupported"
                    : capability.support === "experimental"
                      ? "projectSidebar.agentCreateCapabilityExperimental"
                      : "projectSidebar.agentCreateCapabilityUnknown",
            })}
          </span>
          {capability.reason ? (
            <span className="ml-1">{intl.formatMessage({ id: capabilityReasonId(capability.reason) })}</span>
          ) : null}
        </div>
      ) : capabilityState?.status === "unavailable" || directoryState.status === "unavailable" ? (
        <p role="status" className="text-ui-xs text-warning">
          {intl.formatMessage({ id: "projectSidebar.agentCreateCapabilityUnknown" })}
        </p>
      ) : null}
      <CapabilityProviderReconfigureNotice
        attention={capabilityState?.status === "ready" ? capabilityState.credentialAttention : null}
        providers={modelView?.providers}
      />

      <label className="block space-y-1">
        <span className="block text-ui-xs font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "projectSidebar.agentSessionTitle" })}
        </span>
        <input
          type="text"
          maxLength={256}
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          className="min-h-9 w-full rounded-md border border-input-border bg-input px-2 text-mobile-input-safe text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused md:text-ui-sm"
        />
      </label>

      {submitDisabledReason ? (
        <p role="status" className="text-ui-xs text-warning">
          {submitDisabledReason}
        </p>
      ) : null}
      {workspaceGenerationChanged ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            intentRef.current = null;
            setAcceptedGeneration(worktreeGeneration);
          }}
        >
          {intl.formatMessage({ id: "projectSidebar.agentUseCurrentWorkspace" })}
        </Button>
      ) : null}
      {submitError ? (
        <p role="alert" className="text-ui-xs text-warning">
          {intl.formatMessage({ id: "projectSidebar.agentCreateFailure" })}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" disabled={isSubmitting} onClick={onCancel}>
          {intl.formatMessage({ id: "projectSidebar.agentCreateCancel" })}
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {intl.formatMessage({
            id: isSubmitting ? "projectSidebar.agentCreatePending" : "projectSidebar.agentCreate",
          })}
        </Button>
      </div>
    </form>
  );
}
