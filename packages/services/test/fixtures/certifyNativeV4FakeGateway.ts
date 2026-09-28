import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import {
  emitTextResponse,
  emitToolResponse,
  readJsonRequest,
} from "./certifyNativeV4FakeGatewayProtocol.js";
import {
  createFakeScenarioTurn,
  fakeScenarioPlans,
  matchingTitleTurn,
  verifyScenarioHistory,
  type FakeModelRequest,
  type FakeRequestScenario,
  type FakeResponseStep,
  type FakeScenarioTurn,
  type NativeFakeScenario,
} from "./certifyNativeV4FakeGatewayPlan.js";

export type {
  FakeModelRequest,
  FakeRequestScenario,
  NativeFakeScenario,
} from "./certifyNativeV4FakeGatewayPlan.js";

interface RequestWaiter {
  readonly count: number;
  resolve(): void;
  reject(error: Error): void;
}

interface ScenarioResponseWaiter extends RequestWaiter {
  readonly scenario: FakeRequestScenario;
  readonly fixtureTurnId: string;
}

export interface FakeGatewayState {
  readonly requests: readonly FakeModelRequest[];
  beginTurn(scenario: string, fixtureTurnId: string, expectedPrompt: string): void;
  finishTurn(fixtureTurnId: string): void;
  waitForTurnRequest(fixtureTurnId: string, count?: number, timeoutMs?: number): Promise<void>;
  waitForScenarioResponse(
    scenario: FakeRequestScenario,
    fixtureTurnId: string,
    count?: number,
    timeoutMs?: number,
  ): Promise<void>;
  releaseStopTurn(fixtureTurnId: string): void;
  releaseActiveStopTurn(): void;
}

const providerPath = "/v1/chat/completions";
function respondForStep(response: ServerResponse, step: FakeResponseStep): void {
  switch (step.kind) {
    case "read":
      emitToolResponse(response, "Read", { file_path: step.path });
      return;
    case "write":
      emitToolResponse(response, "Write", { file_path: step.path, content: step.content });
      return;
    case "bash":
      emitToolResponse(response, "Bash", { command: step.command });
      return;
    case "text":
      emitTextResponse(response, step.text);
      return;
    case "title":
      emitTextResponse(response, step.text);
      return;
    case "stop":
      return;
  }
}

