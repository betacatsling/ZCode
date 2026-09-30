import { Button } from "@/components/ui/button.js";
import { CompatibilityStatus } from "@/agent-host/CompatibilityStatus.js";
import { HarnessSelector } from "@/agent-host/HarnessSelector.js";
import {
  ModelBindingSelector,
  type ModelBindingOption,
} from "@/agent-host/ModelBindingSelector.js";
import { admitsExecution, type CapabilityReport } from "@/agent-host/SessionCapabilities.js";
import type { AgentCreationDraft } from "./sidebarViewStore.js";
import type { OrcaSidebarChrome } from "./orcaSidebarChrome.js";

export function AgentCreatePanel({
  workspaceTitle,
  targetLabel,
  draft,
  models,
  report,
  chrome,
  onDraftChange,
  onCancel,
  onCreate,
}: {
  workspaceTitle: string;
  targetLabel: string;
  draft: AgentCreationDraft;
  models: readonly ModelBindingOption[];
  report: CapabilityReport;
  chrome: OrcaSidebarChrome;
  onDraftChange: (draft: AgentCreationDraft) => void;
  onCancel: () => void;
  onCreate: (draft: AgentCreationDraft) => void;
}) {
  const { copy } = chrome;
  const requested = models.find((model) => model.id === draft.modelId)?.label ?? "";
  const canCreate = Boolean(draft.harnessId && draft.modelId && admitsExecution(report));
  return (
    <form
      data-agent-create={workspaceTitle}
      className="space-y-2 rounded-lg bg-surface px-2 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (canCreate) onCreate(draft);
      }}
    >
      <p className="text-ui-xs text-foreground-subtle">
        {copy.target}: {targetLabel}
      </p>
      <p className="text-ui-xs text-foreground-subtle">{copy.sharedHint}</p>
      <HarnessSelector
        directory={chrome.directory}
        assets={chrome.assets}
        appearance={chrome.appearance}
        value={draft.harnessId}
        label={copy.chooseHarness}
        onChange={(harnessId) => onDraftChange({ ...draft, harnessId })}
      />
      <ModelBindingSelector
        options={models}
        value={draft.modelId}
        label={copy.chooseModel}
        kindLabel={(kind) => (kind === "host-managed" ? copy.hostManaged : copy.harnessManaged)}
        onChange={(modelId) => onDraftChange({ ...draft, modelId })}
      />
      <CompatibilityStatus
        requestedLabel={requested}
        effectiveLabel={requested || undefined}
        report={report}
        copy={copy}
      />
      <label className="block space-y-1 text-ui-sm text-foreground">
        <span>{copy.sessionTitle}</span>
        <input
          value={draft.title}
          onChange={(event) => onDraftChange({ ...draft, title: event.target.value })}
          className="min-h-9 w-full rounded-md border border-input-border bg-input px-2 text-mobile-input-safe text-foreground md:text-ui-sm"
        />
      </label>
      <div className="flex gap-2">
        <Button type="submit" disabled={!canCreate} className="min-h-9 md:min-h-8">
          {copy.createAgent}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} className="min-h-9 md:min-h-8">
          {copy.cancel}
        </Button>
      </div>
    </form>
  );
}
