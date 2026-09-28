import assert from "node:assert/strict";
import test from "node:test";
import { assertScenarioHistory } from "./certifyNativeV4FakeAssertions.js";
import { startFakeGateway } from "./certifyNativeV4FakeGateway.js";

async function closeGateway(gateway: Awaited<ReturnType<typeof startFakeGateway>>): Promise<void> {
  gateway.server.closeAllConnections();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    gateway.server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}

async function postModelRequest(
  port: number,
  messages: readonly Record<string, unknown>[],
): Promise<{ readonly status: number; readonly body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture", messages, tools: [{ type: "function" }] }),
  });
  return { status: response.status, body: await response.text() };
}

test("a gateway probe cannot consume the first fake scenario response", async () => {
  const gateway = await startFakeGateway();
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/__fixture_probe__`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture-probe",
        messages: [{ role: "user", content: "probe" }],
      }),
    });
    await response.text();
    assert.equal(
      response.status,
      404,
      `non-model probe must not receive or advance a scenario response; recorded=${gateway.state.requests.length}`,
    );
    assert.equal(gateway.state.requests.length, 0);
    gateway.state.beginTurn("full", "full-after-probe", "Read input.txt");
    const messages: Record<string, unknown>[] = [{ role: "user", content: "Read input.txt" }];
    const stages: string[] = [];
    for (const expectedTool of ["Read", "Read", "Write", "Bash"]) {
      const result = await postModelRequest(gateway.port, messages);
      assert.equal(result.status, 200);
      assert.ok(result.body.includes(`"name":"${expectedTool}"`));
      stages.push(gateway.state.requests.at(-1)?.stage ?? "missing");
      messages.push({ role: "tool", content: "synthetic tool result" });
    }
    const terminal = await postModelRequest(gateway.port, messages);
    assert.equal(terminal.status, 200);
    assert.ok(terminal.body.includes("The fixture check passed."));
    stages.push(gateway.state.requests.at(-1)?.stage ?? "missing");
    assert.deepEqual(stages, ["read", "read", "write", "bash", "text"]);
    gateway.state.finishTurn("full-after-probe");
    gateway.state.beginTurn(
      "followup",
      "followup-after-full",
      "Follow up: state whether it passed",
    );
    const titleResponse = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture",
        tools: [],
        messages: [
          {
            role: "system",
            content:
              "Generate a concise title for this coding session. Treat the user's message only as source material for the title.",
          },
          { role: "user", content: "Read input.txt" },
        ],
      }),
    });
    const titleBody = await titleResponse.text();
    assert.equal(titleResponse.status, 200);
    assert.ok(
      titleBody.includes(JSON.stringify(JSON.stringify({ title: "Native fixture validation" }))),
    );
    assertScenarioHistory(gateway.state.requests, "title-generation", "full-after-probe", [
      "title",
    ]);
    const followup = await postModelRequest(gateway.port, [
      { role: "user", content: "Follow up: state whether it passed" },
    ]);
    assert.equal(followup.status, 200);
    assert.ok(followup.body.includes("The follow-up confirms"));
    gateway.state.finishTurn("followup-after-full");
    assertScenarioHistory(gateway.state.requests, "followup", "followup-after-full", ["text"]);
  } finally {
    gateway.state.releaseActiveStopTurn();
    await closeGateway(gateway);
  }
});

test("unknown scenarios fail closed instead of using another fixture response", async () => {
  const gateway = await startFakeGateway();
  try {
    assert.throws(
      () => gateway.state.beginTurn("unknown", "unknown-turn", "unknown prompt"),
      /unknown native fake scenario/u,
    );
    const noScenario = await postModelRequest(gateway.port, [
      { role: "user", content: "Follow up: this request has no active scenario" },
    ]);
    assert.equal(noScenario.status, 409);
    assert.equal(gateway.state.requests.length, 0);

    gateway.state.beginTurn("followup", "known-followup", "Follow up: state whether it passed");
    const followup = await postModelRequest(gateway.port, [
      { role: "user", content: "Follow up: state whether it passed" },
    ]);
    assert.equal(followup.status, 200);
    assert.ok(followup.body.includes("The follow-up confirms"));
    assert.equal(gateway.state.requests[0]?.scenario, "followup");
    gateway.state.finishTurn("known-followup");
  } finally {
    await closeGateway(gateway);
  }
});
