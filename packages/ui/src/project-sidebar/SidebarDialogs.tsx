import { useEffect, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { HarnessSelector } from "../agent-host/HarnessSelector.js";
import { ModelBindingSelector } from "../agent-host/ModelBindingSelector.js";
import { labels } from "../agent-host/labels.js";
import { useProjectSidebarViewStore } from "../store/projectSidebarViewStore.js";
import type { ProjectSidebarProps, DiscoveryCandidate, RemovalPreview } from "./types.js";

export function ConfirmationDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onClose,
  onPreview,
  disabled = false,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  onPreview?: () => Promise<RemovalPreview>;
  disabled?: boolean;
}) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [preview, setPreview] = useState<RemovalPreview>();
  useEffect(() => {
    if (!onPreview) return;
    let active = true;
    void onPreview().then(
      (value) => {
        if (active) setPreview(value);
      },
      (cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [onPreview]);
  async function submit() {
    if (disabled || pending || (onPreview && !preview?.allowed)) return;
    setPending(true);
    try {
      await onConfirm();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {onPreview ? (
          <div className="text-ui-sm text-foreground-subtle" aria-live="polite">
            {preview ? (
              preview.risks.length ? (
                <ul className="list-inside list-disc">
                  {preview.risks.map((risk) => (
                    <li key={risk}>{risk}</li>
                  ))}
                </ul>
              ) : (
                "No target-reported risks"
              )
            ) : (
              "Checking target Git and activity…"
            )}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={submit}
            disabled={pending || disabled || Boolean(onPreview && !preview?.allowed)}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AgentCreationDialog({
  workspaceId,
  generation,
  props,
  onClose,
}: {
  workspaceId: string;
  generation: string;
  props: ProjectSidebarProps;
  onClose: () => void;
}) {
  const available = props.catalog.filter((entry) => entry.availability === "supported");
  const [harnessId, setHarnessId] = useState(available[0]?.manifest.id ?? "");
  const [modelIndex, setModelIndex] = useState(0);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const draft = useProjectSidebarViewStore((state) => state.drafts[workspaceId] ?? "");
  const setDraft = useProjectSidebarViewStore((state) => state.setDraft);
  const options = props.modelOptions?.filter((option) => option.harnessId === harnessId) ?? [];
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const binding = options[modelIndex]?.binding;
    if (!binding || !harnessId) return;
    setPending(true);
    try {
      await props.actions.onCreateAgent({
        workspaceId,
        expectedGeneration: generation,
        harnessId,
        modelBinding: binding,
        draft,
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{labels[props.locale].createAgent}</DialogTitle>
          <DialogDescription>{labels[props.locale].shared}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <p className="text-ui-sm text-foreground-subtle">{workspaceId}</p>
          <HarnessSelector
            catalog={props.catalog}
            value={harnessId}
            onChange={(id) => {
              setHarnessId(id);
              setModelIndex(0);
            }}
            resolveIconAsset={props.resolveIconAsset}
            locale={props.locale}
          />
          <ModelBindingSelector
            options={options}
            index={options.length ? modelIndex : -1}
            onChange={setModelIndex}
            locale={props.locale}
          />
          <label className="block text-ui-sm text-foreground-subtle">
            {labels[props.locale].draft}
            <textarea
              aria-label={labels[props.locale].draft}
              className="mt-1 w-full rounded-lg border border-input-border bg-input p-2 text-mobile-input-safe text-foreground md:text-ui-base"
              value={draft}
              onChange={(e) => setDraft(workspaceId, e.target.value)}
            />
          </label>
          {error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              {labels[props.locale].cancel}
            </Button>
            <Button type="submit" disabled={pending || !harnessId || !options.length}>
              {labels[props.locale].createAgent}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function WorkspaceCreationDialog({
  bindingId,
  props,
  onClose,
}: {
  bindingId: string;
  props: ProjectSidebarProps;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    try {
      await props.actions.onCreateWorkspace({
        repositoryBindingId: bindingId,
        title: String(data.get("title")),
        baseRef: String(data.get("baseRef")),
        branch: String(data.get("branch")),
        worktreePath: String(data.get("path")),
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {props.locale === "zh" ? "创建隔离工作区" : "Create isolated workspace"}
          </DialogTitle>
          <DialogDescription>
            {props.locale === "zh"
              ? "创建新的 Git worktree，不复用现有工作区。"
              : "Create a separate Git worktree; do not reuse an existing workspace."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-2">
          {(
            [
              ["title", props.locale === "zh" ? "工作区名称" : "Workspace title"],
              ["baseRef", props.locale === "zh" ? "基准引用" : "Base ref"],
              ["branch", props.locale === "zh" ? "分支" : "Branch"],
              ["path", props.locale === "zh" ? "目标目录" : "Target directory"],
            ] as const
          ).map(([name, label]) => (
            <label key={name} className="block text-ui-sm text-foreground-subtle">
              {label}
              <Input name={name} aria-label={label} required />
            </label>
          ))}
          {error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              {labels[props.locale].cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {props.locale === "zh" ? "创建工作区" : "Create workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DiscoveredWorktreesDialog({
  bindingId,
  candidates,
  props,
  onClose,
}: {
  bindingId: string;
  candidates: readonly DiscoveryCandidate[];
  props: ProjectSidebarProps;
  onClose: () => void;
}) {
  const [candidate, setCandidate] = useState<DiscoveryCandidate>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function adopt() {
    if (!candidate) return;
    setPending(true);
    try {
      await props.actions.onAdopt(bindingId, candidate.path);
      setCandidate(undefined);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {props.locale === "zh" ? "发现的工作区" : "Discovered worktrees"}
          </DialogTitle>
          <DialogDescription>
            {props.locale === "zh"
              ? "扫描为只读；仅明确接管后才登记。"
              : "Discovery is read-only; explicitly adopt a candidate to register it."}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-64 space-y-1 overflow-auto">
          {candidates.map((item) => (
            <div
              key={item.path}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-hover"
            >
              <span className="min-w-0 truncate" title={item.path}>
                {item.label} <span className="text-ui-sm text-foreground-subtle">{item.head}</span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setCandidate(item)}
                aria-label={`${props.locale === "zh" ? "接管" : "Adopt"} ${item.label}`}
              >
                {props.locale === "zh" ? "接管" : "Adopt"}
              </Button>
            </div>
          ))}
        </div>
        {candidate ? (
          <p className="text-ui-sm">
            {props.locale === "zh" ? "接管" : "Adopt"} {candidate.path}?{" "}
            {props.locale === "zh"
              ? "此操作登记已有工作区，不创建 Git worktree。"
              : "This registers the existing worktree; it does not create one."}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            {labels[props.locale].cancel}
          </Button>
          {candidate ? (
            <Button type="button" onClick={adopt} disabled={pending}>
              {props.locale === "zh" ? "确认接管" : "Confirm adopt"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
