import { useEffect, useRef, useState, type FormEvent } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import type {
  ProjectSidebarBareRepositoryCandidate,
  ProjectSidebarCandidate,
  ProjectSidebarImportResult,
  ProjectSidebarImportSelection,
  ProjectSidebarTargetOption,
} from "./contract.js";
import { formatProjectSidebarError } from "./projectSidebarErrors.js";

function candidateKey(candidate: ProjectSidebarCandidate): string {
  return `${candidate.targetId}\0${candidate.repositoryCommonDir}\0${candidate.worktreePath}`;
}

export function ProjectSidebarAddForm({
  targetOptions,
  projects,
  onAddProject,
}: {
  targetOptions: readonly ProjectSidebarTargetOption[];
  projects: readonly { projectId: string; name: string }[];
  onAddProject: (
    target: ProjectSidebarTargetOption,
    name: string,
    path: string,
    selection?: ProjectSidebarImportSelection,
    existingProjectId?: string,
  ) => Promise<ProjectSidebarImportResult>;
}) {
  const { intl } = useZCodeIntl();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [existingProjectId, setExistingProjectId] = useState("");
  const [targetId, setTargetId] = useState(
    targetOptions.length === 1 ? (targetOptions[0]?.targetId ?? "") : "",
  );
  const [addError, setAddError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<readonly ProjectSidebarCandidate[]>([]);
  const [bareCandidate, setBareCandidate] = useState<ProjectSidebarBareRepositoryCandidate | null>(
    null,
  );
  const [selectedCandidateKey, setSelectedCandidateKey] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // React state 提交后才更新，使用同步锁避免失败后的重试被旧闭包吞掉。
  const isSubmittingRef = useRef(false);

  useEffect(() => {
    if (targetOptions.some((option) => option.targetId === targetId)) return;
    setTargetId(targetOptions.length === 1 ? (targetOptions[0]?.targetId ?? "") : "");
    setCandidates([]);
    setBareCandidate(null);
    setSelectedCandidateKey(null);
  }, [targetId, targetOptions]);

  const clearCompletedIntent = () => {
    setCandidates([]);
    setBareCandidate(null);
    setSelectedCandidateKey(null);
    setName("");
    setPath("");
    setExistingProjectId("");
  };

  const run = async (selection?: ProjectSidebarImportSelection) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setAddError(null);
    const target = targetOptions.find((option) => option.targetId === targetId);
    if (!target) {
      setAddError(intl.formatMessage({ id: "projectSidebar.error.targetRequired" }));
      isSubmittingRef.current = false;
      return;
    }
    setIsSubmitting(true);
    try {
      const existingProject = projects.find((project) => project.projectId === existingProjectId);
      const result = await onAddProject(
        target,
        existingProject?.name ?? name.trim(),
        path,
        selection,
        existingProject?.projectId,
      );
      if (result.status === "choices") {
        setCandidates(result.candidates);
        setBareCandidate(null);
        return;
      }
      if (result.status === "bare-repository") {
        setCandidates([]);
        setBareCandidate(result.candidate);
        return;
      }
      clearCompletedIntent();
    } catch (error) {
      setAddError(formatProjectSidebarError(error, intl));
      setSelectedCandidateKey(null);
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await run();
  };

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="mb-2 space-y-2 rounded-xl bg-surface p-2"
      data-project-sidebar-add-form="true"
    >
      <label className="block space-y-1 text-ui-sm text-foreground-subtle">
        <span>{intl.formatMessage({ id: "projectSidebar.target" })}</span>
        <select
          aria-label={intl.formatMessage({ id: "projectSidebar.target" })}
          value={targetId}
          onChange={(event) => {
            setTargetId(event.target.value);
            setCandidates([]);
            setBareCandidate(null);
            setSelectedCandidateKey(null);
          }}
          disabled={isSubmitting || selectedCandidateKey !== null || Boolean(bareCandidate)}
          className="min-h-9 w-full rounded-md border border-input-border bg-input px-2 text-mobile-input-safe text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused md:text-ui-sm"
        >
          <option value="">{intl.formatMessage({ id: "projectSidebar.chooseTarget" })}</option>
          {targetOptions.map((target) => (
            <option key={target.targetId} value={target.targetId}>
              {target.isLocal
                ? intl.formatMessage({ id: "projectSidebar.localTarget" })
                : (target.targetPresentation.displayName ??
                  intl.formatMessage({ id: "projectSidebar.targetNeedsVerification" }))}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1 text-ui-sm text-foreground-subtle">
        <span>{intl.formatMessage({ id: "projectSidebar.project" })}</span>
        <select
          aria-label={intl.formatMessage({ id: "projectSidebar.project" })}
          value={existingProjectId}
          onChange={(event) => {
            setExistingProjectId(event.target.value);
            setCandidates([]);
            setBareCandidate(null);
            setSelectedCandidateKey(null);
          }}
          disabled={isSubmitting || selectedCandidateKey !== null || Boolean(bareCandidate)}
          className="min-h-9 w-full rounded-md border border-input-border bg-input px-2 text-mobile-input-safe text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused md:text-ui-sm"
        >
          <option value="">{intl.formatMessage({ id: "projectSidebar.newProject" })}</option>
          {projects.map((project) => (
            <option key={project.projectId} value={project.projectId}>
              {intl.formatMessage(
                { id: "projectSidebar.addToExistingProject" },
                { project: project.name },
              )}
            </option>
          ))}
        </select>
      </label>
      <Input
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          setCandidates([]);
          setSelectedCandidateKey(null);
        }}
        placeholder={intl.formatMessage({ id: "projectSidebar.projectName" })}
        aria-label={intl.formatMessage({ id: "projectSidebar.projectName" })}
        required={!existingProjectId}
        disabled={
          isSubmitting ||
          selectedCandidateKey !== null ||
          Boolean(bareCandidate) ||
          Boolean(existingProjectId)
        }
        className="text-mobile-input-safe md:text-ui-sm"
      />
      <Input
        value={path}
        onChange={(event) => {
          setPath(event.target.value);
          setCandidates([]);
          setSelectedCandidateKey(null);
        }}
        placeholder={intl.formatMessage({ id: "projectSidebar.worktreePath" })}
        aria-label={intl.formatMessage({ id: "projectSidebar.worktreePath" })}
        required
        disabled={isSubmitting || selectedCandidateKey !== null || Boolean(bareCandidate)}
        className="font-mono text-mobile-input-safe md:text-ui-sm"
      />
      {addError ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {addError}
        </p>
      ) : null}
      {candidates.length > 0 ? (
        <div
          className="space-y-1"
          aria-label={intl.formatMessage({ id: "projectSidebar.chooseWorktree" })}
        >
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "projectSidebar.chooseWorktree" })}
          </p>
          {candidates.map((candidate) => {
            const key = candidateKey(candidate);
            const selected = selectedCandidateKey === key;
            return (
              <Button
                key={key}
                type="button"
                variant="outline"
                size="lg"
                aria-pressed={selected}
                disabled={isSubmitting || (selectedCandidateKey !== null && !selected)}
                onClick={() => {
                  setSelectedCandidateKey(key);
                  void run({ kind: "worktree", candidate });
                }}
                className="min-h-8 w-full flex-col items-start gap-0.5 whitespace-normal py-1 text-left"
                data-project-sidebar-candidate={candidate.worktreePath}
              >
                <span className="flex w-full items-center gap-2">
                  <span className="truncate">
                    {candidate.isMainWorktree
                      ? intl.formatMessage({ id: "projectSidebar.mainCheckout" })
                      : candidate.head.kind === "branch"
                        ? candidate.head.ref
                        : intl.formatMessage({ id: "projectSidebar.detachedHead" })}
                  </span>
                  {candidate.locked ? (
                    <span className="shrink-0 text-ui-xs text-foreground-subtle">
                      {intl.formatMessage({ id: "projectSidebar.worktreeLocked" })}
                    </span>
                  ) : null}
                  {candidate.existingProject ? (
                    <span className="ml-auto shrink-0 text-ui-xs text-foreground-subtle">
                      {intl.formatMessage(
                        { id: "projectSidebar.addToProject" },
                        { project: candidate.existingProject.name },
                      )}
                    </span>
                  ) : null}
                </span>
                <span className="max-w-full truncate font-mono text-ui-xs text-foreground-subtle">
                  {candidate.worktreePath}
                </span>
              </Button>
            );
          })}
          <Button
            type="button"
            variant="ghost"
            size="lg"
            disabled={isSubmitting}
            onClick={() => {
              setSelectedCandidateKey(null);
              setCandidates([]);
              void run();
            }}
            className="min-h-8 w-full"
          >
            {intl.formatMessage({ id: "projectSidebar.discoverAgain" })}
          </Button>
        </div>
      ) : !bareCandidate ? (
        <Button
          type="submit"
          variant="default"
          size="lg"
          disabled={isSubmitting || !targetId || !targetOptions.some((item) => item.writable)}
          className="min-h-8"
        >
          {intl.formatMessage({ id: "projectSidebar.adopt" })}
        </Button>
      ) : null}
      {bareCandidate ? (
        <div className="space-y-2 rounded-lg border border-border p-2">
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "projectSidebar.bareRepositoryDetected" })}
          </p>
          <p className="break-all font-mono text-ui-xs text-foreground-subtlest">
            {bareCandidate.repositoryCommonDir}
          </p>
          <Button
            type="button"
            variant="default"
            size="lg"
            disabled={isSubmitting}
            onClick={() => void run({ kind: "bare-repository", candidate: bareCandidate })}
            className="min-h-8"
            data-project-sidebar-add-bare="true"
          >
            {intl.formatMessage({ id: "projectSidebar.adoptBareRepository" })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="lg"
            disabled={isSubmitting}
            onClick={() => {
              setBareCandidate(null);
              void run();
            }}
            className="min-h-8"
          >
            {intl.formatMessage({ id: "projectSidebar.discoverAgain" })}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
