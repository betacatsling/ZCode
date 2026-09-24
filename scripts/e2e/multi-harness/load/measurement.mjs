// 中文：不同会话群体、轮次或时间窗的 p95 不可比，不能让快采样冒充生产回归。
export function validMeasurement(run) {
  const plan = run.measurement?.plan;
  if (!plan || !Number.isSafeInteger(plan.rounds) || plan.rounds < 20 ||
    !Array.isArray(plan.sessionIds) || plan.sessionIds.length !== run.config?.sessionCount ||
    new Set(plan.sessionIds).size !== plan.sessionIds.length ||
    !plan.sessionIds.every((id,i)=>id === `synthetic-${i}`)) return false;
  const expected = (plan.rounds + 1) * plan.sessionIds.length;
  if (run.samples?.sessionIds?.length !== expected || run.samples?.plannedAtMs?.length !== expected ||
    run.samples?.typedInputMs?.length !== expected || run.samples?.sessionSwitchMs?.length !== expected) return false;
  const slotMs = run.config.durationMs / plan.rounds;
  if (!Number.isFinite(slotMs) || slotMs <= 0 || plan.slotMs !== slotMs) return false;
  for (let round=0;round<=plan.rounds;round++) for (let i=0;i<plan.sessionIds.length;i++) {
    const index=round*plan.sessionIds.length+i, due=round*slotMs;
    if (run.samples.sessionIds[index] !== plan.sessionIds[i] || run.samples.plannedAtMs[index] !== due ||
      !Number.isFinite(run.samples.elapsedMs[index]) || run.samples.elapsedMs[index] < due ||
      run.samples.elapsedMs[index] > due + slotMs) return false;
  }
  const m = run.measurement, samples = run.samples;
  return m && m.datasetId === run.config?.benchmarkDatasetId && m.windowMs === run.config?.durationMs &&
    m.startedAtElapsedMs === 0 && Number.isFinite(m.endedAtElapsedMs) &&
    m.endedAtElapsedMs === run.elapsedMs && run.elapsedMs >= m.windowMs &&
    Array.isArray(samples?.elapsedMs) && samples.elapsedMs.length > 0 &&
    samples.elapsedMs.length === samples.typedInputMs?.length &&
    samples.elapsedMs.at(-1) >= m.windowMs &&
    samples.elapsedMs.every((t,i) => Number.isFinite(t) && t >= 0 && t <= m.endedAtElapsedMs && (i === 0 || t >= samples.elapsedMs[i-1]));
}
