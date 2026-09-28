import { createContext, useContext, type ReactNode } from "react";

const HarnessIdentityContext = createContext<string | null>(null);

export function HarnessIdentityProvider({
  harnessId,
  children,
}: {
  harnessId: string;
  children: ReactNode;
}) {
  return (
    <HarnessIdentityContext.Provider value={harnessId}>{children}</HarnessIdentityContext.Provider>
  );
}

/** Native V4 is the default owner; an AgentHost route supplies its manifest ID explicitly. */
export function useHarnessIdentity(): string {
  return useContext(HarnessIdentityContext) ?? "zcode";
}
