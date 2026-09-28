import {
  projectCatalogTargetSnapshotSchema,
  projectRepositoryReferenceSchema,
  projectWorkspaceReferenceSchema,
} from "@zcode/shared/agent-host";
import type { SidebarFreshness } from "@zcode/shared/agent-host";
import {
  markTargetFreshnessInputSchema,
  projectCatalogFileSchema,
  projectCatalogProjectSchema,
  type IProjectCatalogService,
  type ProjectCatalogFile,
  type ProjectCatalogProject,
  type ProjectWorkspaceReference,
} from "../contract.js";

type Mutate = <T>(
  mutator: (current: ProjectCatalogFile) => { state: ProjectCatalogFile; result: T },
) => Promise<T>;

function referenceKey(targetId: string, workspaceId: string): string {
  return JSON.stringify([targetId, workspaceId]);
}

function requireProject(state: ProjectCatalogFile, id: string): ProjectCatalogProject {
  const project = state.projects.find((candidate) => candidate.id === id);
  if (!project) throw new Error(`unknown-project:${id}`);
  return project;
}

function withSessionFreshness(
  presentation: ProjectWorkspaceReference["presentation"],
  freshness: SidebarFreshness,
): ProjectWorkspaceReference["presentation"] {
  const summary = presentation?.sessionSummary;
  if (!presentation || !summary) return presentation;
  return {
    ...presentation,
    sessionSummary: {
      ...summary,
      freshness,
      sessions: summary.sessions.map((session) => ({ ...session, freshness })),
    },
  };
}

function targetStateSignature(file: ProjectCatalogFile, targetId: string): string {
  return JSON.stringify({
    target: file.targets.find((target) => target.targetId === targetId) ?? null,
    projects: file.projects
      .map((project) => ({
        projectId: project.id,
        repositoryReferences: project.repositoryReferences
          .filter((reference) => reference.targetId === targetId)
          .sort((left, right) => left.repositoryBindingId.localeCompare(right.repositoryBindingId)),
        workspaceReferences: project.workspaceReferences
          .filter((reference) => reference.targetId === targetId)
          .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)),
      }))
      .filter(
        (project) =>
          project.repositoryReferences.length > 0 || project.workspaceReferences.length > 0,
      )
      .sort((left, right) => left.projectId.localeCompare(right.projectId)),
  });
}

