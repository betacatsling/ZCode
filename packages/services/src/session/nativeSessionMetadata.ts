import { isAbsolute, relative, sep } from "node:path";
import { ReadonlyNativeSessionMetadataView } from "@zcode/adapters/storage";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  parseModelSelectionValue,
  SESSION_ENTRY_MODEL_SELECTION,
  type SessionId,
  type SessionStorePort,
} from "@zcode/contracts";
import { modelBindingRequestSchema, type ModelBindingRequest } from "@zcode/shared/agent-host";

/** Native CLI session-store metadata, obtained through a public native-owner read API (no transcript copy). */
export interface NativeSessionMetadataReader {
  read(scope: { workspaceKey: string; workspacePath: string; nativeSessionId: string }): Promise<
    | {
        cwd: string;
        targetId: string;
        /** Explicit native workspaceID equals the task-index source scope; cwd alone is not attestation. */
        scopeVerified?: boolean;
        modelBinding?: ModelBindingRequest;
        /** A malformed explicit native selection must never fall back to the stale task-index model. */
        suppressIndexModelFallback?: boolean;
      }
    | undefined
  >;
}

/** Binds an already-open native session owner to the index, without opening/migrating its DB. */
export class NativeSessionStoreMetadataReader implements NativeSessionMetadataReader {
  constructor(
    private readonly store: Pick<SessionStorePort, "getSession" | "sessionEntries">,
    private readonly targetForScope: (scope: {
      workspaceKey: string;
      workspacePath: string;
      nativeSessionId: string;
    }) => Promise<string | undefined>,
  ) {}

  async read(scope: { workspaceKey: string; workspacePath: string; nativeSessionId: string }) {
    const sessionId = scope.nativeSessionId as SessionId;
    const session = await this.store.getSession(sessionId);
    if (!session || !isAbsolute(session.directory) || !isAbsolute(scope.workspacePath))
      return undefined;
    const child = relative(scope.workspacePath, session.directory);
    // 中文：迁移预览仍可读取缺 workspaceID 的旧 cwd，但在线目录只能接受显式 scopeVerified。
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) return undefined;
    if (session.workspaceID && session.workspaceID !== scope.workspaceKey) return undefined;
    if (!session.workspaceID && isRemoteWorkspaceIdentity(scope.workspaceKey)) return undefined;
    const targetId = await this.targetForScope(scope);
    if (!targetId) return undefined;
    const entries = await this.store.sessionEntries?.({
      sessionID: sessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
    });
    const lastSelection = entries?.at(-1);
    const parsed = lastSelection ? parseModelSelectionValue(lastSelection.data) : undefined;
    return {
      cwd: session.directory,
      targetId,
      scopeVerified: session.workspaceID === scope.workspaceKey,
      ...(parsed
        ? {
            modelBinding: modelBindingRequestSchema.parse({
              kind: "host-managed",
              selection: parsed,
            }),
          }
        : {}),
      ...(lastSelection && !parsed ? { suppressIndexModelFallback: true } : {}),
    };
  }
}

/** Node-side read-only metadata bridge; the configured DB path is resolved by native bootstrap before injection. */
export class NativeSqliteMetadataReader implements NativeSessionMetadataReader {
  constructor(
    private readonly view: ReadonlyNativeSessionMetadataView,
    private readonly targetForScope: (scope: {
      workspaceKey: string;
      workspacePath: string;
      nativeSessionId: string;
    }) => Promise<string | undefined>,
  ) {}

  async read(scope: { workspaceKey: string; workspacePath: string; nativeSessionId: string }) {
    const stored = await this.view.read(scope.nativeSessionId);
    if (!stored || !isAbsolute(stored.session.directory) || !isAbsolute(scope.workspacePath))
      return undefined;
    const child = relative(scope.workspacePath, stored.session.directory);
    // 中文：兼容缺 workspaceID 的迁移元数据，但无显式归属的目录 join 必须保持 pending。
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) return undefined;
    if (stored.session.workspaceID && stored.session.workspaceID !== scope.workspaceKey)
      return undefined;
    if (!stored.session.workspaceID && isRemoteWorkspaceIdentity(scope.workspaceKey))
      return undefined;
    const targetId = await this.targetForScope(scope);
    if (!targetId) return undefined;
    const parsed = stored.hasSelectionEntry
      ? parseModelSelectionValue(stored.lastSelection)
      : undefined;
    return {
      cwd: stored.session.directory,
      targetId,
      scopeVerified: stored.session.workspaceID === scope.workspaceKey,
      ...(parsed
        ? {
            modelBinding: modelBindingRequestSchema.parse({
              kind: "host-managed",
              selection: parsed,
            }),
          }
        : {}),
      ...(stored.hasSelectionEntry && !parsed ? { suppressIndexModelFallback: true } : {}),
    };
  }
}
