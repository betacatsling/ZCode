import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createClaudeHarness,
  claudeCodeManifest,
} from "../src/agent-adapters/claude-code/index.js";
import { ClaudeCodeTransport } from "../src/agent-adapters/claude-code/claudeTransport.js";
import type { TrustedClaudeProfile } from "../src/agent-adapters/claude-code/contract.js";
import type { SessionSpecV2, BindingPlan, AgentEvent } from "@zcode/shared/agent-host";
import type { Query, SDKMessage, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

const execFileAsync = promisify(execFile);
const selection = {
  providerId: "fixture",
  modelId: "m1",
  options: { reasoningLevel: "off" as const },
};
const spec = (id: string): SessionSpecV2 => ({
  schemaVersion: 2,
  hostSessionId: id,
  projectId: "p",
  workspaceId: "w",
  execution: {
    targetId: "t",
    workspaceIdentity: "repo",
    worktreePath: "/tmp/fixture",
    worktreeGeneration: "g",
    cwdRelativeToWorktree: ".",
  },
  harness: { id: "claude-code", adapterVersion: "2.1.263" },
  modelBinding: { kind: "host-managed", selection },
});
const plan = (id: string): BindingPlan => ({
  schemaVersion: 1,
  hostSessionId: id,
  targetId: "t",
  harnessId: "claude-code",
  adapterVersion: "2.1.263",
  catalogFingerprint: "snapshot",
  requested: { kind: "host-managed", selection },
  effective: selection,
  route: "messages-gateway",
  support: { support: "supported" },
  capabilities: {},
});

test("Claude adapter keeps native identity, frozen per-turn leases and independent sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-adapter-"));
  const launches: Array<{
    sessionId?: string;
    resume?: string;
    token: string;
    model: string;
    id: string;
  }> = [];
  const issued: Array<{
    turnId: string;
    requestedModelAlias: string;
    effectiveSelection: typeof selection;
  }> = [];
  const revoked: string[] = [];
  const profile: TrustedClaudeProfile = {
    root,
    verifyCwd: async () => "/tmp/fixture",
    nativeModel: () => "claude-sonnet-4-6",
    gateway: {
      url: "http://127.0.0.1:42123",
      issueToken: async (binding) => {
        issued.push({
          turnId: binding.turnId,
          requestedModelAlias: binding.requestedModelAlias,
          effectiveSelection: binding.effectiveSelection,
        });
        return `token-${binding.turnId}`;
      },
      revokeToken: (token) => {
        revoked.push(token);
      },
    },
    transportFactory: (options) => {
      const emitter = new EventEmitter();
      const child = Object.assign(emitter, {
        stdin: null,
        stdout: null,
        killed: false,
        exitCode: null,
        kill: () => true,
      }) as unknown as SpawnedProcess;
      const queryFactory = (({
        options: sdkOptions,
      }: {
        options?: Parameters<typeof import("@anthropic-ai/claude-agent-sdk").query>[0]["options"];
      }) => {
        const iter = (async function* () {
          sdkOptions!.spawnClaudeCodeProcess!({
            command: "claude",
            args: [],
            cwd: "/tmp/fixture",
            env: {},
            signal: new AbortController().signal,
          });
          const id = sdkOptions!.sessionId ?? sdkOptions!.resume!;
          launches.push({
            sessionId: sdkOptions!.sessionId,
            resume: sdkOptions!.resume,
            token: sdkOptions!.env!.ANTHROPIC_API_KEY!,
            model: sdkOptions!.model!,
            id,
          });
          yield {
            type: "system",
            subtype: "init",
            session_id: id,
            claude_code_version: "2.1.263",
          } as SDKMessage;
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "ok" },
            },
          } as SDKMessage;
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: id,
          } as SDKMessage;
          emitter.emit("exit", 0, null);
        })();
        return Object.assign(iter, { close: () => {} }) as unknown as Query;
      }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
      return new ClaudeCodeTransport({ ...options, queryFactory, spawn: () => child });
    },
  };
  try {
    const adapter = createClaudeHarness(profile);
    assert.equal(claudeCodeManifest.id, adapter.id);
    const target = {
      id: "t",
      kind: "local" as const,
      platform: process.platform as "darwin",
      available: true,
    };
    assert.match(
      (await adapter.hostManagedSupport(target, selection)).reason!,
      /claude-code-20250219/,
    );
    assert.equal((await adapter.capabilities(target)).text.support, "unsupported");
    const a = spec("a"),
      b = spec("b");
    const ba = await adapter.create(a, plan("a")),
      bb = await adapter.create(b, plan("b"));
    assert.notEqual(ba.backendSessionId, bb.backendSessionId);
    const events: AgentEvent[] = [];
    adapter.subscribe("a", (event) => events.push(event));
    await adapter.prepareTurn!(a, { turnId: "ta", runtimeEpoch: ba.runtimeEpoch, plan: plan("a") });
    await assert.rejects(
      adapter.prepareTurn!(a, { turnId: "wrong", runtimeEpoch: ba.runtimeEpoch, plan: plan("a") }),
      /prepared|stale/,
    );
    await adapter.send({
      type: "send",
      hostSessionId: "a",
      commandId: "ca",
      turnId: "ta",
      text: "one",
    });
    await adapter.prepareTurn!(a, {
      turnId: "ta2",
      runtimeEpoch: ba.runtimeEpoch,
      plan: plan("a"),
    });
    await adapter.send({
      type: "send",
      hostSessionId: "a",
      commandId: "ca2",
      turnId: "ta2",
      text: "two",
    });
    await adapter.prepareTurn!(b, { turnId: "tb", runtimeEpoch: bb.runtimeEpoch, plan: plan("b") });
    await adapter.send({
      type: "send",
      hostSessionId: "b",
      commandId: "cb",
      turnId: "tb",
      text: "other",
    });
    assert.deepEqual(
      launches.map(({ sessionId, resume, token }) => [sessionId, resume, token]),
      [
        [ba.backendSessionId, undefined, "token-ta"],
        [undefined, ba.backendSessionId, "token-ta2"],
        [bb.backendSessionId, undefined, "token-tb"],
      ],
    );
    assert.deepEqual(revoked, ["token-ta", "token-ta2", "token-tb"]);
    assert.deepEqual(
      issued.map((entry) => entry.requestedModelAlias),
      ["claude-sonnet-4-6", "claude-sonnet-4-6", "claude-sonnet-4-6"],
    );
    assert.equal(events.filter((event) => event.kind === "turn.finished").length, 2);
    assert.deepEqual(
      events.map((event) => event.sequence),
      events.map((_, index) => index + 1),
    );
    await adapter.shutdown?.();
    const restored = createClaudeHarness(profile);
    await restored.attach(a, ba, events.length, plan("a"));
    await assert.rejects(
      restored.attach(
        a,
        { ...ba, backendSessionId: bb.backendSessionId },
        events.length,
        plan("a"),
      ),
      /stale/,
    );
    await restored.shutdown();
    await assert.rejects(createClaudeHarness(profile).create(a, plan("a")), /EEXIST/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude failed native launch revokes frozen lease and leaves durable uncommitted intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-fail-"));
  const revoked: string[] = [];
  const profile: TrustedClaudeProfile = {
    root,
    verifyCwd: async () => "/tmp/fixture",
    nativeModel: () => "claude-sonnet-4-6",
    gateway: {
      url: "http://127.0.0.1:42123",
      issueToken: async () => "token-fail",
      revokeToken: (token) => {
        revoked.push(token);
      },
    },
    transportFactory: () => {
      throw new Error("launch failed");
    },
  };
  try {
    const a = spec("fail"),
      p = plan("fail"),
      adapter = createClaudeHarness(profile),
      binding = await adapter.create(a, p);
    await adapter.prepareTurn(a, { turnId: "t", runtimeEpoch: binding.runtimeEpoch, plan: p });
    await assert.rejects(
      adapter.send({
        type: "send",
        hostSessionId: a.hostSessionId,
        turnId: "t",
        commandId: "c",
        text: "prompt",
      }),
      /launch failed/,
    );
    assert.deepEqual(revoked, ["token-fail"]);
    await assert.rejects(
      adapter.prepareTurn(a, { turnId: "again", runtimeEpoch: binding.runtimeEpoch, plan: p }),
      /stale/,
    );
    await assert.rejects(createClaudeHarness(profile).attach(a, binding, 1, p), /uncommitted/);
    await adapter.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "actual pinned CLI joins adapter mock leases to fake endpoint across two turns; denied Edit has no side effect",
  { timeout: 60000 },
  async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "packages/services/test/fixtures/probeClaudeAdapter.mjs"],
      { env: { ...process.env, ZCODE_CLAUDE_PROBE: "1" }, timeout: 45000 },
    );
    const result = JSON.parse(stdout) as {
      marker: string;
      requests: number;
      issued: string[];
      revokedCount: number;
      distinctTokens: boolean;
      modelMatches: boolean;
      events: Array<{ kind: string; turnId: string }>;
    };
    assert.equal(result.marker, "original\n");
    assert.equal(result.requests, 3);
    assert.deepEqual(result.issued, ["one", "two"]);
    assert.equal(result.revokedCount, 2);
    assert.equal(result.distinctTokens && result.modelMatches, true);
    assert.equal(
      result.events.some(
        (event) => event.kind === "interaction.resolved" && event.turnId === "one",
      ),
      true,
    );
    assert.equal(
      result.events.some((event) => event.kind === "tool.finished" && event.turnId === "one"),
      true,
    );
    assert.deepEqual(
      result.events.filter((event) => event.kind === "turn.finished").map((event) => event.turnId),
      ["one", "two"],
    );
  },
);

