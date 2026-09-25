import { useEffect, useMemo } from "react";
import type { SessionOwner } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { usePairedPhoneConsent } from "@/hooks/usePairedPhoneConsent.js";

export function PairedPhoneConsent({ owner }: { owner: SessionOwner | null }) {
  const { pairing, error, enable, disable, available } = usePairedPhoneConsent();
  const selected =
    owner?.kind === "external" && !owner.scope.remoteSessionId && !owner.historyOnly ? owner : null;
  const selection = useMemo(
    () =>
      selected
        ? {
            targetId: selected.scope.targetId,
            workspaceId: selected.scope.workspaceId,
            hostSessionId: selected.spec.hostSessionId,
            workspacePath: selected.scope.workspacePath,
            workspaceIdentity: selected.scope.workspaceIdentity,
          }
        : null,
    [
      selected?.scope.targetId,
      selected?.scope.workspaceId,
      selected?.spec.hostSessionId,
      selected?.scope.workspacePath,
      selected?.scope.workspaceIdentity,
    ],
  );
  useEffect(
    () => () => {
      if (selection) void disable(selection);
    },
    [disable, selection],
  );
  if (!available || !selection) return null;
  return (
    <section
      aria-label="Paired phone"
      className="border-b border-border bg-surface px-3 py-2 text-ui-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span>Phone access (off until approved for this session)</span>
        <Button type="button" size="sm" variant="outline" onClick={() => void enable(selection)}>
          Approve phone
        </Button>
        {pairing ? (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => void disable(selection)}
          >
            Revoke phone
          </Button>
        ) : null}
      </div>
      {pairing ? (
        <div role="status" className="mt-2 break-all font-mono text-ui-xs">
          Loopback preview only: open {pairing.origin} in another browser on this computer and enter
          this one-use code: <span data-testid="paired-phone-code">{pairing.challenge}</span>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
