// Trusted IPC projection: Model/SDK numeric facts plus provider field presence, never raw metadata.
const names = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
];
export function createPrivateUsage() {
  const calls = new Map();
  const dispatches = new Map();
  const reservations = new Map();
  function http(event) {
    if (
      !Number.isSafeInteger(event.count) ||
      event.count < 1 ||
      event.count > 12 ||
      (event.callId !== null && (!Number.isSafeInteger(event.callId) || !calls.has(event.callId)))
    )
      throw new Error("HTTP call correlation invalid");
    if (event.kind === "http") {
      if (reservations.has(event.count)) throw new Error("duplicate HTTP reservation");
      reservations.set(event.count, { callId: event.callId, dispatched: false });
    } else {
      const reserved = reservations.get(event.reservationId);
      if (!reserved || reserved.dispatched || reserved.callId !== event.callId)
        throw new Error("HTTP dispatch not bound to reservation");
      reserved.dispatched = true;
    }
  }
  function observe(message) {
    const { callId, operationKind, phase } = message;
    if (
      !Number.isSafeInteger(callId) ||
      callId < 1 ||
      callId > 12 ||
      !["generate", "stream"].includes(operationKind)
    )
      throw new Error("invalid Model observation identity");
    if (phase === "start") {
      if (calls.has(callId) || calls.size >= 12)
        throw new Error("duplicate Model call observation");
      const identity = (value) =>
        typeof value === "string" && value.length > 0 && value.length < 256 ? value : null;
      calls.set(callId, {
        callId,
        operationKind,
        purpose: identity(message.purpose),
        operationId: identity(message.operationId),
        runtimeTurnId: identity(message.runtimeTurnId),
        sessionId: identity(message.sessionId),
        phase: "start",
        metrics: null,
      });
      return;
    }
    const call = calls.get(callId);
    if (
      !call ||
      call.phase !== "start" ||
      call.operationKind !== operationKind ||
      !["finish", "error"].includes(phase)
    )
      throw new Error("Model observation lifecycle invalid");
    call.phase = phase;
    if (phase === "finish") {
      if (
        message.metrics === null ||
        typeof message.metrics !== "object" ||
        Array.isArray(message.metrics) ||
        Object.keys(message.metrics).some((name) => !names.includes(name))
      )
        throw new Error("Model metrics not allowlisted");
      call.metrics = Object.fromEntries(
        names.map((name) => {
          const value = message.metrics[name];
          if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
            throw new Error("invalid Model metric");
          return [
            name,
            { status: value === undefined ? "absent" : "reported", value: value ?? null },
          ];
        }),
      );
    }
  }
  function provider(fact) {
    if (
      !Number.isSafeInteger(fact.dispatchId) ||
      fact.dispatchId < 1 ||
      fact.dispatchId > 12 ||
      (fact.callId !== null && (!Number.isSafeInteger(fact.callId) || !calls.has(fact.callId))) ||
      fact.complete !== true ||
      !fact.metrics ||
      typeof fact.metrics !== "object" ||
      Array.isArray(fact.metrics) ||
      Object.entries(fact.metrics).some(
        ([name, value]) => !names.includes(name) || !Number.isSafeInteger(value) || value < 0,
      ) ||
      dispatches.has(fact.dispatchId)
    )
      throw new Error("provider usage observation invalid");
    dispatches.set(fact.dispatchId, { callId: fact.callId, metrics: fact.metrics });
  }
  function results(turns, sessionId) {
    const owners = new Map(
      turns.filter((turn) => turn.runtimeTurnId).map((turn) => [turn.runtimeTurnId, turn]),
    );
    const list = [...calls.values()].map((call) => {
      const owner = call.sessionId === sessionId ? owners.get(call.runtimeTurnId) : undefined;
      const observed = [...dispatches.values()].filter((item) => item.callId === call.callId);
      const source = observed.length === 1 ? observed[0].metrics : null;
      // 修复：SDK 可能为缺失 cache usage 合成 0、totalTokens 合成总数；
      // reported 只能来自真实 provider 字段，计算总数必须标记 derived。
      const metrics = Object.fromEntries(
        names.map((name) => {
          const value = source?.[name];
          if (
            value !== undefined &&
            call.metrics?.[name]?.value !== undefined &&
            call.metrics[name].value !== null &&
            call.metrics[name].value !== value
          )
            return [name, { status: "error-partial", value: null }];
          if (value !== undefined) return [name, { status: "reported", value }];
          if (
            name === "totalTokens" &&
            source &&
            source.inputTokens !== undefined &&
            source.outputTokens !== undefined
          )
            return [name, { status: "derived", value: source.inputTokens + source.outputTokens }];
          return [name, { status: source ? "absent" : "error-partial", value: null }];
        }),
      );
      return {
        callId: call.callId,
        operationKind: call.operationKind,
        purpose: call.purpose,
        operationIdPresent: call.operationId !== null,
        commandId: owner?.commandId ?? null,
        correlation: owner && source ? "native-command" : "unknown",
        coverage: call.phase === "finish" && source ? "finished" : "error-partial",
        httpReservations: [...reservations.values()].filter((item) => item.callId === call.callId)
          .length,
        httpDispatches: [...reservations.values()].filter(
          (item) => item.callId === call.callId && item.dispatched,
        ).length,
        metrics,
      };
    });
    const sum = (subset) =>
      Object.fromEntries(
        names.map((name) => {
          const all = subset.map((call) => call.metrics[name]);
          const reported = all.length > 0 && all.every((metric) => metric.status === "reported");
          const derived =
            all.length > 0 &&
            all.every((metric) => ["reported", "derived"].includes(metric.status));
          return [
            name,
            {
              status: reported
                ? "reported"
                : derived
                  ? "derived"
                  : all.length
                    ? "partial"
                    : "absent",
              value: derived ? all.reduce((total, metric) => total + metric.value, 0) : null,
            },
          ];
        }),
      );
    for (const turn of turns)
      turn.usage = sum(list.filter((call) => call.commandId === turn.commandId));
    const main = list.filter((call) => call.purpose === "agent_step");
    const auxiliary = list.filter((call) => call.purpose !== "agent_step");
    const coverage = (subset) =>
      subset.length === 0
        ? "absent"
        : subset.every(
              (call) =>
                call.correlation === "native-command" &&
                call.coverage === "finished" &&
                call.metrics.inputTokens.status === "reported" &&
                call.metrics.outputTokens.status === "reported",
            )
          ? "reported"
          : "partial";
    return {
      list,
      usage: sum(list),
      usageCoverage: { main: coverage(main), auxiliary: coverage(auxiliary) },
      httpCountAttribution: [...reservations.values()].every((item) => item.callId !== null)
        ? "model-call"
        : "partial",
    };
  }
  return {
    observe,
    provider,
    http,
    results,
    get count() {
      return calls.size;
    },
    get dispatchCount() {
      return dispatches.size;
    },
    get reservationCount() {
      return reservations.size;
    },
  };
}