test(
  "official pinned CLI accepts supplied sessionId then resumes same native identity in a fresh process",
  { timeout: 60000 },
  async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["packages/services/test/fixtures/probeClaudeResume.mjs"],
      { env: { ...process.env, ZCODE_CLAUDE_PROBE: "1" }, timeout: 45000 },
    );
    const result = JSON.parse(stdout) as {
      firstMatches: boolean;
      secondMatches: boolean;
      requests: number;
    };
    assert.deepEqual(result, { firstMatches: true, secondMatches: true, requests: 2 });
  },
);

test("Claude binding cannot silently reattach uncommitted native state or change frozen route", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-adapter-"));
  try {
    const profile: TrustedClaudeProfile = {
      root,
      verifyCwd: async () => "/tmp/fixture",
      nativeModel: () => "claude-sonnet-4-6",
      gateway: {
        url: "http://127.0.0.1:42123",
        issueToken: async () => "token",
        revokeToken: () => {},
      },
    };
    const a = spec("a"),
      p = plan("a"),
      adapter = createClaudeHarness(profile),
      binding = await adapter.create(a, p);
    await assert.rejects(createClaudeHarness(profile).attach(a, binding, 1, p), /uncommitted/);
    await assert.rejects(
      adapter.prepareTurn!(a, { turnId: "t", runtimeEpoch: "wrong", plan: p }),
      /stale/,
    );
    await assert.rejects(
      adapter.prepareTurn!(a, {
        turnId: "t",
        runtimeEpoch: binding.runtimeEpoch,
        plan: { ...p, effective: { ...selection, modelId: "m2" } },
      }),
      /mismatch/,
    );
    await adapter.shutdown?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
