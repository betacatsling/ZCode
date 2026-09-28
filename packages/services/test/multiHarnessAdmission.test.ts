import assert from "node:assert/strict";
import test from "node:test";
import { isMultiHarnessNewSessionAdmissionEnabled } from "@zcode/shared/agent-host";

test("multi-harness new-session admission is enabled only for exact env 1", () => {
  assert.equal(isMultiHarnessNewSessionAdmissionEnabled({}), false);
  assert.equal(
    isMultiHarnessNewSessionAdmissionEnabled({ ZCODE_MULTI_HARNESS_ENABLED: undefined }),
    false,
  );
  assert.equal(isMultiHarnessNewSessionAdmissionEnabled({ ZCODE_MULTI_HARNESS_ENABLED: "" }), false);
  assert.equal(isMultiHarnessNewSessionAdmissionEnabled({ ZCODE_MULTI_HARNESS_ENABLED: "0" }), false);
  assert.equal(
    isMultiHarnessNewSessionAdmissionEnabled({ ZCODE_MULTI_HARNESS_ENABLED: "true" }),
    false,
  );
  assert.equal(
    isMultiHarnessNewSessionAdmissionEnabled({ ZCODE_MULTI_HARNESS_ENABLED: "TRUE" }),
    false,
  );
  assert.equal(
    isMultiHarnessNewSessionAdmissionEnabled({ ZCODE_MULTI_HARNESS_ENABLED: "1 " }),
    false,
  );
  assert.equal(isMultiHarnessNewSessionAdmissionEnabled({ ZCODE_MULTI_HARNESS_ENABLED: "1" }), true);
});
