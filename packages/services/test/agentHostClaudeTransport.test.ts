import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { ClaudeCodeTransport } from "../src/agent-adapters/claude-code/claudeTransport.js";
import type { ClaudeTransportEvent } from "../src/agent-adapters/claude-code/claudeTransport.js";
import type { HookCallback, Query, SDKMessage, SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

const execFileAsync = promisify(execFile);
const base = { cwd: "/tmp/claude-fixture", profileDir: "/tmp/claude-fixture-profile", gatewayUrl: "http://127.0.0.1:42123", gatewayToken: "fixture-key", model: "claude-sonnet-4-6" };

function fakeSdk(frames: SDKMessage[], exitCode = 0, onStart?: (options: Parameters<typeof import("@anthropic-ai/claude-agent-sdk").query>[0]["options"]) => Promise<void>) {
  const emitter = new EventEmitter();
  const process = Object.assign(emitter, { stdin: null, stdout: null, killed: false, exitCode: null, kill: () => true }) as unknown as SpawnedProcess;
  const queryFactory = (({ options }: { options?: Parameters<typeof import("@anthropic-ai/claude-agent-sdk").query>[0]["options"] }) => {
    const iter = (async function* () {
      options!.spawnClaudeCodeProcess!({ command: "claude", args: [], env: {}, cwd: base.cwd, signal: new AbortController().signal } as SpawnOptions);
      for (const frame of frames) {
        yield frame;
        if (frame === frames[0]) await onStart?.(options);
      }
      emitter.emit("exit", exitCode, null);
    })();
    return Object.assign(iter, { close: () => { emitter.emit("exit", null, "SIGTERM"); } }) as unknown as Query;
  }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
  return { queryFactory, spawn: () => process };
}

const init = { type: "system", subtype: "init", session_id: "native-1", claude_code_version: "2.1.263", tools: ["Edit", "Read"] } as SDKMessage;
const result = { type: "result", subtype: "success", is_error: false, session_id: "native-1" } as SDKMessage;

test("Claude SDK native session/text/tool/result is structured and successful only with zero process exit", async () => {
  const transport = new ClaudeCodeTransport({ ...base, ...fakeSdk([init, { type: "stream_event", session_id: "native-1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } }, { type: "assistant", session_id: "native-1", message: { content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "x" } }] } }, result] as SDKMessage[]) });
  const events: ClaudeTransportEvent[] = [];
  const finished = await transport.run("hello", (event) => { events.push(event); });
  assert.equal(finished.nativeSessionId, "native-1");
  assert.deepEqual(events.map((event) => event.type), ["session", "text", "tool", "result"]);
});

test("Claude SDK rejects success result followed by nonzero exit", async () => {
  const transport = new ClaudeCodeTransport({ ...base, ...fakeSdk([init, result], 143) });
  const events: string[] = [];
  await assert.rejects(transport.run("hello", (event) => events.push(event.type)), /process_exit/);
  assert.equal(events.includes("result"), false);
});

test("Claude pre-tool hook waits for decision and duplicate/late replies fail closed", async () => {
  let resolveRequest!: () => void;
  const requested = new Promise<void>((resolve) => { resolveRequest = resolve; });
  let requestId = "";
  const transport = new ClaudeCodeTransport({ ...base, ...fakeSdk([init, result], 0, async (options) => {
    const hook: HookCallback = options!.hooks!.PreToolUse![0]!.hooks[0]!;
    const blocked = hook({ hook_event_name: "PreToolUse", session_id: "native-1", tool_name: "Edit", tool_input: { file_path: "test" }, tool_use_id: "tool-1", cwd: base.cwd, transcript_path: "" }, "tool-1", { signal: options!.abortController!.signal });
    resolveRequest();
    const denied = await blocked;
    assert.equal("hookSpecificOutput" in denied && (denied.hookSpecificOutput as { permissionDecision: string }).permissionDecision, "deny");
  }) });
  const running = transport.run("hello", (event) => { if (event.type === "permission") requestId = event.id; });
  await requested;
  assert.equal(transport.reply(requestId, "deny"), true);
  assert.equal(transport.reply(requestId, "allow"), false);
  await running;
  assert.equal(transport.reply(requestId, "allow"), false);
});

test("Claude abort rejects late approval and does not complete a turn", async () => {
  let requestId = "";
  let requested!: () => void;
  const request = new Promise<void>((resolve) => { requested = resolve; });
  const transport = new ClaudeCodeTransport({ ...base, ...fakeSdk([init, result], 0, async (options) => {
    const hook = options!.hooks!.PreToolUse![0]!.hooks[0]!;
    const blocked = hook({ hook_event_name: "PreToolUse", session_id: "native-1", tool_name: "Edit", tool_input: {}, tool_use_id: "tool-2", cwd: base.cwd, transcript_path: "" }, "tool-2", { signal: options!.abortController!.signal });
    requested();
    const denied = await blocked;
    assert.equal("hookSpecificOutput" in denied && (denied.hookSpecificOutput as { permissionDecision: string }).permissionDecision, "deny");
  }) });
  const running = transport.run("hello", (event) => { if (event.type === "permission") requestId = event.id; });
  await request;
  transport.cancel();
  assert.equal(transport.reply(requestId, "allow"), false);
  await assert.rejects(running, /cancelled/);
});

test("Claude aborts oversized structured frames and does not emit a successful result", async () => {
  const transport = new ClaudeCodeTransport({ ...base, ...fakeSdk([init, { type: "system", subtype: "status", data: "x".repeat(300000) } as unknown as SDKMessage, result]) });
  await assert.rejects(transport.run("hello", () => {}), /frame_limit/);
});

test("fixed bundled Claude 2.1.263 synthetic endpoint enforces real Edit gate and cancellation", { timeout: 60000 }, async () => {
  for (const mode of ["deny", "allow", "cancel"] as const) {
    const cancel = mode === "cancel";
    const { stdout } = await execFileAsync(process.execPath, ["packages/services/test/fixtures/probeClaudeSdk.mjs"], {
      env: { ...process.env, ZCODE_CLAUDE_PROBE: "1", ZCODE_CLAUDE_PROBE_CANCEL: cancel ? "1" : "0", ZCODE_CLAUDE_PROBE_ALLOW: mode === "allow" ? "1" : "0" }, timeout: 25000,
    });
    const probe = JSON.parse(stdout) as { requests: number; events: Array<{ type: string; unchangedBeforeDenial?: boolean; accepted?: boolean }>; marker: string; error?: string };
    assert.equal(probe.requests >= 1, true);
    assert.equal(probe.marker, mode === "allow" ? "modified\n" : "original\n");
    assert.equal(probe.events.some((event) => event.type === "preExecutionCheck" && event.unchangedBeforeDenial), true);
    assert.equal(probe.events.some((event) => event.type === (cancel ? "lateReply" : "reply") && event.accepted === !cancel), true);
    assert.equal(cancel ? probe.error : probe.events.at(-1)?.type, cancel ? "Error: claude_cancelled" : "result");
  }
});

test("Claude rejects unknown Gateway origin and wrong native version", async () => {
  assert.throws(() => new ClaudeCodeTransport({ ...base, gatewayUrl: "https://example.com" }), /gateway/);
  await assert.rejects(new ClaudeCodeTransport({ ...base, ...fakeSdk([{ ...init, claude_code_version: "2.1.281" } as SDKMessage, result]) }).run("hello", () => {}), /version/);
});
