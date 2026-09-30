import { Button } from "@/components/ui/button.js";
import type { OrcaSidebarCopy } from "./orcaSidebarCopy.js";

export interface DiscoveredWorktreeCandidate {
  id: string;
  path: string;
  isMainWorktree: boolean;
  headLabel: string;
}

export function DiscoveredWorktreesDialog({
  open,
  projectName,
  candidates,
  copy,
  onAdopt,
  onClose,
}: {
  open: boolean;
  projectName: string;
  candidates: readonly DiscoveredWorktreeCandidate[];
  copy: OrcaSidebarCopy;
  onAdopt: (candidateId: string) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <section
      role="dialog"
      aria-label={copy.manage}
      data-discovered-dialog={projectName}
      className="space-y-2 rounded-xl border border-popover-border bg-popover p-3"
    >
      <ul className="space-y-1">
        {candidates.map((candidate) => (
          <li
            key={candidate.id}
            data-discovered-id={candidate.id}
            className="flex items-center gap-2 rounded-md px-1 py-1"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-ui-xs text-foreground-subtle">
              {candidate.path}
            </span>
            <span className="shrink-0 text-ui-xs text-foreground-subtlest">
              {candidate.headLabel}
            </span>
            {candidate.isMainWorktree ? (
              <span className="shrink-0 text-ui-xs text-foreground-subtle">
                {copy.mainCheckout}
              </span>
            ) : null}
            <Button
              type="button"
              variant="outline"
              onClick={() => onAdopt(candidate.id)}
              className="min-h-9 md:min-h-8"
            >
              {copy.adopt}
            </Button>
          </li>
        ))}
      </ul>
      <Button type="button" variant="ghost" onClick={onClose} className="min-h-9 md:min-h-8">
        {copy.cancel}
      </Button>
    </section>
  );
}
