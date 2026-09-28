import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNativeFetchAudit } from "./certifyNativeV4Common.js";

test("fetch audit counts unresolved guarded attempts before and after native fetch", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-fetch-audit-"));
  const path = join(root, "audit.jsonl");
  const rows = [
    { request: 1, result: "logical-attempt", routeClass: "provider-model" },
    { request: 2, result: "logical-attempt", routeClass: "auxiliary" },
    { request: 2, result: "native-fetch-invoked" },
    { request: 3, result: "logical-attempt", routeClass: "title-sidecar" },
    { request: 3, result: "native-fetch-invoked" },
    { request: 3, result: "http-response", status: 200 },
    { request: 4, result: "logical-attempt", routeClass: "provider-model" },
    { request: 4, result: "blocked-before-send" },
    { request: 5, result: "logical-attempt", routeClass: "provider-model" },
    { request: 5, result: "native-fetch-invoked" },
    { request: 5, result: "fetch-cancelled" },
  ];
  try {
    await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    assert.deepEqual(await readNativeFetchAudit(path), {
      logicalFetchAttempts: 5,
      nativeFetchInvocations: 3,
      httpResponses: 1,
      httpErrorResponses: 0,
      fetchFailures: 0,
      cancelledFetches: 1,
      blockedBeforeSend: 1,
      unknownOutcomes: 2,
      routeAttempts: { titleSidecar: 1, providerModel: 3, auxiliary: 1, unknown: 0 },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