export async function startFakeGateway(): Promise<{
  server: ReturnType<typeof createServer>;
  state: FakeGatewayState;
  port: number;
}> {
  const requests: FakeModelRequest[] = [];
  const turns = new Map<string, FakeScenarioTurn>();
  const requestWaiters = new Map<string, Set<RequestWaiter>>();
  const scenarioResponseWaiters = new Set<ScenarioResponseWaiter>();
  let activeTurn: FakeScenarioTurn | undefined;

  const notifyScenarioResponseWaiters = (): void => {
    for (const waiter of scenarioResponseWaiters) {
      const settledCount = requests.filter(
        (request) =>
          request.scenario === waiter.scenario &&
          request.fixtureTurnId === waiter.fixtureTurnId &&
          request.settled,
      ).length;
      if (settledCount >= waiter.count) waiter.resolve();
    }
  };

  const beginTurn = (scenario: string, fixtureTurnId: string, expectedPrompt: string): void => {
    const plan = Object.hasOwn(fakeScenarioPlans, scenario)
      ? fakeScenarioPlans[scenario as NativeFakeScenario]
      : undefined;
    if (!plan) throw new Error(`unknown native fake scenario: ${scenario}`);
    if (!fixtureTurnId.trim() || !expectedPrompt.trim() || turns.has(fixtureTurnId))
      throw new Error(
        "native fake fixture turn ID and expected prompt must be non-empty and unique",
      );
    if (activeTurn) throw new Error(`native fake turn ${activeTurn.fixtureTurnId} is still active`);
    activeTurn = createFakeScenarioTurn(
      scenario as NativeFakeScenario,
      fixtureTurnId,
      expectedPrompt,
    );
    turns.set(fixtureTurnId, activeTurn);
  };

  const finishTurn = (fixtureTurnId: string): void => {
    const turn = turns.get(fixtureTurnId);
    if (!turn || turn.finished || activeTurn !== turn)
      throw new Error(`native fake turn is not active: ${fixtureTurnId}`);
    if (turn.failure) throw turn.failure;
    if (turn.requests.length !== turn.plan.length)
      throw new Error(
        `${turn.scenario} scenario ${fixtureTurnId} used ${turn.requests.length}/${turn.plan.length} expected requests`,
      );
    turn.finished = true;
    activeTurn = undefined;
  };

  const waitForTurnRequest = (
    fixtureTurnId: string,
    count = 1,
    timeoutMs = 15_000,
  ): Promise<void> => {
    const turn = turns.get(fixtureTurnId);
    if (!turn) return Promise.reject(new Error(`unknown native fake turn: ${fixtureTurnId}`));
    if (!Number.isSafeInteger(count) || count < 1)
      return Promise.reject(
        new RangeError("fake gateway request count must be a positive integer"),
      );
    if (turn.requests.length >= count) return Promise.resolve();
    if (turn.finished)
      return Promise.reject(new Error(`native fake turn ended before request ${count}`));
    return new Promise((resolvePromise, rejectPromise) => {
      const waiters = requestWaiters.get(fixtureTurnId) ?? new Set<RequestWaiter>();
      const waiter: RequestWaiter = {
        count,
        resolve: () => {
          clearTimeout(timer);
          waiters.delete(waiter);
          resolvePromise();
        },
        reject: (error) => {
          clearTimeout(timer);
          waiters.delete(waiter);
          rejectPromise(error);
        },
      };
      const timer = setTimeout(() => {
        waiter.reject(
          new Error(`native fake turn ${fixtureTurnId} did not reach request ${count}`),
        );
      }, timeoutMs);
      waiters.add(waiter);
      requestWaiters.set(fixtureTurnId, waiters);
    });
  };

  const waitForScenarioResponse = (
    scenario: FakeRequestScenario,
    fixtureTurnId: string,
    count = 1,
    timeoutMs = 15_000,
  ): Promise<void> => {
    const isSettled = (): boolean =>
      requests.filter(
        (request) =>
          request.scenario === scenario &&
          request.fixtureTurnId === fixtureTurnId &&
          request.settled,
      ).length >= count;
    if (isSettled()) return Promise.resolve();
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter: ScenarioResponseWaiter = {
        scenario,
        fixtureTurnId,
        count,
        resolve: () => {
          clearTimeout(timer);
          scenarioResponseWaiters.delete(waiter);
          resolvePromise();
        },
        reject: (error) => {
          clearTimeout(timer);
          scenarioResponseWaiters.delete(waiter);
          rejectPromise(error);
        },
      };
      const timer = setTimeout(() => {
        waiter.reject(
          new Error(`${scenario} scenario ${fixtureTurnId} did not settle response ${count}`),
        );
      }, timeoutMs);
      scenarioResponseWaiters.add(waiter);
    });
  };

  const releaseStopTurn = (fixtureTurnId: string): void => {
    const turn = turns.get(fixtureTurnId);
    if (!turn || turn.scenario !== "stop" || turn.finished || activeTurn !== turn)
      throw new Error(`native fake stop turn is not active: ${fixtureTurnId}`);
    turn.releaseStopRequest();
  };

  const releaseActiveStopTurn = (): void => {
    if (activeTurn?.scenario === "stop") activeTurn.releaseStopRequest();
  };

  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== providerPath) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "unknown native fake gateway route" } }));
      return;
    }
    let turn: FakeScenarioTurn | undefined;
    let record: FakeModelRequest | undefined;
    try {
      const body = await readJsonRequest(request);
      const titleTurn = matchingTitleTurn(body, turns.values());
      if (titleTurn) {
        record = {
          scenario: "title-generation",
          fixtureTurnId: titleTurn.fixtureTurnId,
          stage: "title",
          path: request.url ?? "",
          body,
          outcome: "accepted",
          settled: false,
        };
        const tools = body.tools;
        if (Array.isArray(tools) && tools.length > 0)
          throw new Error("title-generation sidecar unexpectedly requested tools");
        requests.push(record);
        response.writeHead(200, {
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
          connection: "keep-alive",
        });
        respondForStep(response, {
          kind: "title",
          text: JSON.stringify({ title: "Native fixture validation" }),
        });
        record.settled = true;
        notifyScenarioResponseWaiters();
        return;
      }
      turn = activeTurn;
      if (!turn) {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: "no native fake scenario matches request history" } }),
        );
        return;
      }
      if (turn.failure) throw turn.failure;
      // 原因：全局 HTTP 序号会让探针或前一轮的额外请求提前触发 deny；只按当前 scenario turn 的已验证 history 取下一步。
      const step = turn.plan[turn.requests.length];
      record = {
        scenario: turn.scenario,
        fixtureTurnId: turn.fixtureTurnId,
        stage: step?.kind ?? "unexpected",
        path: request.url ?? "",
        body,
        outcome: "accepted",
        settled: false,
      };
      turn.requests.push(record);
      requests.push(record);
      for (const waiter of requestWaiters.get(turn.fixtureTurnId) ?? [])
        if (turn.requests.length >= waiter.count) waiter.resolve();
      if (!step) throw new Error(`${turn.scenario} scenario received an unexpected model request`);
      verifyScenarioHistory(turn, record);
      response.writeHead(200, {
        "cache-control": "no-cache",
        "content-type": "text/event-stream",
        connection: "keep-alive",
      });
      await respondForStep(response, step);
      if (step.kind === "stop") {
        await turn.stopRequest;
        if (!response.writableEnded && !response.destroyed) response.end();
      }
      record.settled = true;
      notifyScenarioResponseWaiters();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (turn) turn.failure = failure;
      if (record) {
        record.outcome = "rejected";
        record.settled = true;
        notifyScenarioResponseWaiters();
      }
      if (!response.headersSent) response.writeHead(409, { "content-type": "application/json" });
      if (!response.writableEnded && !response.destroyed)
        response.end(JSON.stringify({ error: { message: failure.message } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("native fake gateway did not bind");
  return {
    server,
    state: {
      requests,
      beginTurn,
      finishTurn,
      waitForTurnRequest,
      waitForScenarioResponse,
      releaseStopTurn,
      releaseActiveStopTurn,
    },
    port: address.port,
  };
}
