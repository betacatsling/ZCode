import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLazyTargetAgentHostService } from "./lazyTargetService.js";

test("Node-only trusted harness list rejects duplicate Pi before starting any adapter", () => {
  let factories = 0;
  assert.throws(
    () =>
      createLazyTargetAgentHostService({
        root: join(tmpdir(), "unused-trusted-harness-fixture"),
        target: { id: "fixture", kind: "local", platform: "linux", available: true },
        registry: {} as never,
        admission: {} as never,
        allowNewSessions: () => false,
        additionalTrustedHarnesses: [
          {
            manifest: { schemaVersion: 1, id: "synthetic", name: "Synthetic", adapterVersion: "1" },
            factory: () => {
              factories++;
              return {} as never;
            },
          },
          {
            manifest: { schemaVersion: 1, id: "pi", name: "Pi duplicate", adapterVersion: "1" },
            factory: () => {
              factories++;
              return {} as never;
            },
          },
        ],
      }),
    /duplicate-id/,
  );
  assert.equal(factories, 0);
});
