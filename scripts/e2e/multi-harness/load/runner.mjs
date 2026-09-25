import { tmpdir } from "node:os";
import { mkdtemp, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { validMeasurement } from "./measurement.mjs";
import { validateProductFacts, checkSample } from "./facts.mjs";
export { validateProductFacts } from "./facts.mjs";
import {
  createFixture,
  isolation,
  validateOptions,
  inside,
  hash,
  runtime,
  metadataCheck,
  p95,
} from "./runner-fixture.mjs";
export { createFixture, isolation, validateOptions } from "./runner-fixture.mjs";
import {
  verifiedFiles,
  verifiedProvenance,
  buildHash,
  preservedSource,
  comparison,
} from "./runner-provenance.mjs";
import { applyIsolation, cleanupRegistry, prepareArtifactBase } from "./runner-lifecycle.mjs";
export { applyIsolation, isolatedEnvironment, prepareArtifactBase } from "./runner-lifecycle.mjs";
import { createLoadResult, decideLoadStatus } from "./runner-result.mjs";

const CLEANUP_DEADLINE_MS = 750;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function runLoad(input = {}) {
  const o = validateOptions(input);
  if (
    !input.driver ||
    typeof input.driver.open !== "function" ||
    typeof input.driver.dispose !== "function"
  )
    throw new Error("production driver with top-level disposer required");
  if (o.mode === "acceptance" && input.isolateProcessEnv !== true)
    throw new Error("acceptance requires isolated launch environment");
  const base = resolve(input.artifactBase ?? tmpdir());
  // 中文：驱动可能来自另一 checkout，仅核对 cwd 会将工件写进被测源码树。
  const driverCheckout = input.driver.sourceCheckout
    ? await realpath(input.driver.sourceCheckout)
    : null;
  if (driverCheckout && (inside(driverCheckout, base) || inside(base, driverCheckout)))
    throw new Error("artifact base must be outside driver checkout");
  const baseReal = await prepareArtifactBase(base);
  const root = await mkdtemp(join(baseReal, "load-"));
  const paths = await isolation(root);
  if (input.isolateProcessEnv) applyIsolation(paths);
  const result = createLoadResult(o, root);
  let mount,
    start,
    startingEvents = 0,
    phase = "fixture";
  const cleanup = cleanupRegistry(input.driver);
  const takeFacts = async (phase) => {
    const facts = validateProductFacts(await mount.facts(), { mode: o.mode, phase });
    if (facts.backlogHighWater > o.maxBacklog || facts.childProcesses > o.maxOwnedChildren)
      throw new Error("owner backlog/process bound exceeded");
    result.backlog.push({
      phase,
      elapsedMs: start ? performance.now() - start : 0,
      count: facts.backlog,
      highWater: facts.backlogHighWater,
    });
    result.memory.push({
      phase,
      elapsedMs: start ? performance.now() - start : 0,
      heapBytes: facts.heapBytes,
      rssBytes: facts.rssBytes,
      processes: facts.processes ?? null,
      childProcesses: facts.childProcesses,
    });
    return facts;
  };
  try {
    const fixture = await createFixture(root, o.worktreeCount);
    phase = "driver-open";
    mount = await input.driver.open({
      root,
      repo: fixture.repo,
      worktrees: fixture.worktrees,
      artifacts: root,
      isolation: paths,
      mode: o.mode,
      delivery: o.delivery,
      sourceCheckout: input.sourceCheckout,
      buildArtifactPath: input.buildArtifactPath,
      registerCleanup: cleanup.registerCleanup,
      registerChild: cleanup.registerChild,
    });
    for (const name of [
      "discover",
      "mount",
      "emit",
      "sample",
      "detach",
      "reconnect",
      "facts",
      "close",
    ])
      if (typeof mount?.[name] !== "function") throw new Error(`missing production hook ${name}`);
    metadataCheck(mount.metadata, paths, o.mode);
    result.metadata = {
      productionCommit: mount.metadata.productionCommit,
      driverVersion: mount.metadata.driverVersion,
      runtime,
      driverFile: input.driverFile ?? null,
      driverSha256: input.driverSha256 ?? null,
      supportFiles: input.supportFiles ?? null,
    };
    if (
      input.driverFile &&
      ((await realpath(input.driverFile)) !== input.driverFile ||
        hash(await readFile(input.driverFile)) !== input.driverSha256 ||
        !(await verifiedFiles(input.supportFiles)))
    )
      throw new Error("driver/support source changed");
    if (
      input.driver.sourceCheckout &&
      input.sourceCheckout &&
      (await realpath(input.driver.sourceCheckout)) !== (await realpath(input.sourceCheckout))
    )
      throw new Error("driver checkout differs from selected source");
    // Smoke stubs remain incomparable unless both independently verified sources are provided.
    if (input.sourceCheckout || input.buildArtifactPath || o.mode === "acceptance") {
      phase = "source-provenance";
      Object.assign(
        result.metadata,
        await verifiedProvenance(
          input.sourceCheckout,
          input.buildArtifactPath,
          mount.metadata.productionCommit,
          root,
          input.buildProvenancePath,
          mount.metadata.driverVersion,
        ),
      );
      if (
        mount.metadata.driverVersion !== "contract-stub" &&
        (!input.driverFile || !inside(result.metadata.sourceCheckout, input.driverFile))
      )
        throw new Error("production driver is outside selected checkout");
    }
    phase = "discovery";
    const discovered = await mount.discover({ repo: fixture.repo, candidates: fixture.worktrees });
    if (
      !Array.isArray(discovered) ||
      discovered.length !== o.worktreeCount ||
      new Set(discovered.map((c) => c.id)).size !== discovered.length ||
      fixture.worktrees.some((w) => !discovered.some((c) => c.path === w))
    )
      throw new Error("production discovery did not return real candidates");
    result.discovered = discovered.length;
    const expanded = discovered.slice(0, o.expandedCount);
    const sessions = Array.from({ length: o.sessionCount }, (_, i) => ({
      id: `synthetic-${i}`,
      workspaceId: expanded[i % expanded.length].id,
    }));
    phase = "mount";
    const mounted = await mount.mount({ expandedWorktrees: expanded, sessions });
    if (
      JSON.stringify(mounted?.mountedSurfaces) !==
        JSON.stringify(["Shell", "ProjectSidebar", "SessionPane"]) ||
      mounted.owner !== "durable-host" ||
      mounted.delivery !== o.delivery
    )
      throw new Error("real mounted Shell/ProjectSidebar/SessionPane + durable Host required");
    if (
      o.mode === "acceptance" &&
      ["shellVisible", "sidebarVisible", "paneVisible", "hostJournalReopened"].some(
        (key) => mounted.mountEvidence?.[key] !== true,
      )
    )
      throw new Error("missing mounted product evidence");
    result.metadata.delivery = mounted.delivery;
    result.expanded = expanded.length;
    result.sessions = sessions.length;
    startingEvents = (await takeFacts("start")).durableEvents;
    start = performance.now();
    let nextSample = 0,
      nextReconnect = o.reconnectEveryMs;
    const plannedIds = sessions.map((s) => s.id);
    const rounds = Math.max(20, Math.ceil(o.durationMs / o.sampleEveryMs));
    const slotMs = o.durationMs / rounds;
    let nextRound = 0;
    const plannedSample = async (round) => {
      const due = round * slotMs;
      while (performance.now() - start < due)
        await sleep(Math.max(1, Math.ceil(due - (performance.now() - start))));
      for (const sessionId of plannedIds) {
        phase = "mounted-sample";
        const sampledAt = performance.now() - start;
        const sample = await mount.sample({ sessionId });
        checkSample(sample);
        result.samples.sessionIds.push(sessionId);
        result.samples.plannedAtMs.push(due);
        result.samples.elapsedMs.push(sampledAt);
        result.samples.typedInputMs.push(sample.typedInputMs);
        result.samples.sessionSwitchMs.push(sample.sessionSwitchMs);
      }
      await takeFacts("sample");
    };
    for (let i = 0; result.committedEvents < o.eventCount; i++) {
      const due = (o.durationMs * Math.min(result.committedEvents, o.eventCount)) / o.eventCount;
      // 中文：先执行本时段的计划采样；不能让事件等待跨过采样窗，再补写过期时间戳。
      if (o.mode !== "smoke")
        while (nextRound < rounds && nextRound * slotMs <= due) await plannedSample(nextRound++);
      const remaining = due - (performance.now() - start);
      if (remaining > 1) await sleep(remaining);
      const session = sessions[i % sessions.length];
      phase = "emit";
      const emitted = await mount.emit({ sessionId: session.id, eventId: `synthetic-event-${i}` });
      const committed = emitted?.committedEvents;
      // 中文：Host 驱动返回其真实 owner 序列增量；旧契约夹具未提供时只计一次驱动调用。
      result.committedEvents += Number.isSafeInteger(committed) && committed > 0 ? committed : 1;
      const elapsed = performance.now() - start;
      if (o.mode === "smoke" && elapsed >= nextSample) {
        phase = "mounted-sample";
        const sampledId = sessions[result.samples.sessionIds.length % sessions.length].id;
        const sample = await mount.sample({ sessionId: sampledId });
        checkSample(sample);
        result.samples.sessionIds.push(sampledId);
        result.samples.elapsedMs.push(performance.now() - start);
        result.samples.plannedAtMs.push(null);
        result.samples.typedInputMs.push(sample.typedInputMs);
        result.samples.sessionSwitchMs.push(sample.sessionSwitchMs);
        await takeFacts("sample");
        nextSample = elapsed + o.sampleEveryMs;
      }
      if (elapsed >= nextReconnect) {
        phase = "detach-reconnect";
        await mount.detach();
        const reconnection = await mount.reconnect();
        if (reconnection?.replayedWithoutResend !== true || reconnection?.caughtUp !== true)
          throw new Error("reconnect did not prove replay without prompt resend");
        result.reconnects++;
        await takeFacts("reconnect");
        nextReconnect = elapsed + o.reconnectEveryMs;
      }
    }
    if (o.mode !== "smoke") {
      // 中文：定额轮次不依赖事件发送速度；所有会话在窗口末仍需实际测量，不能用计时器凑数。
      while (nextRound <= rounds) await plannedSample(nextRound++);
    } else
      while (performance.now() - start < o.durationMs)
        await sleep(Math.min(1000, o.durationMs - (performance.now() - start)));
    result.elapsedMs = performance.now() - start;
    phase = "final-owner-facts";
    const facts = await takeFacts("end");
    if (facts.durableEvents - startingEvents < o.eventCount || facts.backlog !== 0)
      throw new Error("Host events not durably caught up");
    if (result.reconnects < 1) throw new Error("no detach/reconnect exercised");
    if (
      o.mode === "acceptance" &&
      (result.reconnects < 2 ||
        plannedIds.some(
          (id) => result.samples.sessionIds.filter((value) => value === id).length < 20,
        ) ||
        result.samples.sessionSwitchMs.length !== result.samples.typedInputMs.length)
    )
      throw new Error("insufficient acceptance interaction/reconnect samples");
    if (typeof mount.gatewayProbe === "function") {
      phase = "fake-provider-probe";
      const values = await mount.gatewayProbe();
      if (!Array.isArray(values) || values.length < 1)
        throw new Error("invalid Fake Provider probe");
      for (const value of values)
        if (!Number.isFinite(value) || value < 0) throw new Error("invalid Fake Provider latency");
      result.gateway = {
        status: "fake-provider-pure-adapter",
        samples: values.length,
        p95Ms: p95(values),
      };
    }
  } catch {
    result.failures.push(`gate-failed:${phase}`);
  } finally {
    if (start && !result.elapsedMs) result.elapsedMs = performance.now() - start;
    if (mount) {
      // 中文：close 卡住时仍必须推进注册子进程的紧急回收，不能把计时器当清理成功。
      let timer;
      const closed = await Promise.race([
        Promise.resolve()
          .then(() => mount.close())
          .then(
            () => true,
            () => false,
          ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), CLEANUP_DEADLINE_MS);
        }),
      ]);
      clearTimeout(timer);
      if (!closed) result.failures.push("gate-failed:cleanup-or-idle");
    }
    try {
      const exits = await cleanup.dispose();
      result.cleanup = { registeredChildrenExited: exits.registeredChildrenExited };
      if (exits.failed) throw new Error("owned resource cleanup unproven");
      if (mount && !result.failures.includes("gate-failed:cleanup-or-idle")) {
        const after = await takeFacts("post-cleanup");
        if (after.childProcesses !== 0)
          throw new Error("owned child processes remained after cleanup");
        if (o.idleMs) await sleep(o.idleMs);
        const idle = await takeFacts("post-idle");
        if (idle.childProcesses !== 0) throw new Error("owned child processes remained at idle");
        Object.assign(result.cleanup, {
          childProcesses: idle.childProcesses,
          idleHeapBytes: idle.heapBytes,
          idleRssBytes: idle.rssBytes,
        });
      }
    } catch {
      result.failures.push("gate-failed:cleanup-or-idle");
    }
    result.p95 = {
      typedInputMs: p95(result.samples.typedInputMs),
      sessionSwitchMs: p95(result.samples.sessionSwitchMs),
    };
    if (o.mode === "benchmark") {
      const rounds = Math.max(20, Math.ceil(o.durationMs / o.sampleEveryMs));
      result.measurement = {
        datasetId: o.benchmarkDatasetId,
        windowMs: o.durationMs,
        startedAtElapsedMs: 0,
        endedAtElapsedMs: result.elapsedMs,
        plan: {
          rounds,
          slotMs: o.durationMs / rounds,
          sessionIds: Array.from({ length: o.sessionCount }, (_, i) => `synthetic-${i}`),
        },
      };
      if (!validMeasurement(result)) result.failures.push("gate-failed:measurement-population");
    }
    if (result.backlog.length)
      result.backlogSummary = {
        max: Math.max(...result.backlog.map((b) => b.highWater)),
        final: result.backlog.findLast((b) => b.phase === "end")?.count ?? null,
      };
    // 中文：采样与关闭期间不能换源或构建；写结果前再核对实际消费的源码、构建及驱动输入。
    if (result.metadata && !result.failures.includes("gate-failed:source-provenance")) {
      try {
        const m = result.metadata;
        if (
          m.driverFile &&
          (hash(await readFile(m.driverFile)) !== m.driverSha256 ||
            !(await verifiedFiles(m.supportFiles)))
        )
          throw new Error("driver/support changed");
        if (m.sourceCheckout) {
          await preservedSource(m.sourceCheckout, m.productionCommit);
          if ((await buildHash(m.buildArtifactPath)) !== m.buildSha256)
            throw new Error("build changed");
          if (
            m.buildPreparation &&
            hash(await readFile(m.buildPreparation.manifestPath)) !==
              m.buildPreparation.manifestSha256
          )
            throw new Error("manifest changed");
        }
      } catch {
        result.failures.push("gate-failed:source-provenance");
      }
    }
    try {
      result.comparison = await comparison(input.baselinePath, result);
    } catch {
      result.failures.push("gate-failed:baseline-unreadable");
    }
    if (result.comparison.status === "over-budget")
      result.failures.push("gate-failed:latency-regression");
    if (!result.failures.length) result.status = decideLoadStatus(result, o, input);
    const file = join(root, "result.json");
    await writeFile(file + ".partial", JSON.stringify(result, null, 2) + "\n");
    await rename(file + ".partial", file);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  // 中文：CLI 反向导入 runner 时，顶层 await 会导致循环模块永远无法完成求值。
  import("./runner-cli.mjs")
    .then(({ runCli }) => runCli())
    .catch(() => {
      process.exitCode = 1;
    });
}
