import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInputMessage as ContractModelInputMessage } from "@zcode/contracts";
import { toCoreModelInputMessage } from "./model-input-entry.js";

test("developer-role contract messages enter core history as system messages", () => {
  const message: ContractModelInputMessage = {
    role: "developer",
    content: "Developer policy",
    cacheControl: { type: "ephemeral" },
  };

  assert.deepEqual(toCoreModelInputMessage(message), {
    role: "system",
    content: "Developer policy",
    cacheControl: { type: "ephemeral" },
  });
  assert.equal(message.role, "developer");
});

test("core-supported roles pass through unchanged", () => {
  for (const role of ["system", "user", "assistant", "tool"] as const) {
    const message: ContractModelInputMessage = { role, content: `${role} body` };
    assert.deepEqual(toCoreModelInputMessage(message), message);
  }
});
