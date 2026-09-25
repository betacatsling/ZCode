import { useMemo } from "react";
import { TID_V4_SESSION_PANE, testId } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useExternalSessionController } from "@/v4/useExternalSessionController.js";
import { canLoadExternalNewer, canLoadExternalOlder } from "@/v4/conversationProjectionStore.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import { ConversationHeader, type PaneWorkspaceBadge } from "@/v4/ConversationHeader.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import type { MountedSessionOwner } from "@/v4/mountedSessionOwner.js";

export interface ExternalSessionPaneProps {
  paneId: string;
  owner: Extract<MountedSessionOwner, { kind: "external" }>;
  readOnly?: boolean;
  workspaceBadge?: PaneWorkspaceBadge;
  onClosePane?: () => void;
}

const externalLabels = {
  en: {
    send: "Send",
    stop: "Stop",
    allow: "Allow",
    deny: "Deny",
    history: "History only",
    unavailable: "Unavailable",
    pending: "Outcome unknown; check Host before a new command",
    check: "Check status",
    storageUnavailable: "Command recovery storage unavailable; send disabled",
    model: "Model",
    requested: "Requested",
    effective: "Effective",
    unknownModel: "unknown",
    loading: "Loading session…",
    older: "Load earlier messages",
    newer: "Load newer messages",
    latest: "Latest messages",
    window: (first: number, last: number, total: number) => `Rows ${first}–${last} of ${total}`,
    usage: {
      inputTokens: "Input",
      outputTokens: "Output",
      cacheReadTokens: "Cache read",
      cacheWriteTokens: "Cache write",
    },
  },
  zh: {
    send: "发送",
    stop: "停止",
    allow: "允许",
    deny: "拒绝",
    history: "仅查看历史",
    unavailable: "不可用",
    pending: "结果未知；发送新命令前请向 Host 核对",
    check: "核对状态",
    storageUnavailable: "无法保存命令恢复线索；已禁止发送",
    model: "模型",
    requested: "请求",
    effective: "实际",
    unknownModel: "未知",
    loading: "正在加载会话…",
    older: "加载更早消息",
    newer: "加载较新消息",
    latest: "最新消息",
    window: (first: number, last: number, total: number) =>
      `第 ${first}–${last} 行，共 ${total} 行`,
    usage: {
      inputTokens: "输入",
      outputTokens: "输出",
      cacheReadTokens: "缓存读取",
      cacheWriteTokens: "缓存写入",
    },
  },
} as const;

