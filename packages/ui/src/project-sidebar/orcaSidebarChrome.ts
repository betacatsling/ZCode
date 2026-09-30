import type { HarnessDirectoryEntry } from "@/agent-host/HarnessIcon.js";
import type { OrcaSidebarCopy } from "./orcaSidebarCopy.js";

export interface OrcaSidebarChrome {
  copy: OrcaSidebarCopy;
  locale: string;
  now: number;
  appearance: "light" | "dark";
  directory: readonly HarnessDirectoryEntry[];
  assets?: Readonly<Record<string, string>>;
  query: string;
}
