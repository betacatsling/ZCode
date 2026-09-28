import { useEffect, useState } from "react";
import type { HarnessDirectoryEntry, HarnessDirectorySnapshot } from "@zcode/shared/agent-host";
import { useOptionalServices } from "@/hooks/useServices.js";

type HarnessDirectoryState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly directory: HarnessDirectorySnapshot }
  | { readonly status: "unavailable" };

export function useHarnessDirectoryEntry(harnessId: string): HarnessDirectoryEntry | undefined {
  const service = useOptionalServices()?.agentHostService ?? null;
  const [owned, setOwned] = useState<{
    readonly service: typeof service;
    readonly harnessId: string;
    readonly state: HarnessDirectoryState;
  }>(() => ({ service, harnessId, state: { status: "loading" } }));
  const matches = owned.service === service && owned.harnessId === harnessId;

  useEffect(() => {
    let current = true;
    if (!service) {
      setOwned({ service, harnessId, state: { status: "unavailable" } });
      return () => {
        current = false;
      };
    }
    setOwned({ service, harnessId, state: { status: "loading" } });
    void service.getDirectory().then(
      (directory) => {
        if (current) setOwned({ service, harnessId, state: { status: "ready", directory } });
      },
      () => {
        if (current) setOwned({ service, harnessId, state: { status: "unavailable" } });
      },
    );
    return () => {
      current = false;
    };
  }, [service, harnessId]);

  if (!matches || owned.state.status !== "ready") return undefined;
  return owned.state.directory.entries.find((entry) => entry.manifest.id === harnessId);
}