/** One mounted pane. Host remains the only owner of commands, rows, approvals and execution. */
export function ExternalSessionPane({
  paneId,
  owner,
  readOnly,
  workspaceBadge,
  onClosePane,
}: ExternalSessionPaneProps) {
  const { spec, scope, historyOnly } = owner;
  const { locale } = useZCodeIntl();
  const labels = externalLabels[locale === "zh-CN" ? "zh" : "en"];
  const {
    lease,
    state,
    snapshot,
    catalog,
    iconAssets,
    draft,
    updateDraft,
    inFlight,
    error,
    pendingMarker,
    reconcile,
    canSend,
    canCancel,
    canApprove,
    activeTurn,
    send,
    stop,
    decide,
    capabilities,
  } = useExternalSessionController({
    owner,
    readOnly,
    storageUnavailable: labels.storageUnavailable,
  });
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  const requestedModel =
    spec.modelBinding.kind === "host-managed"
      ? `${spec.modelBinding.selection.providerId} / ${spec.modelBinding.selection.modelId}`
      : (spec.modelBinding.nativeModelId ?? labels.unknownModel);
  const effectiveModel = snapshot?.config.model
    ? `${snapshot.config.provider || labels.unknownModel} / ${snapshot.config.model}`
    : labels.unknownModel;
  const model = `${labels.requested}: ${requestedModel} · ${labels.effective}: ${effectiveModel}`;
  const rowContext = useMemo(
    () => ({
      workspacePath: scope.workspacePath,
      workspaceIdentity: scope.workspaceIdentity,
      workspaceRemoteSessionId: scope.remoteSessionId,
      sessionId: spec.hostSessionId,
      logEpoch: snapshot?.logEpoch,
      theme,
      codePreviewSettings,
    }),
    [scope, spec.hostSessionId, snapshot?.logEpoch, theme, codePreviewSettings],
  );
  const iconTheme =
    theme === "dark" ||
    theme === "zai-dark" ||
    (theme === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches)
      ? "dark"
      : "light";
  return (
    <div
      data-testid={testId(TID_V4_SESSION_PANE, paneId)}
      data-session-id={spec.hostSessionId}
      data-harness={spec.harness.id}
      data-projection-seq={snapshot?.seq}
      data-historical-revision={snapshot?.rows.historicalRevision}
      data-history-browsing={state.externalHistoryBrowsing ? "true" : "false"}
      className="relative flex h-full min-h-0 flex-col bg-background text-foreground"
    >
      <ConversationHeader
        title={snapshot?.meta.title ?? spec.harness.id}
        onClosePane={onClosePane}
        workspaceBadge={workspaceBadge}
        harness={{
          id: spec.harness.id,
          catalog,
          resolveIconAsset: (id) => iconAssets.get(id),
          theme: iconTheme,
          model,
        }}
      />
      {snapshot?.usage.measured && (
        <div
          aria-label={locale === "zh-CN" ? "累计令牌计量" : "Cumulative token usage"}
          className="flex flex-wrap gap-2 px-3 text-ui-xs text-foreground-subtle"
        >
          {(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const).map(
            (field) => (
              <span
                key={field}
                data-testid={`usage-${field}`}
                data-measured={snapshot.usage.measured?.[field] ? "true" : "false"}
              >
                {labels.usage[field]}:{" "}
                {snapshot.usage.measured?.[field]
                  ? snapshot.usage.cumulative[field].toLocaleString(locale)
                  : "—"}
              </span>
            ),
          )}
        </div>
      )}
      {(canLoadExternalOlder(snapshot) || canLoadExternalNewer(snapshot)) && (
        <div className="flex flex-wrap items-center gap-2 px-3 pt-8">
          {state.externalHistoryBrowsing && snapshot?.rows.window.length ? (
            <span
              data-testid="external-history-range"
              className="text-ui-xs text-foreground-subtle"
            >
              {labels.window(
                snapshot.rows.window[0]!.rowId,
                snapshot.rows.window.at(-1)!.rowId,
                snapshot.rows.totalCount,
              )}
            </span>
          ) : null}
          {canLoadExternalOlder(snapshot) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={state.loadingOlder}
              onClick={() => void lease?.store.loadOlder()}
            >
              {labels.older}
            </Button>
          )}
          {canLoadExternalNewer(snapshot) && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={state.loadingOlder}
                onClick={() => void lease?.store.loadNewer()}
              >
                {labels.newer}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void lease?.store.jumpToLatest()}
              >
                {labels.latest}
              </Button>
            </>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 pt-8">
        {state.status === "error" ? (
          <div role="alert" className="p-4 text-ui-sm text-destructive">
            {state.lastError ?? labels.unavailable}{" "}
            <Button type="button" variant="outline" onClick={() => void lease?.store.connect()}>
              {labels.loading}
            </Button>
          </div>
        ) : (
          <ConversationTimeline
            rows={snapshot?.rows.window ?? []}
            totalCount={snapshot?.rows.totalCount ?? 0}
            sessionKey={spec.hostSessionId}
            rowContext={rowContext}
            // 原因：浏览旧页时虚拟列表顶部仍可见，自动预取会把用户刚点的“较新”页立刻拉回旧页；
            // 浏览态只保留上方显式“更早”按钮，不新增计时器或第二份游标。
            canLoadOlder={canLoadExternalOlder(snapshot) && !state.externalHistoryBrowsing}
            loadingOlder={state.loadingOlder}
            onLoadOlder={() => lease?.store.loadOlder()}
          />
        )}
      </div>
      {snapshot?.pendingInteractions
        .filter((item) => item.kind === "permission")
        .map((item) => (
          <div
            key={item.interactionId}
            data-testid={`external-approval-${item.interactionId}`}
            className="flex flex-wrap items-center gap-2 border-t border-border bg-surface p-3 text-ui-sm"
          >
            <span>
              {item.payload.kind === "permission"
                ? (item.payload.toolName ?? item.interactionId)
                : item.interactionId}
            </span>
            {(["allow", "deny"] as const).map((decision) => (
              <Button
                key={decision}
                type="button"
                size="sm"
                variant={decision === "deny" ? "outline" : "default"}
                disabled={!canApprove || inFlight || !activeTurn}
                title={capabilities?.approvals.reason ?? (historyOnly ? labels.history : undefined)}
                onClick={() => void decide(item.interactionId, decision)}
              >
                {labels[decision]}
              </Button>
            ))}
            {!canApprove ? (
              <span>{capabilities?.approvals.reason ?? labels.unavailable}</span>
            ) : null}
          </div>
        ))}
      <div className="border-t border-border bg-surface p-3">
        {error ? (
          <p role="alert" className="mb-2 text-ui-sm text-destructive">
            {error}
          </p>
        ) : null}
        {historyOnly ? <p className="text-ui-sm text-foreground-subtle">{labels.history}</p> : null}
        {pendingMarker ? (
          <p
            role="status"
            className="mb-2 flex items-center gap-2 text-ui-sm text-foreground-subtle"
          >
            {labels.pending}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={inFlight}
              onClick={() => void reconcile()}
            >
              {labels.check}
            </Button>
          </p>
        ) : null}
        {/* 归档/失联会话的 owner 是 historyOnly：不渲染可执行入口，避免把"禁用但可点"
            的 composer 当成可发送能力；只读历史与上面的归档提示保留。 */}
        {!historyOnly ? (
          <div className="flex gap-2">
            <textarea
              aria-label="Message"
              data-testid={`external-draft-${paneId}`}
              className="min-h-9 min-w-0 flex-1 rounded-lg border border-input-border bg-input p-2 text-ui-base text-foreground max-sm:text-mobile-input-safe"
              value={draft}
              onChange={(event) => updateDraft(event.target.value)}
              disabled={!canSend || inFlight}
              title={!canSend ? (capabilities?.text.reason ?? labels.unavailable) : undefined}
            />
            <Button
              type="button"
              disabled={!canSend || !draft.trim() || inFlight || !snapshot}
              title={!canSend ? (capabilities?.text.reason ?? labels.unavailable) : undefined}
              onClick={() => void send()}
            >
              {labels.send}
            </Button>
            {activeTurn ? (
              <Button
                type="button"
                variant="outline"
                disabled={!canCancel || inFlight}
                title={
                  !canCancel ? (capabilities?.cancelTurn.reason ?? labels.unavailable) : undefined
                }
                onClick={() => void stop()}
              >
                {labels.stop}
              </Button>
            ) : null}
          </div>
        ) : null}
        <p className="mt-1 text-ui-xs text-foreground-subtle">
          {labels.model}: {model}
        </p>
      </div>
    </div>
  );
}
