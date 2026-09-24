import type { HarnessManifest } from "@zcode/shared/agent-host";
import type { SessionSummary, WorktreeWorkspace } from "@zcode/shared/project-workspaces";
import type { CatalogSessionIndex } from "../project-workspaces/sidebarIndexService.js";
import type { NativeSessionOwnerRef } from "./nativeSessionDirectory.js";

/** Metadata only. Native commands and live state remain in the existing V4 owner/lease transport. */
export const nativeZcodeManifest: HarnessManifest = {
  schemaVersion: 1,
  id: "zcode",
  name: "ZCode",
  adapterVersion: "native-v4",
  icon: { light: "zcode:logo-light", dark: "zcode:logo-dark" },
};

export interface NativeSessionNavigation {
  transport: "native-v4";
  treeSessionId: string;
  owner: NativeSessionOwnerRef;
}

/** A trusted UI/DI boundary; never convert treeSessionId into a V4 task ID. */
export interface NativeSessionCatalogPort extends CatalogSessionIndex {
  resolveOwner(input: {
    targetId: string;
    workspaceId: string;
    sourceWorkspaceKey: string;
    nativeSessionId: string;
  }): Promise<NativeSessionNavigation | undefined>;
}

/** Both sources are complete, not open-tab subsets. Upstream change notifications invalidate only. */
export class JoinedSessionIndex implements CatalogSessionIndex {
  constructor(
    private readonly native: CatalogSessionIndex,
    private readonly external: CatalogSessionIndex,
  ) {}

  onChange(listener: () => void): () => void {
    const detachNative = this.native.onChange?.(listener);
    const detachExternal = this.external.onChange?.(listener);
    return () => {
      detachNative?.();
      detachExternal?.();
    };
  }

  async allSessions(): Promise<readonly SessionSummary[]> {
    const [native, external] = await Promise.all([
      this.native.allSessions(),
      this.external.allSessions(),
    ]);
    const ids = new Set<string>();
    for (const { session } of [...native, ...external]) {
      if (ids.has(session.id)) throw new Error("duplicate-session-tree-id");
      ids.add(session.id);
    }
    return [...native, ...external];
  }

  async workspaceFreshness(workspace: WorktreeWorkspace) {
    const [native, external] = await Promise.all([
      this.native.workspaceFreshness(workspace),
      this.external.workspaceFreshness(workspace),
    ]);
    // Neither source may turn the other's stale/offline state into live or idle.
    if (native === "offline" || external === "offline") return "offline" as const;
    if (native === "stale" || external === "stale") return "stale" as const;
    if (native === "live" || external === "live") return "live" as const;
    return "unknown" as const;
  }
}
