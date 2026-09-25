import { SCHEMA_VERSION, machine, configOf } from "./runner-fixture.mjs";

// Status is derived once from the persisted gates; this helper never promotes missing evidence.
export function decideLoadStatus(result, o, input) {
  if (result.comparison.status === "incomparable-baseline") return "baseline-incomparable";
  if (
    o.mode === "benchmark" &&
    input.driverFile &&
    result.metadata?.driverVersion === "contract-stub"
  )
    return "contract-stub-only";
  if (o.mode === "smoke") return input.baselinePath ? "baseline-incomparable" : "smoke-only";
  if (o.mode === "benchmark")
    return result.comparison.status === "within-budget"
      ? "latency-measured"
      : "latency-baseline-pending";
  return "load-measured-baseline-pending";
}

export function createLoadResult(o, root) {
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: o.mode,
    status: "failed",
    artifacts: root,
    machine,
    config: configOf(o),
    metadata: null,
    discovered: 0,
    expanded: 0,
    sessions: 0,
    committedEvents: 0,
    reconnects: 0,
    elapsedMs: 0,
    samples: {
      typedInputMs: [],
      sessionSwitchMs: [],
      sessionIds: [],
      elapsedMs: [],
      plannedAtMs: [],
    },
    measurement: null,
    p95: { typedInputMs: null, sessionSwitchMs: null },
    backlog: [],
    backlogSummary: null,
    memory: [],
    cleanup: null,
    comparison: { status: "missing-baseline" },
    gateway: { status: "unsupported" },
    unsupported: [
      "live-provider-latency-not-measured",
      "paid-provider-not-used",
      "ssh-not-used",
      "desktop-and-web-require-separate-runs",
    ],
    failures: [],
  };
}
