// Pure baseline decision; reads and provenance checks are supplied by the single runner owner.
export async function comparison(
  path,
  result,
  {
    readFile,
    hash,
    verifiedFiles,
    preservedSource,
    buildHash,
    inside,
    resolve,
    p95,
    validMeasurement,
    createHash,
    schemaVersion,
    latencyBudget,
  },
) {
  if (!path) return { status: "missing-baseline" };
  const base = JSON.parse(await readFile(path, "utf8"));
  if (base.schemaVersion !== schemaVersion)
    return { status: "incomparable-baseline", reason: "schema-mismatch" };
  if (result.mode !== "benchmark")
    return { status: "incomparable-baseline", reason: "mode-mismatch" };
  const a = base.metadata,
    b = result.metadata;
  if (!a || !b || JSON.stringify(a.runtime) !== JSON.stringify(b.runtime))
    return { status: "incomparable-baseline", reason: "runtime-mismatch" };
  if (
    !["latency-baseline-pending", "latency-measured"].includes(base.status) ||
    base.mode !== "benchmark" ||
    base.machine !== result.machine ||
    JSON.stringify(base.config) !== JSON.stringify(result.config) ||
    a.driverVersion !== b.driverVersion ||
    a.delivery !== b.delivery ||
    a.productionCommit === b.productionCommit ||
    a.driverSha256 !== b.driverSha256 ||
    a.driverFile !== b.driverFile ||
    JSON.stringify(a.supportFiles) !== JSON.stringify(b.supportFiles) ||
    !validMeasurement(base) ||
    !validMeasurement(result) ||
    JSON.stringify(base.measurement.plan) !== JSON.stringify(result.measurement.plan) ||
    (a.driverVersion !== "contract-stub" && (!a.buildPreparation || !b.buildPreparation)) ||
    !Number.isFinite(result.elapsedMs) ||
    result.elapsedMs < result.config.durationMs ||
    !Array.isArray(base.samples?.typedInputMs) ||
    !Array.isArray(base.samples?.sessionSwitchMs) ||
    !base.samples.typedInputMs.length ||
    base.samples.typedInputMs.length !== base.samples.sessionSwitchMs.length ||
    !result.samples.typedInputMs.length ||
    result.samples.typedInputMs.length !== result.samples.sessionSwitchMs.length ||
    !base.p95?.typedInputMs ||
    !base.p95?.sessionSwitchMs ||
    base.p95.typedInputMs !== p95(base.samples.typedInputMs) ||
    base.p95.sessionSwitchMs !== p95(base.samples.sessionSwitchMs) ||
    !base.samples.typedInputMs.every((x) => Number.isFinite(x) && x >= 0) ||
    !base.samples.sessionSwitchMs.every((x) => Number.isFinite(x) && x >= 0) ||
    !Number.isFinite(result.p95.typedInputMs) ||
    !Number.isFinite(result.p95.sessionSwitchMs) ||
    result.p95.typedInputMs !== p95(result.samples.typedInputMs) ||
    result.p95.sessionSwitchMs !== p95(result.samples.sessionSwitchMs)
  )
    return { status: "incomparable-baseline" };
  try {
    if (
      inside(resolve(base.artifacts), a.sourceCheckout) ||
      inside(resolve(base.artifacts), a.buildArtifactPath) ||
      inside(result.artifacts, b.sourceCheckout) ||
      inside(result.artifacts, b.buildArtifactPath) ||
      (a.driverFile && hash(await readFile(a.driverFile)) !== a.driverSha256) ||
      (b.driverFile && hash(await readFile(b.driverFile)) !== b.driverSha256) ||
      (a.supportFiles && !(await verifiedFiles(a.supportFiles))) ||
      (b.supportFiles && !(await verifiedFiles(b.supportFiles))) ||
      (await preservedSource(a.sourceCheckout, a.productionCommit)) !== a.sourceCheckout ||
      (await buildHash(a.buildArtifactPath)) !== a.buildSha256 ||
      (a.buildPreparation &&
        createHash("sha256")
          .update(await readFile(a.buildPreparation.manifestPath))
          .digest("hex") !== a.buildPreparation.manifestSha256) ||
      (await preservedSource(b.sourceCheckout, b.productionCommit)) !== b.sourceCheckout ||
      (await buildHash(b.buildArtifactPath)) !== b.buildSha256 ||
      (b.buildPreparation &&
        createHash("sha256")
          .update(await readFile(b.buildPreparation.manifestPath))
          .digest("hex") !== b.buildPreparation.manifestSha256)
    )
      return { status: "incomparable-baseline" };
  } catch {
    return { status: "incomparable-baseline" };
  }
  const typedInputRatio = result.p95.typedInputMs / base.p95.typedInputMs;
  const sessionSwitchRatio = result.p95.sessionSwitchMs / base.p95.sessionSwitchMs;
  if (!Number.isFinite(typedInputRatio) || !Number.isFinite(sessionSwitchRatio))
    return { status: "incomparable-baseline" };
  return {
    status:
      typedInputRatio > latencyBudget || sessionSwitchRatio > latencyBudget
        ? "over-budget"
        : "within-budget",
    baselineCommit: a.productionCommit,
    budget: latencyBudget,
    typedInputRatio,
    sessionSwitchRatio,
  };
}
