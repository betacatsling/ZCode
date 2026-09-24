import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { nativeCreatePayloadFingerprint } from "./native-create-fingerprint.js";

test("native create fingerprint keeps historical payload semantics including old extra fields", () => {
  const payload = { workspaceId: "scope", config: { mode: "build" }, historicalExtra: "retained" };
  const canonical = {
    config: { mode: "build" },
    historicalExtra: "retained",
    workspaceId: "scope",
  };
  assert.equal(
    nativeCreatePayloadFingerprint(payload),
    createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
  );
  assert.notEqual(
    nativeCreatePayloadFingerprint(payload),
    nativeCreatePayloadFingerprint({ workspaceId: "scope", config: { mode: "build" } }),
  );
});
