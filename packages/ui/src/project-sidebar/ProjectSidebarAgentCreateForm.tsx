import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { Button } from "@/components/ui/button.js";
import { HarnessPicker } from "@/harness/HarnessPicker.js";
import { CapabilityProviderReconfigureNotice } from "@/v4/ProviderReconfigureNotice.js";
import {
  useProjectSidebarAgentCreateForm,
  type ProjectSidebarAgentCreateFormProps,
} from "./useProjectSidebarAgentCreateForm.js";

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
}: ProjectSidebarAgentCreateFormProps) {
  const {
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
  } = useProjectSidebarAgentCreateForm({
    workspace,
    targetOption,
    targetServices,
    worktreeGeneration,
    onCreateAgent,
  });

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
            <span className="ml-1">
              {intl.formatMessage({ id: capabilityReasonId(capability.reason) })}
            </span>
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
