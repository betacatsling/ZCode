import assert from "node:assert/strict";
import test from "node:test";
import {
  externalCommandMarkerKey,
  readExternalCommandMarker,
  writeExternalCommandMarker,
  clearExternalCommandMarker,
} from "../src/v4/externalCommandMarker.js";

test("pending external commands are scoped to target/worktree/session and cannot be overwritten", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  try {
    const one = externalCommandMarkerKey({ targetId: "a", workspaceId: "x", sessionId: "pi" });
    const other = externalCommandMarkerKey({ targetId: "b", workspaceId: "x", sessionId: "pi" });
    assert.notEqual(one, other);
    assert.equal(writeExternalCommandMarker(one, "command-1"), true);
    assert.equal(writeExternalCommandMarker(one, "command-2"), false);
    assert.equal(readExternalCommandMarker(one), "command-1");
    assert.equal(readExternalCommandMarker(other), null);
    assert.equal(clearExternalCommandMarker(one, "command-2"), false);
    assert.equal(clearExternalCommandMarker(one, "command-1"), true);
    assert.equal(readExternalCommandMarker(one), null);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
