import type { IntlInstance } from "@/i18n/IntlProvider.js";

const ERROR_MESSAGE_IDS: Readonly<Record<string, string>> = {
  "project-sidebar-services-unavailable": "projectSidebar.error.servicesUnavailable",
  "project-sidebar-worktree-service-unavailable": "projectSidebar.error.servicesUnavailable",
  "project-sidebar-target-offline": "projectSidebar.error.targetOffline",
  "project-sidebar-target-scope-mismatch": "projectSidebar.error.staleCandidate",
  "project-sidebar-input-required": "projectSidebar.error.inputRequired",
  "project-sidebar-discovery-nonGit": "projectSidebar.error.notGitRepository",
  "project-sidebar-discovery-missing-path": "projectSidebar.error.pathMissing",
  "project-sidebar-discovery-no-candidates": "projectSidebar.error.noCandidates",
  "project-sidebar-no-worktree-candidate": "projectSidebar.error.noCandidates",
  "project-sidebar-stale-candidate": "projectSidebar.error.staleCandidate",
  "project-sidebar-adoption-in-progress": "projectSidebar.error.adoptionInProgress",
  "project-sidebar-binding-project-missing": "projectSidebar.error.bindingProjectMissing",
};

export function formatProjectSidebarError(error: unknown, intl: IntlInstance): string {
  const detail = error instanceof Error ? error.message : String(error);
  const separatorIndex = detail.indexOf(":");
  const code = separatorIndex < 0 ? detail : detail.slice(0, separatorIndex);
  const values =
    code === "project-sidebar-binding-owned-by-another-project" && separatorIndex >= 0
      ? { project: detail.slice(separatorIndex + 1) }
      : undefined;
  const messageId =
    code === "invalid-base-ref"
      ? "projectSidebar.error.invalidBaseRef"
      : code === "project-sidebar-binding-owned-by-another-project"
        ? "projectSidebar.error.bindingOwned"
        : ERROR_MESSAGE_IDS[code];
  return messageId
    ? intl.formatMessage({ id: messageId }, values)
    : intl.formatMessage({ id: "projectSidebar.error.detail" }, { error: detail });
}
