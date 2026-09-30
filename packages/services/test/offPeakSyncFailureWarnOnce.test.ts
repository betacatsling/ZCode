/**
 * REMOVE-PRODUCT-LOGIN-PLAN §9.3 gap 6 finding 2: a leftover non-terminal off-peak task whose
 * ticket status sync keeps failing (offline, or credentials no longer resolvable after product
 * login removal) used to log `off-peak sync cycle failed` at warn level on every retry, forever.
 *
 * Contract pinned here (OffPeakTaskService with fake repo/client, node:test mock timers):
 *  - the retry loop itself keeps running with its back-off (we do not stop syncing);
 *  - for the same task the failure is logged at warn level once, later retries go to debug;
 *  - a successful sync resets that, so a later failure warns again;
 *  - a task that joins during a failure streak gets its own single warning.
 */
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { ZCodeOffPeakTask } from "@zcode/shared";
import type { ServiceLogger } from "../src/logger/serviceLogger.js";
import type {
  OffPeakBatchStatusResult,
  OffPeakServerClient,
} from "../src/session/offPeakServerClient.js";
import type { OffPeakTaskRepo } from "../src/session/offPeakTaskRepo.js";
import { OffPeakTaskService } from "../src/session/offPeakTaskService.js";

const SYNC_FAILED = "off-peak sync cycle failed";
const MAX_INTERVAL_MS = 5 * 60_000;

function queuedTask(offPeakTaskId: string, serverTicketId: string): ZCodeOffPeakTask {
  return {
    offPeakTaskId,
    serverTicketId,
    title: offPeakTaskId,
    prompt: "legacy",
    permissionMode: "edit",
    workspaceKey: "/tmp/ws",
    workspacePath: "/tmp/ws",
    status: "queued",
    queuedAt: 1_700_000_000_000,
  } as ZCodeOffPeakTask;
}

function createHarness() {
  const tasks = new Map<string, ZCodeOffPeakTask>();
  const logs: Array<{ level: "debug" | "info" | "warn"; text: string }> = [];
  const record =
    (level: "debug" | "info" | "warn") =>
    (...args: unknown[]) =>
      logs.push({ level, text: args.map((arg) => String(arg)).join(" ") });
  const logger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
  } as unknown as ServiceLogger;
  let failing = true;
  let batchStatusCalls = 0;
  const client = {
    async batchStatus(ticketIds: string[]): Promise<OffPeakBatchStatusResult> {
      batchStatusCalls += 1;
      if (failing) throw new Error("fetch failed: offline");
      return {
        tickets: ticketIds.map((ticketId) => ({ ticketId, state: "queued", position: 1 })),
        nextPollAfterMs: 5_000,
      };
    },
    async takeTicket() {
      throw new Error("not used");
    },
    async settle() {},
    async getTakeNumberAvailability() {
      throw new Error("not used");
    },
  } as unknown as OffPeakServerClient;
  const repo = {
    listUnsettledTerminal: async () => [],
    listNonTerminal: async () => [...tasks.values()],
    updateSchedulingSnapshot: async () => null,
  } as unknown as OffPeakTaskRepo;
  const service = new OffPeakTaskService({
    repo,
    client,
    logger,
    resolveCodingPlanSupport: async () => ({ supported: false }) as never,
    resolveTelemetryProviderName: async () => "",
    resolveModelSelection: async () => ({ ok: false, validation: {} as never }),
  });
  return {
    tasks,
    service,
    setFailing: (value: boolean) => {
      failing = value;
    },
    batchStatusCalls: () => batchStatusCalls,
    syncWarnings: () =>
      logs.filter((log) => log.level === "warn" && log.text.includes(SYNC_FAILED)),
    syncFailureLogs: () => logs.filter((log) => log.text.includes(SYNC_FAILED)),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Advance one sync cycle: every scheduled delay is <= the 5 min cap. */
async function runCycles(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    mock.timers.tick(MAX_INTERVAL_MS);
    await flush();
  }
}

test("off-peak sync failure warns once per task, keeps retrying, and warns again after a recovery", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const harness = createHarness();
  harness.tasks.set("legacy-a", queuedTask("legacy-a", "ticket-a"));
  harness.service.startSync();
  t.after(() => harness.service.stopSync());
  await flush();
  mock.timers.tick(0);
  await flush();

  // A long offline streak: the loop keeps polling with back-off, but warns only once.
  await runCycles(30);
  assert.ok(harness.batchStatusCalls() >= 30, `retried ${harness.batchStatusCalls()} times`);
  assert.ok(harness.syncFailureLogs().length >= 30, "every failed retry is still logged (debug)");
  assert.equal(harness.syncWarnings().length, 1, JSON.stringify(harness.syncWarnings()));

  // A task that joins during the streak gets its own single warning.
  harness.tasks.set("legacy-b", queuedTask("legacy-b", "ticket-b"));
  await runCycles(10);
  assert.equal(harness.syncWarnings().length, 2, JSON.stringify(harness.syncWarnings()));

  // Recovery resets; the next failure streak warns again, once.
  harness.setFailing(false);
  await runCycles(2);
  const warningsBeforeRelapse = harness.syncWarnings().length;
  harness.setFailing(true);
  await runCycles(10);
  assert.equal(harness.syncWarnings().length, warningsBeforeRelapse + 1);
  assert.equal(harness.syncWarnings().length, 3);
});