export function createTargetSnapshotMutations(
  mutate: Mutate,
): Pick<IProjectCatalogService, "ingestTargetSnapshot" | "markTargetFreshness"> {
  return {
    async ingestTargetSnapshot(rawSnapshot): Promise<ProjectCatalogFile> {
      const snapshot = projectCatalogTargetSnapshotSchema.parse(rawSnapshot);
      return mutate((current) => {
        const existingTarget = current.targets.find(
          (target) => target.targetId === snapshot.targetId,
        );
        if (
          snapshot.observedAt <
          Math.max(existingTarget?.lastVerifiedAt ?? 0, existingTarget?.freshnessUpdatedAt ?? 0)
        ) {
          throw new Error("stale-target-snapshot");
        }
        const projects = [...current.projects];
        const updateProject = (
          projectId: string,
          update: (project: ProjectCatalogProject) => ProjectCatalogProject,
        ): ProjectCatalogProject => {
          const index = projects.findIndex((project) => project.id === projectId);
          if (index < 0) throw new Error(`unknown-project:${projectId}`);
          const next = update(projects[index]!);
          projects[index] = next;
          return next;
        };

        for (const binding of snapshot.bindings) {
          requireProject(current, binding.projectId);
          const existingOwner = current.projects.find((project) =>
            project.repositoryReferences.some(
              (reference) =>
                reference.targetId === snapshot.targetId &&
                reference.repositoryBindingId === binding.id,
            ),
          );
          if (existingOwner && existingOwner.id !== binding.projectId) {
            throw new Error("repository-binding-project-mismatch");
          }
          const reference = projectRepositoryReferenceSchema.parse({
            projectId: binding.projectId,
            targetId: snapshot.targetId,
            repositoryBindingId: binding.id,
            lastVerifiedAt: snapshot.observedAt,
            targetFreshness: "live",
          });
          updateProject(binding.projectId, (project) =>
            projectCatalogProjectSchema.parse({
              ...project,
              repositoryReferences: [
                ...project.repositoryReferences.filter(
                  (item) =>
                    item.targetId !== snapshot.targetId || item.repositoryBindingId !== binding.id,
                ),
                reference,
              ],
            }),
          );
        }

        const summaries = new Map(
          snapshot.sessionSummaries.map((item) => [item.workspaceId, item]),
        );
        const incomingWorkspaceKeys = new Set<string>();
        for (const workspace of snapshot.workspaces) {
          requireProject(current, workspace.projectId);
          incomingWorkspaceKeys.add(referenceKey(snapshot.targetId, workspace.id));
          const existingOwner = current.projects.find((project) =>
            project.workspaceReferences.some(
              (reference) =>
                reference.targetId === snapshot.targetId && reference.workspaceId === workspace.id,
            ),
          );
          const existingReference = existingOwner?.workspaceReferences.find(
            (reference) =>
              reference.targetId === snapshot.targetId && reference.workspaceId === workspace.id,
          );
          if (existingOwner && existingOwner.id !== workspace.projectId) {
            throw new Error("workspace-reference-project-mismatch");
          }
          if (
            existingReference &&
            existingReference.repositoryBindingId !== workspace.repositoryBindingId
          ) {
            throw new Error("workspace-reference-binding-changed");
          }
          const suppliedSummary = summaries.get(workspace.id);
          updateProject(workspace.projectId, (project) => {
            const previous = project.workspaceReferences.find(
              (reference) =>
                reference.targetId === snapshot.targetId && reference.workspaceId === workspace.id,
            );
            if (workspace.verification !== "verified") {
              const reference = projectWorkspaceReferenceSchema.parse({
                projectId: workspace.projectId,
                targetId: snapshot.targetId,
                workspaceId: workspace.id,
                repositoryBindingId: workspace.repositoryBindingId,
                verification: "needsVerification",
                lastVerifiedAt: previous?.lastVerifiedAt ?? null,
                targetFreshness: "stale",
                presentation: withSessionFreshness(previous?.presentation ?? null, "stale"),
              });
              return projectCatalogProjectSchema.parse({
                ...project,
                workspaceReferences: [
                  ...project.workspaceReferences.filter(
                    (reference) =>
                      reference.targetId !== snapshot.targetId ||
                      reference.workspaceId !== workspace.id,
                  ),
                  reference,
                ],
              });
            }
            const presentation = {
              worktree: {
                title: workspace.title,
                head: workspace.head,
                isMainWorktree: workspace.isMainWorktree,
                lifecycle: workspace.lifecycle,
              },
              ...(suppliedSummary || previous?.presentation?.sessionSummary
                ? {
                    sessionSummary: suppliedSummary
                      ? {
                          verifiedAt: snapshot.observedAt,
                          freshness: "live",
                          sessions: suppliedSummary.sessions,
                          summary: suppliedSummary.summary,
                        }
                      : withSessionFreshness(previous!.presentation!, "stale")!.sessionSummary,
                  }
                : {}),
            };
            const reference = projectWorkspaceReferenceSchema.parse({
              projectId: workspace.projectId,
              targetId: snapshot.targetId,
              workspaceId: workspace.id,
              repositoryBindingId: workspace.repositoryBindingId,
              verification: "verified",
              lastVerifiedAt: snapshot.observedAt,
              targetFreshness: "live",
              presentation,
            });
            return projectCatalogProjectSchema.parse({
              ...project,
              workspaceReferences: [
                ...project.workspaceReferences.filter(
                  (item) =>
                    item.targetId !== snapshot.targetId || item.workspaceId !== workspace.id,
                ),
                reference,
              ],
            });
          });
        }

        for (let index = 0; index < projects.length; index += 1) {
          const project = projects[index]!;
          const repositoryReferences = project.repositoryReferences.map((reference) =>
            reference.targetId === snapshot.targetId &&
            !snapshot.bindings.some((binding) => binding.id === reference.repositoryBindingId)
              ? { ...reference, targetFreshness: "stale" as const }
              : reference,
          );
          const workspaceReferences = project.workspaceReferences.map((reference) =>
            reference.targetId === snapshot.targetId &&
            !incomingWorkspaceKeys.has(referenceKey(snapshot.targetId, reference.workspaceId))
              ? {
                  ...reference,
                  verification: "needsVerification" as const,
                  targetFreshness: "stale" as const,
                  presentation: withSessionFreshness(reference.presentation, "stale"),
                }
              : reference,
          );
          projects[index] = projectCatalogProjectSchema.parse({
            ...project,
            repositoryReferences,
            workspaceReferences,
          });
        }

        const state = projectCatalogFileSchema.parse({
          schemaVersion: 2,
          projects,
          targets: [
            ...current.targets.filter((target) => target.targetId !== snapshot.targetId),
            {
              targetId: snapshot.targetId,
              freshness: "live",
              lastVerifiedAt: Math.max(snapshot.observedAt, existingTarget?.lastVerifiedAt ?? 0),
              freshnessUpdatedAt: snapshot.observedAt,
              ...((snapshot.targetPresentation ?? existingTarget?.presentation)
                ? { presentation: snapshot.targetPresentation ?? existingTarget?.presentation }
                : {}),
            },
          ],
        });
        if (existingTarget?.freshnessUpdatedAt === snapshot.observedAt) {
          if (
            targetStateSignature(current, snapshot.targetId) ===
            targetStateSignature(state, snapshot.targetId)
          ) {
            return { state: current, result: current };
          }
          throw new Error("conflicting-target-snapshot-at-same-observation");
        }
        return { state, result: state };
      });
    },

    async markTargetFreshness(targetId, freshness, observedAt): Promise<ProjectCatalogFile> {
      const request = markTargetFreshnessInputSchema.parse({ targetId, freshness, observedAt });
      return mutate((current) => {
        const projects = current.projects.map((project) =>
          projectCatalogProjectSchema.parse({
            ...project,
            repositoryReferences: project.repositoryReferences.map((reference) =>
              reference.targetId === request.targetId
                ? { ...reference, targetFreshness: request.freshness }
                : reference,
            ),
            workspaceReferences: project.workspaceReferences.map((reference) =>
              reference.targetId === request.targetId
                ? {
                    ...reference,
                    targetFreshness: request.freshness,
                    presentation: withSessionFreshness(reference.presentation, request.freshness),
                  }
                : reference,
            ),
          }),
        );
        const existing = current.targets.find((target) => target.targetId === request.targetId);
        if (
          request.observedAt <
          Math.max(existing?.lastVerifiedAt ?? 0, existing?.freshnessUpdatedAt ?? 0)
        ) {
          throw new Error("stale-target-freshness-update");
        }
        if (existing?.freshnessUpdatedAt === request.observedAt) {
          if (existing.freshness === request.freshness) return { state: current, result: current };
          throw new Error("conflicting-target-freshness-at-same-observation");
        }
        const state = projectCatalogFileSchema.parse({
          schemaVersion: 2,
          projects,
          targets: [
            ...current.targets.filter((target) => target.targetId !== request.targetId),
            {
              targetId: request.targetId,
              freshness: request.freshness,
              lastVerifiedAt: existing?.lastVerifiedAt ?? null,
              freshnessUpdatedAt: request.observedAt,
              ...(existing?.presentation ? { presentation: existing.presentation } : {}),
            },
          ],
        });
        return { state, result: state };
      });
    },
  };
}
