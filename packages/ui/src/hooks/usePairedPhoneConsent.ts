import { useCallback, useState } from "react";
import { usePlatform } from "./usePlatform.js";

/** Renderer holds only the unsubmitted selection and the short-lived displayed pairing code. */
export function usePairedPhoneConsent() {
  const platform = usePlatform();
  const [pairing, setPairing] = useState<{ origin: string; challenge: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enable = useCallback(
    async (selection: {
      targetId: string;
      workspaceId: string;
      hostSessionId: string;
      workspacePath: string;
      workspaceIdentity: string;
    }) => {
      setError(null);
      if (!platform.pairedPhoneConsent) {
        setError("Paired phone is unavailable on this platform");
        return;
      }
      try {
        setPairing(await platform.pairedPhoneConsent("enable", selection));
      } catch {
        setPairing(null);
        setError("Could not authorize this session on the current Host");
      }
    },
    [platform],
  );
  const disable = useCallback(
    async (selection: {
      targetId: string;
      workspaceId: string;
      hostSessionId: string;
      workspacePath: string;
      workspaceIdentity: string;
    }) => {
      setPairing(null);
      try {
        await platform.pairedPhoneConsent?.("disable", selection);
      } catch {
        setError("Unable to revoke paired phone");
      }
    },
    [platform],
  );
  return { pairing, error, enable, disable, available: Boolean(platform.pairedPhoneConsent) };
}
