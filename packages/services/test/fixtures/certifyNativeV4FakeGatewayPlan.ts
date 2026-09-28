import {
  messageText,
  messagesFrom,
  normalizePrompt,
  type FakeGatewayJsonRecord,
} from "./certifyNativeV4FakeGatewayProtocol.js";

export type NativeFakeScenario = "full" | "followup" | "deny" | "stop";
export type FakeRequestScenario = NativeFakeScenario | "title-generation";
export type FakeResponseStep =
  | { readonly kind: "read"; readonly path: string }
  | { readonly kind: "write"; readonly path: string; readonly content: string }
  | { readonly kind: "bash"; readonly command: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "title"; readonly text: string }
  | { readonly kind: "stop" };

export interface FakeModelRequest {
  readonly scenario: FakeRequestScenario;
  readonly fixtureTurnId: string;
  readonly stage: FakeResponseStep["kind"] | "unexpected";
  readonly path: string;
  readonly body: FakeGatewayJsonRecord;
  outcome: "accepted" | "rejected";
  settled: boolean;
}

export interface FakeScenarioTurn {
  readonly scenario: NativeFakeScenario;
  readonly fixtureTurnId: string;
  readonly expectedPrompt: string;
  readonly plan: readonly FakeResponseStep[];
  readonly requests: FakeModelRequest[];
  readonly stopRequest: Promise<void>;
  releaseStopRequest(): void;
  failure?: Error;
  finished: boolean;
}

export const fakeScenarioPlans: Record<NativeFakeScenario, readonly FakeResponseStep[]> = {
  full: [
    { kind: "read", path: "output.txt" },
    { kind: "read", path: "input.txt" },
    { kind: "write", path: "output.txt", content: "native live output\n" },
    { kind: "bash", command: "node ./check.mjs" },
    { kind: "text", text: "The fixture check passed." },
  ],
  followup: [{ kind: "text", text: "The follow-up confirms the fixture check passed." }],
  deny: [
    { kind: "write", path: "../native-denied-sentinel.txt", content: "native denied sentinel\n" },
    { kind: "text", text: "native fixture denied" },
  ],
  stop: [{ kind: "stop" }],
};

const TITLE_GENERATION_PROMPT = "Generate a concise title for this coding session.";

export function isTitleGenerationRequest(body: FakeGatewayJsonRecord): boolean {
  return messagesFrom(body)
    .filter((message) => message.role === "system")
    .some((message) => messageText(message).includes(TITLE_GENERATION_PROMPT));
}

export function matchingTitleTurn(
  body: FakeGatewayJsonRecord,
  turns: Iterable<FakeScenarioTurn>,
): FakeScenarioTurn | undefined {
  // 根因：首轮标题 sidecar 可在 follow-up 激活后异步到达；按标题提示与原始输入绑定，不按 active turn 或全局请求序号归类。
  if (!isTitleGenerationRequest(body)) return undefined;
  const userPrompts = messagesFrom(body)
    .filter((message) => message.role === "user")
    .map(messageText)
    .map(normalizePrompt);
  return [...turns].find(
    (turn) =>
      turn.scenario === "full" && userPrompts.includes(normalizePrompt(turn.expectedPrompt)),
  );
}

export function createFakeScenarioTurn(
  scenario: NativeFakeScenario,
  fixtureTurnId: string,
  expectedPrompt: string,
): FakeScenarioTurn {
  let releaseStopRequest: () => void = () => undefined;
  const stopRequest = new Promise<void>((resolvePromise) => {
    releaseStopRequest = resolvePromise;
  });
  return {
    scenario,
    fixtureTurnId,
    expectedPrompt,
    plan: fakeScenarioPlans[scenario],
    requests: [],
    stopRequest,
    releaseStopRequest,
    finished: false,
  };
}

export function verifyScenarioHistory(turn: FakeScenarioTurn, request: FakeModelRequest): void {
  const messages = messagesFrom(request.body);
  const requestIndex = turn.requests.length - 1;
  if (requestIndex === 0) {
    const userPrompts = messages
      .filter((message) => message.role === "user")
      .map(messageText)
      .map(normalizePrompt);
    if (!userPrompts.includes(normalizePrompt(turn.expectedPrompt)))
      throw new Error(`${turn.scenario} first request does not contain its own user turn`);
    return;
  }
  if (messages.at(-1)?.role !== "tool")
    throw new Error(`${turn.scenario} continuation is not grounded in the prior tool result`);
}
