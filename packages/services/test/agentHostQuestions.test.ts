import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentCommand, AgentEvent } from "@zcode/shared/agent-host";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { MockHarness } from "../src/agent-host/mockHarness.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";

class QuestionHarness extends MockHarness {
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  #seq = 0;
  #epoch = "";
  #id = "";
  #turn = "";
  #settle?: () => void;
  delayAnswerEvent = false;
  answers: string[] = [];
  settleSendWithoutSourceResolution() { this.#settle?.(); }
  confirmAnswer() {
    this.#emit("question.answered", { interactionId: "question-1" });
    this.#emit("turn.finished", { outcome: "success" });
    this.#settle?.();
  }
  override subscribe(_id: string, listener: (event: AgentEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  override async capabilities(target: Parameters<MockHarness["capabilities"]>[0]) {
    return { ...await super.capabilities(target), questions: { support: "supported" as const } };
  }
  #emit(kind: AgentEvent["kind"], fields: Record<string, unknown>) {
    const event = { hostSessionId: this.#id, runtimeEpoch: this.#epoch, sequence: ++this.#seq,
      eventId: `native-${this.#seq}`, at: Date.now(), kind, turnId: this.#turn, ...fields } as AgentEvent;
    for (const listener of this.#listeners) listener(event);
  }
  override async send(command: Extract<AgentCommand, { type: "send" }>) {
    this.#id = command.hostSessionId;
    this.#turn = command.turnId;
    this.#emit("turn.started", {});
    this.#emit("question.requested", { interactionId: "question-1", prompt: "Which?", freeText: true });
    await new Promise<void>((resolve) => { this.#settle = resolve; });
  }
  async answerInteraction(command: Extract<AgentCommand, { type: "answerInteraction" }>) {
    this.answers.push(command.answer);
    if (!this.delayAnswerEvent) this.confirmAnswer();
  }
  setEpoch(epoch: string) { this.#epoch = epoch; }
}

test("Host journals a question before answering, rejects permission masquerade/stale epoch and duplicate answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-question-"));
  const worktree = join(root, "tree");
  await mkdir(worktree);
  const adapter = new QuestionHarness();
  const registry = new HarnessRegistry();
  registry.register(adapter);
  const spec = { schemaVersion: 2 as const, hostSessionId: "q", projectId: "p", workspaceId: "w", execution: {
    targetId: "local", workspaceIdentity: "w", worktreePath: worktree, worktreeGeneration: "g", cwdRelativeToWorktree: ".",
  }, harness: { id: "mock", adapterVersion: "1.0.0" }, modelBinding: { kind: "host-managed" as const, selection: { providerId: "p", modelId: "m" } } };
  let host: SessionHost | undefined;
  try {
    host = await SessionHost.create({ root: join(root, "journals"), spec, target: { id: "local", kind: "local", platform: "darwin", available: true }, registry,
      catalog: { fingerprint: "f", validateSelection: () => ({ ok: true }) } });
    adapter.setEpoch(host.binding.runtimeEpoch);
    assert.equal((await host.dispatch({ type: "send", hostSessionId: "q", turnId: "t", commandId: "send", text: "ask" })).status, "accepted");
    await host.whenEventsRecorded();
    assert.equal(host.snapshot().pendingInteractions[0]?.kind, "userInput");
    const stale = { type: "answerInteraction" as const, commandId: "stale", hostSessionId: "q", runtimeEpoch: "prior", turnId: "t", interactionId: "question-1", answer: "a" };
    assert.equal((await host.dispatch(stale)).reasonCode, "stale-interaction");
    assert.equal((await host.dispatch({ type: "resolveInteraction", commandId: "wrong-kind", hostSessionId: "q", runtimeEpoch: host.binding.runtimeEpoch, turnId: "t", interactionId: "question-1", decision: "allow" })).reasonCode, "stale-interaction");
    const answer = { ...stale, commandId: "answer", runtimeEpoch: host.binding.runtimeEpoch };
    assert.equal((await host.dispatch(answer)).status, "completed");
    assert.equal((await host.dispatch(answer)).status, "duplicate");
    assert.equal((await host.dispatch({ ...answer, commandId: "late" })).reasonCode, "stale-interaction");
    await host.whenIdle();
    assert.deepEqual(adapter.answers, ["a"]);
    assert.equal(host.snapshot().pendingInteractions.length, 0);
  } finally {
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("two command IDs cannot answer one unresolved question; restart keeps reservation and receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-question-reservation-"));
  const worktree = join(root, "tree");
  await mkdir(worktree);
  const adapter = new QuestionHarness();
  adapter.delayAnswerEvent = true;
  const registry = new HarnessRegistry();
  registry.register(adapter);
  const spec = { schemaVersion: 2 as const, hostSessionId: "q", projectId: "p", workspaceId: "w", execution: {
    targetId: "local", workspaceIdentity: "w", worktreePath: worktree, worktreeGeneration: "g", cwdRelativeToWorktree: ".",
  }, harness: { id: "mock", adapterVersion: "1.0.0" }, modelBinding: { kind: "host-managed" as const, selection: { providerId: "p", modelId: "m" } } };
  const options = { root: join(root, "journals"), spec, target: { id: "local", kind: "local" as const, platform: "darwin" as const, available: true }, registry,
    catalog: { fingerprint: "f", validateSelection: () => ({ ok: true as const }) } };
  let host: SessionHost | undefined;
  try {
    host = await SessionHost.create(options);
    adapter.setEpoch(host.binding.runtimeEpoch);
    assert.equal((await host.dispatch({ type: "send", hostSessionId: "q", turnId: "t", commandId: "send", text: "ask" })).status, "accepted");
    await host.whenEventsRecorded();
    const answer = { type: "answerInteraction" as const, commandId: "first", hostSessionId: "q", runtimeEpoch: host.binding.runtimeEpoch,
      turnId: "t", interactionId: "question-1", answer: "a" };
    const alternate = { ...answer, commandId: "second", answer: "b" };
    const [first, second] = await Promise.all([host.dispatch(answer), host.dispatch(alternate)]);
    assert.equal(first.status, "completed");
    assert.deepEqual(second, { commandId: "second", status: "execution-unknown", reasonCode: "execution-unknown" });
    assert.equal((await host.dispatch(answer)).status, "duplicate");
    assert.deepEqual(adapter.answers, ["a"]);
    assert.equal(host.snapshot().pendingInteractions[0]?.kind, "userInput");
    adapter.settleSendWithoutSourceResolution();
    await host.whenIdle();
    await host.close();
    host = undefined;

    assert.equal((await SessionHost.queryCommandHistory(options.root, spec, "first"))?.status, "completed");
    assert.equal((await SessionHost.queryCommandHistory(options.root, spec, "second"))?.status, "execution-unknown");
    host = await SessionHost.open(options);
    assert.equal(host.snapshot().pendingInteractions[0]?.kind, "userInput");
    assert.equal(host.queryCommand("first")?.status, "completed");
    assert.equal((await host.dispatch({ ...answer, commandId: "after-restart", answer: "c" })).status, "execution-unknown");
    assert.deepEqual(adapter.answers, ["a"]);
    adapter.confirmAnswer();
    await host.whenEventsRecorded();
    assert.equal(host.snapshot().pendingInteractions.length, 0);
    assert.equal((await host.dispatch({ ...answer, commandId: "stale-after-source" })).reasonCode, "stale-interaction");
  } finally {
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
});
