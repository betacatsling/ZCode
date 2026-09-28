import assert from "node:assert/strict";
import test from "node:test";
import { ProjectSidebarSummaryRefreshScheduler } from "../src/project-sidebar/summaryRefreshScheduler.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("sidebar summary refresh coalesces affected workspaces behind one in-flight refresh", async () => {
  const firstRefresh = deferred();
  const enteredFirstRefresh = deferred();
  const batches: string[][] = [];
  const scheduler = new ProjectSidebarSummaryRefreshScheduler(async (workspaceIds) => {
    batches.push([...workspaceIds]);
    if (batches.length === 1) {
      enteredFirstRefresh.resolve();
      await firstRefresh.promise;
    }
  });

  scheduler.request(["workspace-a"]);
  await enteredFirstRefresh.promise;
  scheduler.request(["workspace-b"]);
  scheduler.request(["workspace-a", "workspace-b"]);
  firstRefresh.resolve();
  await scheduler.whenIdle();

  assert.deepEqual(batches, [["workspace-a"], ["workspace-a", "workspace-b"]]);
});

test("disposed sidebar summary scheduler drops queued refreshes", async () => {
  const batches: string[][] = [];
  const scheduler = new ProjectSidebarSummaryRefreshScheduler(async (workspaceIds) => {
    batches.push([...workspaceIds]);
  });

  scheduler.dispose();
  scheduler.request(["workspace-a"]);
  await scheduler.whenIdle();

  assert.deepEqual(batches, []);
});
