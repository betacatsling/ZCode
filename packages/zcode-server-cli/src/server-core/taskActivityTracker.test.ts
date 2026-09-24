import assert from "node:assert/strict";
import { test } from "node:test";
import { readExternalActivity } from "./taskActivityTracker.js";

test("external activity is unsafe when Host cannot report or reports waiting", async () => {
  assert.deepEqual(await readExternalActivity(undefined), { running: 0, waiting: 0, uncertain: 0 });
  assert.deepEqual(await readExternalActivity({}), { running: 0, waiting: 0, uncertain: 1 });
  assert.deepEqual(
    await readExternalActivity({
      getRuntimeActivity: async () => {
        throw Error("offline");
      },
    }),
    {
      running: 0,
      waiting: 0,
      uncertain: 1,
    },
  );
  assert.deepEqual(
    await readExternalActivity({
      getRuntimeActivity: async () => ({ running: 0, waiting: 1, uncertain: 0 }),
    }),
    {
      running: 0,
      waiting: 1,
      uncertain: 0,
    },
  );
  assert.deepEqual(
    await readExternalActivity({
      getRuntimeActivity: async () => ({ running: -1, waiting: 0, uncertain: 0 }),
    }),
    {
      running: 0,
      waiting: 0,
      uncertain: 1,
    },
  );
});
