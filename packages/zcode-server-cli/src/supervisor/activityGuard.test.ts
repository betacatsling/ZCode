import assert from "node:assert/strict";
import { test } from "node:test";
import { unsafeActivityCount } from "./activityGuard.js";

test("native running, external waiting and uncertain each prevent implicit interruption", () => {
  const idle = { running: 0, waiting: 0, uncertain: 0 };
  assert.equal(unsafeActivityCount(1, idle), 1);
  assert.equal(unsafeActivityCount(0, { ...idle, waiting: 1 }), 1);
  assert.equal(unsafeActivityCount(0, { ...idle, uncertain: 1 }), 1);
  assert.equal(unsafeActivityCount(0, idle), 0);
});
