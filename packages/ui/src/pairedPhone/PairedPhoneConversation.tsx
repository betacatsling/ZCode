import type { IServiceAccessor, SessionOwner } from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { MountedExternalConversationProvider } from "@/v4/MountedExternalConversationProvider.js";
import { ExternalSessionPane } from "@/v4/ExternalSessionPane.js";

/** Existing production conversation pane over the authenticated, scoped public RPC client. */
export function PairedPhoneConversation({
  services,
  owner,
}: {
  services: IServiceAccessor;
  owner: Extract<SessionOwner, { kind: "external" }>;
}) {
  return (
    <ZCodeIntlProvider>
      <ServiceProvider services={services}>
        <TooltipProvider>
          <MountedExternalConversationProvider owner={owner}>
            <ExternalSessionPane paneId="paired-phone" owner={owner} />
          </MountedExternalConversationProvider>
        </TooltipProvider>
      </ServiceProvider>
    </ZCodeIntlProvider>
  );
}
