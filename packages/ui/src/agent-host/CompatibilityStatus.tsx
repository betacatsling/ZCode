import type { CapabilityReport } from "./SessionCapabilities.js";
import { admitsExecution } from "./SessionCapabilities.js";

export function CompatibilityStatus({
  requestedLabel,
  effectiveLabel,
  report,
  copy,
}: {
  requestedLabel: string;
  effectiveLabel?: string;
  report: CapabilityReport;
  copy: {
    requested: (label: string) => string;
    effective: (label: string) => string;
    mismatch: string;
    support: Record<CapabilityReport["support"], string>;
  };
}) {
  const mismatch = Boolean(effectiveLabel && effectiveLabel !== requestedLabel);
  const executable = admitsExecution(report);
  return (
    <div
      role="status"
      data-compatibility-status={report.support}
      data-compatibility-mismatch={mismatch ? "true" : "false"}
      data-compatibility-executable={executable ? "true" : "false"}
      className="space-y-1 rounded-md bg-surface px-2 py-2 text-ui-sm text-foreground"
    >
      <p>{copy.requested(requestedLabel)}</p>
      {effectiveLabel ? (
        <p className="text-foreground-subtle">{copy.effective(effectiveLabel)}</p>
      ) : null}
      <p className={executable ? "text-foreground-subtle" : "text-warning"}>
        {copy.support[report.support]}
      </p>
      {report.reason ? <p className="text-ui-xs text-foreground-subtle">{report.reason}</p> : null}
      {mismatch ? <p className="text-ui-xs text-warning">{copy.mismatch}</p> : null}
    </div>
  );
}
