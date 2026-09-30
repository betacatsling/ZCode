import { memo } from "react";
import type { AgentModelFailure } from "@zcode/shared/agent-host";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import {
  openProviderReconfigureSettings,
  resolveProviderReconfigureNotice,
  type ProviderReconfigureNoticeModel,
} from "@/v4/providerReconfigureNotice.js";

export const PROVIDER_RECONFIGURE_NOTICE_TESTID = "v4-provider-reconfigure-notice";

/**
 * "Reconfigure this Provider" hint. Shows only the Provider display name (never its id, key,
 * or endpoint) and one action that opens that Provider's settings.
 */
export const ProviderReconfigureNotice = memo(function ProviderReconfigureNotice({
  notice,
  providerLabel,
  onOpenSettings,
  onDismiss,
  className,
}: {
  notice: ProviderReconfigureNoticeModel;
  /** Display name; when absent the copy stays generic instead of showing a raw id. */
  providerLabel?: string | null;
  onOpenSettings(providerId: string): void;
  onDismiss?(): void;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const label = providerLabel?.trim();
  return (
    <div
      role="alert"
      data-testid={PROVIDER_RECONFIGURE_NOTICE_TESTID}
      data-provider-id={notice.providerId}
      data-notice-source={notice.source}
      className={
        className ??
        "mb-3 flex w-full shrink-0 flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-ui-base text-foreground backdrop-blur-md"
      }
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {intl.formatMessage({ id: "chat.providerReconfigure.title" })}
        </p>
        <p className="text-foreground-subtle">
          {label
            ? intl.formatMessage(
                { id: "chat.providerReconfigure.messageNamed" },
                { provider: label },
              )
            : intl.formatMessage({ id: "chat.providerReconfigure.messageUnnamed" })}
        </p>
      </div>
      <button
        type="button"
        className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-primary-foreground hover:bg-primary/80"
        onClick={() => onOpenSettings(notice.providerId)}
      >
        {intl.formatMessage({ id: "chat.providerReconfigure.open" })}
      </button>
      {onDismiss ? (
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-1 text-foreground-subtle hover:bg-hover"
          onClick={onDismiss}
        >
          {intl.formatMessage({ id: "chat.providerReconfigure.dismiss" })}
        </button>
      ) : null}
    </div>
  );
});

/** Capability-driven variant for create forms: resolves the label and opens that Provider. */
export function CapabilityProviderReconfigureNotice({
  attention,
  providers,
}: {
  attention: AgentModelFailure | null | undefined;
  providers: readonly { providerId: string; providerName?: string | null }[] | undefined;
}) {
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const notice = resolveProviderReconfigureNotice({
    sessionId: null,
    capabilityAttention: attention,
  });
  if (!notice) return null;
  return (
    <ProviderReconfigureNotice
      notice={notice}
      providerLabel={
        providers?.find((provider) => provider.providerId === notice.providerId)?.providerName
      }
      onOpenSettings={(providerId) => openProviderReconfigureSettings(providerId, openSettingsTab)}
      className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-2 text-ui-xs text-foreground"
    />
  );
}
