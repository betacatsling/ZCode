/* oxlint-disable eslint(max-lines) -- 中文：测试保留同一 owner backend 的跨层调度、回放和清理场景；新增收尾验收后只超出行数阈值，不拆分共享生命周期 fixture。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, runLoad } from "./runner.mjs";
import driver, { assertIsolated, createProductionBackend } from "./production-driver.mjs";

async function fixture(count = 6) {
  const root = await mkdtemp(join(tmpdir(), "load-prod-test-"));
  const isolation = {
    home: join(root, "home"),
    xdgConfig: join(root, "xdg-config"),
    xdgData: join(root, "xdg-data"),
    desktopUserData: join(root, "desktop-user-data"),
    webProfile: join(root, "web-profile"),
    temporary: join(root, "temporary"),
  };
  for (const path of Object.values(isolation)) await mkdir(path);
  const { repo, worktrees } = await createFixture(root, count);
  return { root, artifacts: root, repo, worktrees, isolation, mode: "smoke" };
}
async function isolated(input, callback) {
  const names = {
    HOME: input.isolation.home,
    XDG_CONFIG_HOME: input.isolation.xdgConfig,
    XDG_DATA_HOME: input.isolation.xdgData,
    ZCODE_DATA_BASE_DIR: input.isolation.desktopUserData,
    TMPDIR: input.isolation.temporary,
  };
  const prior = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(
    process.env,
    Object.fromEntries(
      ["PATH", "LANG", "LC_ALL", "TZ"]
        .filter((key) => prior[key] !== undefined)
        .map((key) => [key, prior[key]]),
    ),
    names,
  );
  try {
    return await callback();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, prior);
  }
}

test("refuses HOME and symlink/foreign worktree before product imports", async () => {
  const input = await fixture(2);
  await assert.rejects(
    assertIsolated(input),
    /effective process isolation|untrusted inherited environment/,
  );
  await isolated(input, async () => {
    await assertIsolated(input);
    await assert.rejects(
      assertIsolated({ ...input, worktrees: [...input.worktrees, process.cwd()] }),
      /foreign worktree/,
    );
    process.env.PROVIDER_SECRET = "blocked";
    await assert.rejects(assertIsolated(input), /untrusted inherited environment/);
    delete process.env.PROVIDER_SECRET;
  });
});

for (const delivery of ["desktop-continuous", "web-remote-replayable"])
  test(`real Target/Catalog/Host ${delivery}: six Git worktrees, ten sessions, durable synthetic events, query-only replay`, async () => {
    const input = { ...(await fixture()), delivery };
    await isolated(input, async () => {
      const owner = await createProductionBackend(input);
      try {
        const discovered = await owner.discover({ repo: input.repo, candidates: input.worktrees });
        assert.equal(discovered.length, 6);
        const expanded = discovered.slice(0, 5);
        const sessions = Array.from({ length: 10 }, (_, i) => ({
          id: `synthetic-${i}`,
          workspaceId: expanded[i % 5].id,
        }));
        const sidebar = await owner.prepareSessions({ expandedWorktrees: expanded, sessions });
        assert.equal(sidebar.workspaces.length, 5);
        assert.equal(sidebar.sessions.length, 10);
        assert.ok(
          sidebar.sessions.every(
            (s) => s.freshness === "live" && s.session.harnessId === "load-synthetic",
          ),
        );
        assert.equal((await owner.host.listWorkspaceSessions(expanded[0].id)).length, 2);
        await owner.emitCommitted({ sessionId: "synthetic-0", eventId: "synthetic-event-0" });
        const before = (await owner.ownerRows("synthetic-0", 0))[0];
        assert.equal(before.kind, "turn.started");
        assert.equal(before.sourceEventId, "synthetic-event-0");
        assert.equal((await owner.host.snapshot(owner.specs.get("synthetic-0"))).seq, 1);
        await owner.detach();
        await owner.emitCommitted({ sessionId: "synthetic-0", eventId: "synthetic-event-1" });
        assert.deepEqual(await owner.reconnect(), { replayedWithoutResend: true, caughtUp: true });
        assert.equal(owner.observed.liveCursor.get("synthetic-0"), 2);
        assert.equal(
          (await owner.host.queryCreationCommand("load-create-synthetic-0")).receipt.status,
          "completed",
        );
        assert.equal((await owner.ownerRows("synthetic-0", 1)).length, 1);
        const raw = await readFile(join(input.root, "load-catalog.json"), "utf8");
        assert.match(raw, /load-workspace-0/);
      } finally {
        await owner.close();
        assert.deepEqual(
          JSON.parse(await readFile(join(input.root, "driver-cleanup.json"), "utf8")),
          {
            hostClosed: true,
            catalogClosed: true,
            targetClosed: true,
            ownedChildProcesses: 0,
            ownerLocks: 0,
          },
        );
      }
    });
  });

test("driver fails closed when Shell is not attached to the same owner Host", async () => {
  const input = { ...(await fixture(2)), delivery: "desktop-continuous" };
  await isolated(input, async () => {
    const callbacks = [];
    const product = await driver.open({
      ...input,
      registerCleanup: (fn) => callbacks.push(fn),
      registerChild: () => {},
    });
    assert.equal(callbacks.length, 1);
    try {
      const found = await product.discover({ repo: input.repo, candidates: input.worktrees });
      await assert.rejects(
        product.mount({
          expandedWorktrees: found.slice(0, 1),
          sessions: [{ id: "synthetic-0", workspaceId: found[0].id }],
        }),
        /same-owner Core-to-utility-Host Shell attachment/,
      );
      await assert.rejects(product.sample(), /no real mounted browser/);
      await assert.rejects(product.facts(), /no separate mounted Host/);
    } finally {
      await product.close();
      await callbacks[0]();
      await driver.dispose();
      assert.deepEqual(
        JSON.parse(await readFile(join(input.root, "driver-cleanup.json"), "utf8")),
        {
          hostClosed: true,
          catalogClosed: true,
          targetClosed: true,
          ownedChildProcesses: 0,
          ownerLocks: 0,
        },
      );
    }
  });
});

test("partial-open failure registers cleanup, rejects argv delivery inference and repeated dispose stays safe", async () => {
  const input = { ...(await fixture(2)) };
  await isolated(input, async () => {
    const { default: partial } = await import("./production-driver.mjs?partial-open-cleanup");
    const callbacks = [];
    await assert.rejects(
      partial.open({
        ...input,
        registerCleanup: (fn) => callbacks.push(fn),
        registerChild: () => {},
      }),
      /explicit delivery/,
    );
    assert.equal(callbacks.length, 1);
    await callbacks[0]();
    await partial.dispose();
    assert.equal(callbacks.length, 1);
  });
});

test("joined runner passes explicit delivery and reaps real backend after fail-closed Shell mount", async () => {
  const { default: joined } = await import("./production-driver.mjs?joined-runner");
  const result = await runLoad({
    driver: joined,
    mode: "smoke",
    delivery: "web-remote-replayable",
    artifactBase: await mkdtemp(join(tmpdir(), "load-joined-")),
    durationMs: 2,
    eventCount: 1,
    worktreeCount: 2,
    sessionCount: 2,
    expandedCount: 1,
    reconnectEveryMs: 1,
    sampleEveryMs: 1,
    idleMs: 0,
    isolateProcessEnv: true,
  });
  assert.equal(result.status, "failed");
  assert.ok(result.failures.includes("gate-failed:mount"));
  assert.equal(result.cleanup.registeredChildrenExited, 0);
  assert.ok(result.failures.includes("gate-failed:cleanup-or-idle")); // no mounted process facts exist yet
  assert.deepEqual(
    JSON.parse(await readFile(join(result.artifacts, "driver-cleanup.json"), "utf8")),
    {
      hostClosed: true,
      catalogClosed: true,
      targetClosed: true,
      ownedChildProcesses: 0,
      ownerLocks: 0,
    },
  );
  await joined.dispose();
});

test("50 discovered real Git worktrees and 10 durable Host sessions across five Catalog workspaces", async () => {
  const input = { ...(await fixture(50)), delivery: "desktop-continuous" };
  await isolated(input, async () => {
    const owner = await createProductionBackend(input);
    try {
      const discovered = await owner.discover({ repo: input.repo, candidates: input.worktrees });
      assert.equal(discovered.length, 50);
      const expanded = discovered.slice(0, 5);
      const sessions = Array.from({ length: 10 }, (_, i) => ({
        id: `synthetic-${i}`,
        workspaceId: expanded[i % 5].id,
      }));
      const snapshot = await owner.prepareSessions({ expandedWorktrees: expanded, sessions });
      assert.equal(snapshot.sessions.length, 10);
      for (let i = 0; i < 10; i++)
        await owner.emitCommitted({ sessionId: sessions[i].id, eventId: `event-${i}` });
      for (const workspace of expanded)
        assert.equal((await owner.host.getRuntimeActivity(workspace.id)).running, 2);
      for (let i = 10; i < 70; i++)
        await owner.emitCommitted({ sessionId: sessions[i % 10].id, eventId: `event-${i}` });
      for (const session of sessions) {
        const rows = await owner.ownerRows(session.id);
        assert.deepEqual(
          rows.map((row) => row.kind),
          [
            "turn.started",
            "text.delta",
            "tool.started",
            "tool.finished",
            "text.delta",
            "message.finished",
            "turn.finished",
          ],
        );
        assert.ok(
          rows.filter((row) => row.kind === "text.delta").every((row) => row.text.length > 0),
        );
      }
      for (const workspace of expanded)
        assert.equal((await owner.host.getRuntimeActivity(workspace.id)).running, 0);
      await owner.detach();
      assert.deepEqual(await owner.reconnect(), { replayedWithoutResend: true, caughtUp: true });
    } finally {
      await owner.close();
      assert.deepEqual(
        JSON.parse(await readFile(join(input.root, "driver-cleanup.json"), "utf8")),
        {
          hostClosed: true,
          catalogClosed: true,
          targetClosed: true,
          ownedChildProcesses: 0,
          ownerLocks: 0,
        },
      );
    }
  });
});

test("cancel releases the accepted Host producer gate and closes the actual turn", async () => {
  const input = { ...(await fixture(2)), delivery: "web-remote-replayable" };
  await isolated(input, async () => {
    const owner = await createProductionBackend(input);
    try {
      const found = await owner.discover({ repo: input.repo, candidates: input.worktrees });
      const [workspace] = found;
      const session = { id: "cancelled-turn", workspaceId: workspace.id };
      await owner.prepareSessions({ expandedWorktrees: [workspace], sessions: [session] });
      const send = await owner.acceptTurn({ sessionId: session.id, commandId: "load-send-cancel" });
      assert.equal(send.status, "accepted");
      const spec = owner.specs.get(session.id);
      const running = await owner.host.getSessionReadModel(spec);
      const cancel = await owner.host.dispatch(spec, {
        type: "cancelTurn",
        commandId: "load-cancel",
        hostSessionId: session.id,
        runtimeEpoch: running.runtimeEpoch,
        turnId: "load-turn-load-send-cancel",
      });
      assert.equal(cancel.status, "completed");
      await owner.host.waitForIdle(spec);
      const rows = await owner.ownerRows(session.id);
      assert.deepEqual(
        rows.map((row) => row.kind),
        ["turn.started", "turn.finished"],
      );
      assert.equal(rows.at(-1).outcome, "cancelled");
      assert.equal((await owner.host.getRuntimeActivity(workspace.id)).running, 0);
      assert.equal((await owner.host.queryCommand(spec, "load-send-cancel")).status, "completed");
    } finally {
      await owner.close();
    }
  });
});

test("owner disposal releases an accepted producer gate and proves bounded cleanup", async () => {
  const input = await fixture(2);
  await isolated(input, async () => {
    const owner = await createProductionBackend(input);
    try {
      const [workspace] = await owner.discover({ repo: input.repo, candidates: input.worktrees });
      const session = { id: "dispose-gated-session", workspaceId: workspace.id };
      await owner.prepareSessions({ expandedWorktrees: [workspace], sessions: [session] });
      assert.equal(
        (
          await owner.acceptTurn({
            sessionId: session.id,
            commandId: "dispose-gated-send",
          })
        ).status,
        "accepted",
      );
      assert.equal(
        (await owner.host.getSessionReadModel(owner.specs.get(session.id))).activity,
        "running",
      );
    } finally {
      await owner.close();
    }
    assert.deepEqual(owner.harness.activeTurnIds, []);
    assert.deepEqual(JSON.parse(await readFile(join(input.root, "driver-cleanup.json"), "utf8")), {
      hostClosed: true,
      catalogClosed: true,
      targetClosed: true,
      ownedChildProcesses: 0,
      ownerLocks: 0,
    });
  });
});

test("Web replayable delivery catches an accepted turn from the prior owner cursor without resending", async () => {
  const input = { ...(await fixture(2)), delivery: "web-remote-replayable" };
  await isolated(input, async () => {
    const owner = await createProductionBackend(input);
    try {
      const found = await owner.discover({ repo: input.repo, candidates: input.worktrees });
      const [workspace] = found;
      const session = { id: "web-replay-session", workspaceId: workspace.id };
      await owner.prepareSessions({ expandedWorktrees: [workspace], sessions: [session] });
      const receipt = await owner.acceptTurn({
        sessionId: session.id,
        commandId: "web-replay-send",
      });
      assert.equal(receipt.status, "accepted");
      await owner.detach();
      assert.equal((await owner.retryAcceptedTurn("web-replay-send")).status, "duplicate");
      await owner.releaseTurns();
      assert.deepEqual(await owner.reconnect(), { replayedWithoutResend: true, caughtUp: true });
      const rows = await owner.ownerRows(session.id);
      assert.equal(rows.filter((row) => row.kind === "turn.started").length, 1);
      assert.equal(rows.at(-1).kind, "turn.finished");
      assert.equal(
        (await owner.host.queryCommand(owner.specs.get(session.id), "web-replay-send")).status,
        "completed",
      );
      assert.equal(owner.observed.liveCursor.get(session.id), rows.at(-1).sequence);
    } finally {
      await owner.close();
    }
  });
});

test("short load uses accepted Host commands to hold ten genuine running turns across five discovered workspaces", async () => {
  const input = { ...(await fixture(50)), delivery: "desktop-continuous" };
  await isolated(input, async () => {
    const owner = await createProductionBackend(input);
    try {
      const found = await owner.discover({ repo: input.repo, candidates: input.worktrees });
      const expanded = found.slice(0, 5);
      const sessions = Array.from({ length: 10 }, (_, i) => ({
        id: `accepted-${i}`,
        workspaceId: expanded[i % 5].id,
      }));
      await owner.prepareSessions({ expandedWorktrees: expanded, sessions });
      for (const session of sessions) {
        const receipt = await owner.acceptTurn({
          sessionId: session.id,
          commandId: `load-send-${session.id}`,
        });
        assert.equal(receipt.status, "accepted");
      }
      for (const workspace of expanded)
        assert.equal((await owner.host.getRuntimeActivity(workspace.id)).running, 2);
      assert.equal((await owner.host.getRuntimeActivity()).running, 10);
      await owner.detach();
      const duplicate = await owner.retryAcceptedTurn("load-send-accepted-0");
      assert.equal(duplicate.status, "duplicate");
      assert.equal(
        (await owner.ownerRows("accepted-0")).filter((row) => row.kind === "turn.started").length,
        1,
      );
      await owner.releaseTurns();
      assert.deepEqual(await owner.reconnect(), { replayedWithoutResend: true, caughtUp: true });
      for (const session of sessions) {
        const spec = owner.specs.get(session.id);
        const rows = await owner.ownerRows(session.id);
        assert.deepEqual(
          rows.map((row) => row.kind),
          [
            "turn.started",
            "text.delta",
            "tool.started",
            "tool.finished",
            "text.delta",
            "message.finished",
            "turn.finished",
          ],
        );
        assert.ok(rows.some((row) => row.kind === "message.finished" && row.text.length > 0));
        assert.equal((await owner.host.getSessionReadModel(spec)).seq, rows.at(-1).sequence);
        assert.equal((await owner.host.getSessionReadModel(spec)).activity, "idle");
        assert.equal(
          (await owner.host.queryCommand(spec, `load-send-${session.id}`)).status,
          "completed",
        );
      }
    } finally {
      await owner.close();
    }
  });
});
