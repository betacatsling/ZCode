import { Button } from "@/components/ui/button.js";
import type { WorkspaceCreationDraft } from "./sidebarViewStore.js";
import type { OrcaSidebarCopy } from "./orcaSidebarCopy.js";

export function WorkspaceCreationDialog({
  open,
  projectName,
  targetLabel,
  draft,
  copy,
  onDraftChange,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  projectName: string;
  targetLabel: string;
  draft: WorkspaceCreationDraft;
  copy: OrcaSidebarCopy;
  onDraftChange: (draft: WorkspaceCreationDraft) => void;
  onCancel: () => void;
  onSubmit: (draft: WorkspaceCreationDraft) => void;
}) {
  if (!open) return null;
  return (
    <form
      role="dialog"
      aria-label={copy.createWorkspace}
      data-workspace-dialog={projectName}
      className="space-y-2 rounded-xl border border-popover-border bg-popover p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(draft);
      }}
    >
      <p className="text-ui-sm text-foreground-subtle">
        {copy.target}: {targetLabel}
      </p>
      <label className="block space-y-1 text-ui-sm text-foreground">
        <span>{copy.workspaceName}</span>
        <input
          value={draft.title}
          onChange={(event) => onDraftChange({ ...draft, title: event.target.value })}
          className="min-h-9 w-full rounded-md border border-input-border bg-input px-2 text-mobile-input-safe text-foreground md:text-ui-sm"
        />
      </label>
      <label className="block space-y-1 text-ui-sm text-foreground">
        <span>{copy.baseRef}</span>
        <input
          value={draft.baseRef}
          onChange={(event) => onDraftChange({ ...draft, baseRef: event.target.value })}
          className="min-h-9 w-full rounded-md border border-input-border bg-input px-2 font-mono text-mobile-input-safe text-foreground md:text-ui-sm"
        />
      </label>
      <label className="block space-y-1 text-ui-sm text-foreground">
        <span>{copy.branch}</span>
        <select
          value={draft.branchMode}
          onChange={(event) =>
            onDraftChange({
              ...draft,
              branchMode: event.target.value === "existing" ? "existing" : "new",
            })
          }
          className="min-h-9 w-full rounded-md border border-input-border bg-input px-2 text-mobile-input-safe text-foreground md:text-ui-sm"
        >
          <option value="new">{copy.newBranch}</option>
          <option value="existing">{copy.existingBranch}</option>
        </select>
        <input
          value={draft.branch}
          onChange={(event) => onDraftChange({ ...draft, branch: event.target.value })}
          className="min-h-9 w-full rounded-md border border-input-border bg-input px-2 font-mono text-mobile-input-safe text-foreground md:text-ui-sm"
        />
      </label>
      <label className="block space-y-1 text-ui-sm text-foreground">
        <span>{copy.directory}</span>
        <input
          value={draft.directory}
          onChange={(event) => onDraftChange({ ...draft, directory: event.target.value })}
          className="min-h-9 w-full rounded-md border border-input-border bg-input px-2 font-mono text-mobile-input-safe text-foreground md:text-ui-sm"
        />
      </label>
      <div className="flex gap-2">
        <Button type="submit" className="min-h-9 md:min-h-8">
          {copy.createWorkspace}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} className="min-h-9 md:min-h-8">
          {copy.cancel}
        </Button>
      </div>
    </form>
  );
}
