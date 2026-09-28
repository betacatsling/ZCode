import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const fixtureDir = join(import.meta.dirname, "fixtures/codex-app-server-schema/0.157.1");

test("Codex 0.157.1 schema fixture locks the app-server methods and event shapes used by the adapter", async () => {
  const v1Bytes = await readFile(join(fixtureDir, "codex_app_server_protocol.schemas.json"));
  const v2Bytes = await readFile(join(fixtureDir, "codex_app_server_protocol.v2.schemas.json"));
  assert.equal(
    createHash("sha256").update(v1Bytes).digest("hex"),
    "a65bd8a8c714ffd36ef035ade0928cf059a24b8610b61c66f72d047c6ca6f0aa",
  );
  assert.equal(
    createHash("sha256").update(v2Bytes).digest("hex"),
    "2719fccd25a97a7ce355497ca5e9123a63f6dce7f9f83724a5b73fd927811f59",
  );
  const v1 = JSON.parse(v1Bytes.toString("utf8")) as SchemaDocument;
  const v2 = JSON.parse(v2Bytes.toString("utf8")) as SchemaDocument;
  const serverRequests = v1.definitions.ServerRequest?.oneOf ?? [];
  const methods = serverRequests.flatMap((request) => request.properties?.method?.enum ?? []);
  assert.ok(methods.includes("item/commandExecution/requestApproval"));
  assert.ok(methods.includes("item/fileChange/requestApproval"));
  assert.equal(
    v1.definitions.v2?.ThreadStartParams?.properties?.sandbox?.anyOf?.[0]?.$ref,
    "#/definitions/v2/SandboxMode",
  );
  assert.deepEqual(v1.definitions.v2?.ThreadResumeParams?.required, ["threadId"]);
  for (const name of [
    "AgentMessageDeltaNotification",
    "TurnStartedNotification",
    "TurnCompletedNotification",
    "ThreadTokenUsageUpdatedNotification",
  ]) {
    assert.ok(v2.definitions[name], `v2 schema must retain ${name}`);
  }
});

interface SchemaDefinition {
  readonly oneOf?: readonly SchemaDefinition[];
  readonly properties?: Readonly<Record<string, SchemaDefinition>>;
  readonly enum?: readonly string[];
  readonly anyOf?: readonly SchemaDefinition[];
  readonly $ref?: string;
  readonly required?: readonly string[];
}

interface SchemaDocument {
  readonly definitions: Readonly<Record<string, SchemaDefinition>> & {
    readonly v2?: Readonly<Record<string, SchemaDefinition>>;
  };
}
