import { isAbsolute, relative, resolve, sep } from "node:path";
import { sessionHierarchyFileSchema } from "@zcode/shared/agent-host/session-hierarchy";
import type {
  AdoptedWorktreeLocator,
  ExternalSessionIndexPort,
  CurrentOwnerSessionIndexPort,
  ISessionHierarchyService,
  LegacySessionLocator,
  SessionIndexPort,
  WorktreeReadPort,
  WorktreeDiscoveryPortResult,
  SessionHierarchyPersistence,
  SessionHierarchyApplyRequest,
} from "../contract.js";
import { buildSessionHierarchyPreview } from "./migration.js";

export function createSessionHierarchyService(options: {
  index: SessionIndexPort;
  worktrees: WorktreeReadPort;
  external?: ExternalSessionIndexPort;
  currentOwners?: CurrentOwnerSessionIndexPort;
  persistence: SessionHierarchyPersistence;
  targetId: () => string;
  knownHarnessIds?: readonly string[];
}): ISessionHierarchyService {
  async function resolveLocators(
    locators: readonly LegacySessionLocator[],
  ): Promise<readonly LegacySessionLocator[]> {
    if (!options.worktrees.discover) return locators;
    const discoveries = new Map<string, Promise<WorktreeDiscoveryPortResult>>();
    return Promise.all(
      locators.map(async (locator) => {
        let discovery = discoveries.get(locator.workspacePath);
        if (!discovery) {
          discovery = options.worktrees.discover!(locator.workspacePath);
          discoveries.set(locator.workspacePath, discovery);
        }
        const resolvedDiscovery = await discovery;
        if (resolvedDiscovery.kind === "nonGit") {
          return {
            ...locator,
            resolutionStatus: resolvedDiscovery.reason === "missing-path" ? "missing" : "nonGit",
          } satisfies LegacySessionLocator;
        }
        const inputPath = resolve(locator.workspacePath);
        const candidates = resolvedDiscovery.candidates.filter((candidate) => {
          const remainder = relative(resolve(candidate.worktreePath), inputPath);
          return (
            remainder === "" ||
            (!remainder.startsWith(`..${sep}`) && remainder !== ".." && !isAbsolute(remainder))
          );
        });
        const candidate = candidates.sort(
          (left, right) => right.worktreePath.length - left.worktreePath.length,
        )[0];
        if (!candidate) return locator;
        return {
          ...locator,
          resolvedWorktreePath: candidate.worktreePath,
          ...(candidate.repositoryCommonDir
            ? { resolvedRepositoryCommonDir: candidate.repositoryCommonDir }
            : {}),
          cwd: locator.cwd ?? locator.workspacePath,
        } satisfies LegacySessionLocator;
      }),
    );
  }

  async function readSourceSnapshot(): Promise<{
    locators: readonly LegacySessionLocator[];
    workspaces: readonly AdoptedWorktreeLocator[];
  }> {
    const [locators, worktreeFile] = await Promise.all([
      options.index.listPersistedSessionLocators(),
      options.worktrees.read(),
    ]);
    const external = options.external
      ? await options.external.listPersistedExternalSessionLocators(worktreeFile.workspaces)
      : [];
    return {
      locators: await resolveLocators([...locators, ...external]),
      workspaces: worktreeFile.workspaces,
    };
  }

  return {
    async read() {
      const raw = await options.persistence.read();
      const persisted = raw === null ? null : sessionHierarchyFileSchema.parse(raw);
      if (!options.currentOwners) return persisted;

      const targetId = options.targetId().trim();
      if (!targetId) throw new Error("target-id-required");
      const worktreeFile = await options.worktrees.read();
      // 归档、缺失或移除只改变准入状态；持久 owner 仍须投影为只读历史。
      const workspaces = worktreeFile.workspaces;
      const locators = await options.currentOwners.listCurrentOwnerSessionLocators(workspaces);
      const ownerProjection = buildSessionHierarchyPreview(
        locators,
        workspaces,
        targetId,
        options.knownHarnessIds,
      );
      if (locators.length === 0) return persisted;

      const records = new Map<string, (typeof ownerProjection.records)[number]>();
      const keyOf = (record: (typeof ownerProjection.records)[number]) =>
        `${record.ownerKind}\0${record.targetId}\0${record.workspaceIdentity?.trim() || record.workspacePath}\0${record.nativeSessionId}`;
      for (const record of persisted?.records ?? []) records.set(keyOf(record), record);
      // Current owner facts supersede an older sidecar projection for the exact same owner locator.
      for (const record of ownerProjection.records) records.set(keyOf(record), record);
      return sessionHierarchyFileSchema.parse({
        schemaVersion: 1,
        source: persisted?.source ?? ownerProjection.source,
        records: [...records.values()],
      });
    },
    async preview() {
      const targetId = options.targetId().trim();
      if (!targetId) throw new Error("target-id-required");
      const { locators, workspaces } = await readSourceSnapshot();
      return buildSessionHierarchyPreview(locators, workspaces, targetId, options.knownHarnessIds);
    },
    async apply(request: SessionHierarchyApplyRequest) {
      const targetId = options.targetId().trim();
      if (!targetId) throw new Error("target-id-required");
      return options.persistence.update((raw) => {
        const current = raw === null ? null : sessionHierarchyFileSchema.parse(raw);
        return readSourceSnapshot().then(({ locators, workspaces }) => {
          const recomputed = buildSessionHierarchyPreview(
            locators,
            workspaces,
            targetId,
            options.knownHarnessIds,
          );
          if (
            recomputed.source.sourceKey !== request.source.sourceKey ||
            recomputed.source.fingerprint !== request.source.fingerprint ||
            recomputed.source.commandKey !== request.source.commandKey
          ) {
            throw new Error("stale-session-hierarchy-preview");
          }
          if (current?.source.commandKey === recomputed.source.commandKey) return current;
          if ((current?.source.commandKey ?? null) !== request.expectedCurrentRevision) {
            throw new Error("stale-session-hierarchy-baseline");
          }
          return recomputed;
        });
      });
    },
    async rollback(expectedCurrentRevision) {
      return options.persistence.rollback(expectedCurrentRevision);
    },
  };
}
