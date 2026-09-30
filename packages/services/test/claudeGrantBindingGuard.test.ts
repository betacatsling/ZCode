import assert from "node:assert/strict";
import test from "node:test";
import type { ModelGatewayGrant } from "../src/model-gateway/contract.js";
import { ClaudeBindingMismatchError } from "../src/agent-adapters/claude/claudeBindingGuards.js";
import { claudeAdapterHarness, listeningServers } from "./fixtures/claudeAdapterHarness.js";

// A14: the grant returned by the target Gateway must match the captured binding before any
// profile, hook server or process is prepared; a mismatched grant is revoked, never used.

type Actual = ModelGatewayGrant["actualModel"];

const GRANT_CASES: readonly {
  readonly name: string;
  readonly mutate: (grant: ModelGatewayGrant) => ModelGatewayGrant;
}[] = [
  { name: "protocol", mutate: (g) => ({ ...g, protocol: "openai-responses" }) },
  { name: "sessionId", mutate: (g) => ({ ...g, sessionId: "another-session" }) },
  { name: "fingerprint", mutate: (g) => ({ ...g, modelBindingFingerprint: "another-catalog" }) },
  { name: "publicModelId", mutate: (g) => ({ ...g, publicModelId: "another-alias" }) },
  {
    name: "providerId",
    mutate: (g) => ({
      ...g,
      actualModel: { ...g.actualModel, providerId: "another-provider" as Actual["providerId"] },
    }),
  },
  {
    name: "modelId",
    mutate: (g) => ({
      ...g,
      actualModel: { ...g.actualModel, modelId: "another-model" as Actual["modelId"] },
    }),
  },
];

for (const current of GRANT_CASES) {
  test(`create revokes and refuses a Gateway grant whose ${current.name} differs`, async (t) => {
    const h = await claudeAdapterHarness(t);
    const servers = await listeningServers();
    const gateway = h.targetModelGateway.get(h.spec.execution.targetId);
    const recordingCreate = gateway.createGrant;
    gateway.createGrant = (input) => current.mutate(recordingCreate(input));

    await assert.rejects(h.adapter.create(h.spec, h.plan), (error: unknown) => {
      assert.ok(error instanceof ClaudeBindingMismatchError);
      assert.equal(error.code, "invalid-binding");
      assert.equal(error.mismatch, "grant");
      assert.match(error.message, /Claude Gateway grant differs from the captured binding/);
      return true;
    });
    assert.equal(h.grants.created.length, 1);
    assert.deepEqual(h.grants.revoked, h.grants.created, "the mismatched grant is revoked");
    assert.equal(h.launches.length, 0, "no process is launched");
    assert.equal(await listeningServers(), servers + 1, "only the Gateway listens; no hook server");

    gateway.createGrant = recordingCreate;
    await h.adapter.create(h.spec, h.plan);
    assert.equal(h.grants.created.length, 2);
    assert.equal(h.launches.length, 1, "a matching grant still starts the session");
  });
}

test("the grant guard covers every binding field of ModelGatewayGrant", () => {
  assert.deepEqual(
    GRANT_CASES.map((current) => current.name),
    ["protocol", "sessionId", "fingerprint", "publicModelId", "providerId", "modelId"],
  );
});
