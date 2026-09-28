/**
 * Thin unit coverage for linkAcpTransports subscribeClose (idle peer close).
 * Fake-transport only — not live ACP / SessionHost certification.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AcpRpc, linkAcpTransports } from "../src/agent-adapters/acp/acpTransport.js";

test("linkAcpTransports subscribeClose: idle close notifies listener", async () => {
  const { client, agent } = linkAcpTransports();
  let closes = 0;
  client.subscribeClose?.(() => {
    closes += 1;
  });

  await agent.close();

  assert.equal(closes, 1);
});

test("linkAcpTransports subscribeClose: unsubscribe stops further notify", async () => {
  const { client, agent } = linkAcpTransports();
  let closes = 0;
  const unsubscribe = client.subscribeClose?.(() => {
    closes += 1;
  });
  assert.equal(typeof unsubscribe, "function");
  unsubscribe?.();

  await agent.close();

  assert.equal(closes, 0);
});

test("AcpRpc: in-flight request rejects on peer idle subscribeClose", async () => {
  const { client, agent } = linkAcpTransports();
  const rpc = new AcpRpc(
    client,
    () => {},
    () => {},
  );

  const pending = rpc.request("session/prompt", { prompt: "ping" });
  await agent.close();

  await assert.rejects(pending, /ACP transport closed/);
});

test("linkAcpTransports close: double close is idempotent (listener once)", async () => {
  const { client, agent } = linkAcpTransports();
  let closes = 0;
  client.subscribeClose?.(() => {
    closes += 1;
  });

  await agent.close();
  await agent.close();

  assert.equal(closes, 1);
});
