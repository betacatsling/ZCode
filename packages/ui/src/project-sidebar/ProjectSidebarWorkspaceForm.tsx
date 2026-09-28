import { useRef, useState, type FormEvent } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import type {
  CreateWorkspaceRequest,
  WorktreeCandidate,
  WorktreeCreateResult,
  WorktreeWorkspaceRecord,
} from "@zcode/services/worktree";
import type { ProjectSidebarWorkspaceBindingOption } from "./contract.js";
import { formatProjectSidebarError } from "./projectSidebarErrors.js";

function createRequestId(): string {
  // 浏览器 Crypto.randomUUID 依赖 this 绑定，不能先取出函数再裸调用。
  return `workspace-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

type CreateWorkspaceIntent = CreateWorkspaceRequest extends infer Request
  ? Request extends { requestId: string }
    ? Omit<Request, "requestId">
    : never
  : never;

function requestSignature(request: CreateWorkspaceIntent, targetId: string): string {
  return JSON.stringify([
    targetId,
    request.mode,
    request.projectId,
    request.repositoryBindingId,
    request.worktreePath,
    request.title,
    request.mode === "new-branch" ? request.baseRef : request.existingBranch,
    request.mode === "new-branch" ? request.newBranch : null,
  ]);
}

export function ProjectSidebarWorkspaceForm({
  projectId,
  bindingOptions,
  onCreate,
  onRecoverWorkspace,
  onCancel,
}: {
  projectId: string;
  bindingOptions: readonly ProjectSidebarWorkspaceBindingOption[];
  onCreate: (
    target: ProjectSidebarWorkspaceBindingOption,
    request: CreateWorkspaceRequest,
  ) => Promise<WorktreeCreateResult>;
  onRecoverWorkspace: (
    target: ProjectSidebarWorkspaceBindingOption,
    request: CreateWorkspaceRequest,
    candidate: WorktreeCandidate,
  ) => Promise<WorktreeWorkspaceRecord>;
  onCancel: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [title, setTitle] = useState("");
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<CreateWorkspaceRequest["mode"]>("new-branch");
  const [bindingKey, setBindingKey] = useState(() =>
    bindingOptions.length === 1
      ? `${bindingOptions[0]?.targetId}\0${bindingOptions[0]?.repositoryBindingId}`
      : "",
  );
  const [baseRef, setBaseRef] = useState("");
  const [branch, setBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{
    request: CreateWorkspaceRequest;
    candidate: WorktreeCandidate | null;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // React state 提交后才更新，使用同步锁避免恢复/重试被旧闭包吞掉。
  const isSubmittingRef = useRef(false);
  const requestIntentRef = useRef<{ signature: string; requestId: string } | null>(null);

  const selectedBinding = bindingOptions.find(
    (option) => `${option.targetId}\0${option.repositoryBindingId}` === bindingKey,
  );

  const execute = async () => {
    if (isSubmittingRef.current || recovery) return;
    if (!selectedBinding) {
      setError(intl.formatMessage({ id: "projectSidebar.error.servicesUnavailable" }));
      return;
    }
    isSubmittingRef.current = true;
    const requestBase: CreateWorkspaceIntent =
      mode === "new-branch"
        ? {
            mode,
            repositoryBindingId: selectedBinding.repositoryBindingId,
            projectId,
            worktreePath: path,
            title,
            baseRef,
            newBranch: branch,
          }
        : {
            mode,
            repositoryBindingId: selectedBinding.repositoryBindingId,
            projectId,
            worktreePath: path,
            title,
            existingBranch: branch,
          };
    const signature = requestSignature(requestBase, selectedBinding.targetId);
    if (requestIntentRef.current?.signature !== signature) {
      requestIntentRef.current = { signature, requestId: createRequestId() };
    }
    setError(null);
    setIsSubmitting(true);
    try {
      const request = {
        ...requestBase,
        requestId: requestIntentRef.current.requestId,
      } as CreateWorkspaceRequest;
      const result = await onCreate(selectedBinding, request);
      if (result.status === "unregistered") {
        setRecovery({ request, candidate: result.candidate });
        setError(
          intl.formatMessage({ id: "projectSidebar.error.detail" }, { error: result.error }),
        );
        return;
      }
      onCancel();
    } catch (reason) {
      setError(formatProjectSidebarError(reason, intl));
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await execute();
  };

  const recover = async () => {
    if (isSubmittingRef.current || !recovery?.candidate) return;
    isSubmittingRef.current = true;
    setError(null);
    setIsSubmitting(true);
    try {
      if (!selectedBinding) {
        setError(intl.formatMessage({ id: "projectSidebar.error.targetOffline" }));
        return;
      }
      await onRecoverWorkspace(selectedBinding, recovery.request, recovery.candidate);
      onCancel();
    } catch (reason) {
      setError(formatProjectSidebarError(reason, intl));
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="space-y-2 rounded-xl bg-surface p-2"
      aria-busy={isSubmitting}
      data-project-sidebar-workspace-form={projectId}
    >
      <label className="block space-y-1 text-ui-sm text-foreground-subtle">
        <span>{intl.formatMessage({ id: "projectSidebar.repositoryBinding" })}</span>
        <select
          aria-label={intl.formatMessage({ id: "projectSidebar.repositoryBinding" })}
          value={bindingKey}
          onChange={(event) => setBindingKey(event.target.value)}
          disabled={isSubmitting || bindingOptions.length === 0}
          className="min-h-9 w-full rounded-md border border-input-border bg-input px-2 text-mobile-input-safe text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused md:text-ui-sm"
        >
          {bindingOptions.length !== 1 ? (
            <option value="">{intl.formatMessage({ id: "projectSidebar.chooseBinding" })}</option>
          ) : null}
          {bindingOptions
            .filter((option) => !recovery || option.targetId === recovery.candidate?.targetId)
            .map((option) => {
              const value = `${option.targetId}\0${option.repositoryBindingId}`;
              return (
                <option key={value} value={value}>
                  {option.isLocal
                    ? intl.formatMessage({ id: "projectSidebar.localTarget" })
                    : (option.targetPresentation.displayName ??
                      intl.formatMessage({ id: "projectSidebar.targetNeedsVerification" }))}{" "}
                  · {option.repositoryPath}
                </option>
              );
            })}
        </select>
      </label>
      {bindingOptions.length === 0 ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "projectSidebar.error.targetOffline" })}
        </p>
      ) : null}
      <Input
        required
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder={intl.formatMessage({ id: "projectSidebar.workspaceTitle" })}
        aria-label={intl.formatMessage({ id: "projectSidebar.workspaceTitle" })}
        disabled={isSubmitting || recovery !== null}
        className="text-mobile-input-safe md:text-ui-sm"
      />
      <Input
        required
        value={path}
        onChange={(event) => setPath(event.target.value)}
        placeholder={intl.formatMessage({ id: "projectSidebar.workspacePath" })}
        aria-label={intl.formatMessage({ id: "projectSidebar.workspacePath" })}
        disabled={isSubmitting || recovery !== null}
        className="font-mono text-mobile-input-safe md:text-ui-sm"
      />
      <fieldset disabled={isSubmitting || recovery !== null} className="space-y-1">
        <legend className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "projectSidebar.branchMode" })}
        </legend>
        <label className="flex min-h-8 items-center gap-2 text-ui-sm text-foreground">
          <input
            type="radio"
            name={`workspace-branch-mode-${projectId}`}
            value="new-branch"
            checked={mode === "new-branch"}
            onChange={() => setMode("new-branch")}
          />
          {intl.formatMessage({ id: "projectSidebar.branchMode.new" })}
        </label>
        <label className="flex min-h-8 items-center gap-2 text-ui-sm text-foreground">
          <input
            type="radio"
            name={`workspace-branch-mode-${projectId}`}
            value="existing-branch"
            checked={mode === "existing-branch"}
            onChange={() => setMode("existing-branch")}
          />
          {intl.formatMessage({ id: "projectSidebar.branchMode.existing" })}
        </label>
      </fieldset>
      {mode === "new-branch" ? (
        <Input
          required
          value={baseRef}
          onChange={(event) => setBaseRef(event.target.value)}
          placeholder={intl.formatMessage({ id: "projectSidebar.baseRef" })}
          aria-label={intl.formatMessage({ id: "projectSidebar.baseRef" })}
          disabled={isSubmitting || recovery !== null}
          className="font-mono text-mobile-input-safe md:text-ui-sm"
        />
      ) : null}
      <Input
        required
        value={branch}
        onChange={(event) => setBranch(event.target.value)}
        placeholder={intl.formatMessage({
          id: mode === "new-branch" ? "projectSidebar.newBranch" : "projectSidebar.existingBranch",
        })}
        aria-label={intl.formatMessage({
          id: mode === "new-branch" ? "projectSidebar.newBranch" : "projectSidebar.existingBranch",
        })}
        disabled={isSubmitting || recovery !== null}
        className="font-mono text-mobile-input-safe md:text-ui-sm"
      />
      {error ? (
        <div role="alert" className="space-y-1 text-ui-sm text-destructive">
          <p>{error}</p>
          {recovery?.candidate ? (
            <div className="rounded-lg border border-border p-2 text-foreground">
              <p>{intl.formatMessage({ id: "projectSidebar.unregisteredCandidate" })}</p>
              <p className="font-mono text-ui-xs">
                {recovery.candidate.isMainWorktree
                  ? intl.formatMessage({ id: "projectSidebar.mainCheckout" })
                  : recovery.candidate.head.kind === "branch"
                    ? recovery.candidate.head.ref
                    : intl.formatMessage({ id: "projectSidebar.detachedHead" })}{" "}
                · {recovery.candidate.worktreePath}
              </p>
            </div>
          ) : recovery ? (
            <p>{intl.formatMessage({ id: "projectSidebar.unregisteredCandidateMissing" })}</p>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {recovery ? (
          recovery.candidate ? (
            <Button
              type="button"
              variant="default"
              size="lg"
              disabled={isSubmitting}
              onClick={() => void recover()}
              className="min-h-8"
              data-project-sidebar-retry-registration="true"
            >
              {intl.formatMessage({ id: "projectSidebar.retryRegistration" })}
            </Button>
          ) : null
        ) : (
          <Button
            type="submit"
            variant="default"
            size="lg"
            disabled={isSubmitting || !selectedBinding}
            className="min-h-8"
          >
            {intl.formatMessage({ id: "projectSidebar.createWorkspace" })}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="lg"
          onClick={onCancel}
          disabled={isSubmitting || !selectedBinding}
          className="min-h-8"
        >
          {intl.formatMessage({ id: "projectSidebar.cancel" })}
        </Button>
      </div>
    </form>
  );
}
