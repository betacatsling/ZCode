/**
 * P6 thin knife — OpenCode/Goose ACP opt-in factories through SessionHost (fake transport).
 *
 * Proves same-protocol Agents register via explicit factory + loadExplicit trust list
 * without changing lazy Host defaults or the shared ACP session machine. Goose SessionHost
 * path is symmetric to OpenCode (#75). Late prompt + transport fault/disconnect still journal via SessionHost (OpenCode + Goose). Resume-after-disconnect: SessionHost.open attach via negotiated session/load then send again. Cancel-after-disconnect: after fault fence, cancel of the dead turn is stale; after reopen+session/load, cancel mid-prompt journals cancelled (OpenCode + Goose). Double-fault/reopen: fault→reopen→fault→reopen stays idempotent (session/load, no session/new) then send succeeds (OpenCode + Goose). Mid-tool-call disconnect: tool_call + pending permission then fault → reopen session/load → send (OpenCode + Goose). Permission-denied-then-disconnect: Host denies permission, peer then faults the prompt (OpenCode + Goose). Cancel-during-permission: Host cancelTurn while permission pending journals cancelled (OpenCode + Goose). Permission-resolve-after-reopen: fault mid-permission → reopen → deny still clean (OpenCode + Goose). Allow-after-reopen: fault mid-permission → reopen → fresh allow completes send (OpenCode + Goose). Double-cancel: cancelTurn×2 mid-prompt is idempotent (one cancelled outcome; OpenCode + Goose). Allow-then-disconnect: Host allows permission then peer faults mid-turn (OpenCode + Goose). Cancel-then-disconnect: Host cancel mid-prompt then peer faults (OpenCode + Goose). Deny-then-cancel: Host deny pending permission then cancelTurn journals clean (OpenCode + Goose). Allow-then-cancel: Host allow pending permission then cancelTurn journals clean (OpenCode + Goose). Fault-during-session-load: reopen attach session/load mid-fault fails clean (OpenCode + Goose). Load-then-cancel: after reopen session/load succeeds, cancelTurn before first send is stale (OpenCode + Goose). Cancel-during-session-load: while reopen session/load is held in-flight, aborting the pending load rejects open clean (Host.cancelTurn cannot race mid-load — open awaits attach; OpenCode + Goose). Load-then-disconnect: after reopen session/load succeeds, peer transport close before first send stays idle until next send faults clean (OpenCode + Goose). Permission-during-session-load: while reopen session/load is held in-flight, peer session/request_permission is rejected as stale (no active turn) then load completes (OpenCode + Goose). Disconnect-during-session-load: while reopen session/load is held in-flight, peer idle transport.close (no JSON-RPC error reply) rejects open clean (OpenCode + Goose). Load-then-send / mid-load prompt: while reopen session/load held, peer agent_message_chunk is replay-swallowed (acp.replay applied:false) then first send succeeds (OpenCode + Goose). Load-then-permission-deny: after reopen session/load succeeds, first send hits permission and Host deny journals clean with no new fault (OpenCode + Goose). Load-then-permission-allow: after reopen session/load succeeds, first send hits permission and Host allow completes the turn with no new fault (OpenCode + Goose). Disconnect-during-permission: Host journals interaction.requested then peer JSON-RPC faults+closes before resolve/cancel → fault/unknown, no interaction.resolved (OpenCode + Goose). Disconnect-during-permission-then-reopen: after that fence, SessionHost.open session/load then first send succeeds (OpenCode + Goose). Idle-close-during-permission: after interaction.requested, peer closes transport without a JSON-RPC error reply → fault/unknown, no interaction.resolved or reopen round (OpenCode + Goose). Idle-close-during-permission-then-reopen: after that idle-close fence, SessionHost.open session/load then first send succeeds (OpenCode + Goose). Idle-close-then-fault/reopen: idle-close-during-permission→reopen→JSON-RPC fault mid-prompt→reopen stays idempotent (session/load, no session/new) then send succeeds (OpenCode + Goose). Cancel-after-idle-close: after #236 idle-close-during-permission fence, cancelTurn of the dead turn is stale-turn and resolveInteraction is stale-interaction; after reopen+session/load, cancel mid-prompt journals cancelled (OpenCode + Goose). Allow-after-idle-close-reopen: after #236 idle-close-during-permission fence, SessionHost.open session/load then fresh permission allow completes send (OpenCode + Goose; ≠ #136 JSON-RPC fault fence / ≠ #242 send-without-permission / ≠ #256 cancel path). Deny-after-idle-close-reopen: after #236 idle-close-during-permission fence, stale deny is stale-interaction; after reopen session/load, fresh permission deny journals clean (OpenCode + Goose; ≠ #260 allow / ≠ #134 JSON-RPC fault fence / ≠ #195 load-then-permission-deny / ≠ #256 cancel). Double-send-after-idle-close-reopen: after #236 idle-close-during-permission fence, SessionHost.open session/load then two consecutive plain sends both succeed (OpenCode + Goose; ≠ #242 single first-send / ≠ #248 idle-close-then-fault / ≠ #260/#263 permission allow/deny / ≠ #256 cancel). Cancel-after-idle-close-reopen: after #236 idle-close-during-permission fence, stale cancel is stale-turn; after reopen session/load, fresh permission pending then cancelTurn journals cancelled (OpenCode + Goose; ≠ #256 mid-prompt holdUntilCancel / ≠ cancel-during-permission with no idle-close fence / ≠ #260 allow / ≠ #263 deny / ≠ #265 double plain send). Double-cancel-after-idle-close-reopen: after #236 idle-close-during-permission fence, stale cancel is stale-turn; after reopen session/load, mid-prompt cancelTurn×2 is idempotent (one cancelled outcome; OpenCode + Goose; ≠ #140 no idle-close fence / ≠ #256 single mid-prompt cancel / ≠ #269 cancel-during-permission / ≠ #260/#263/#265). Allow-then-cancel-after-idle-close-reopen: after #236 idle-close-during-permission fence, stale cancel is stale-turn; after reopen session/load, fresh permission allow then cancelTurn journals clean cancelled (OpenCode + Goose; ≠ #260 allow-completes-send / ≠ #269 cancel-during-permission / ≠ #274 mid-prompt double-cancel / ≠ allow-then-cancel with no idle-close fence / ≠ #263 deny). Deny-then-cancel-after-idle-close-reopen: after #236 idle-close-during-permission fence, stale cancel is stale-turn; after reopen session/load, fresh permission deny then cancelTurn journals clean cancelled (OpenCode + Goose; ≠ #263 deny-completes / ≠ #269 cancel-during-permission / ≠ #280 allow-then-cancel / ≠ deny-then-cancel with no idle-close fence / ≠ #260 allow). Allow-then-disconnect-then-reopen: after allow-then-disconnect fence (interaction.resolved allow + fault/unknown), SessionHost.open session/load then first send succeeds (OpenCode + Goose; ≠ #229 disconnect-during-permission-then-reopen which has no resolve / ≠ #242 idle-close-then-reopen / ≠ allow-then-disconnect with no reopen round). Cancel-then-disconnect-then-reopen: after cancel-then-disconnect fence (turn.finished cancelled + fault/unknown), SessionHost.open session/load then first send succeeds (OpenCode + Goose; ≠ #288 allow-then-disconnect-then-reopen / ≠ #229 disconnect-during-permission-then-reopen / ≠ cancel-then-disconnect with no reopen round / ≠ idle-close family). Deny-then-disconnect-then-reopen: after permission-denied-then-disconnect fence (interaction.resolved deny + fault/unknown), SessionHost.open session/load then first send succeeds (OpenCode + Goose; ≠ #288 allow-then-disconnect-then-reopen / ≠ #291 cancel-then-disconnect-then-reopen / ≠ #229 disconnect-during-permission-then-reopen which has no resolve / ≠ permission-denied-then-disconnect with no reopen round / ≠ idle-close family). Allow-then-disconnect-then-fault-reopen: after allow-then-disconnect fence (interaction.resolved allow + fault/unknown), reopen→JSON-RPC mid-prompt fault→reopen stays idempotent (session/load, no session/new) then send succeeds (OpenCode + Goose; ≠ #288 first-send-only / ≠ #248 idle-close fence / ≠ #118 plain double-fault / ≠ #291/#294 cancel/deny-then-disconnect-then-reopen / ≠ idle-close family). Cancel-then-disconnect-then-fault-reopen: after cancel-then-disconnect fence (turn.finished cancelled + fault/unknown), reopen→JSON-RPC mid-prompt fault→reopen stays idempotent (session/load, no session/new) then send succeeds (OpenCode + Goose; ≠ #291 first-send-only / ≠ #299 allow-then-disconnect fence / ≠ #248 idle-close fence / ≠ #118 plain double-fault / ≠ #294 deny-then-disconnect-then-reopen / ≠ idle-close family). Deny-then-disconnect-then-fault-reopen: after permission-denied-then-disconnect fence (interaction.resolved deny + fault/unknown), reopen→JSON-RPC mid-prompt fault→reopen stays idempotent (session/load, no session/new) then send succeeds (OpenCode + Goose; ≠ #294 first-send-only / ≠ #299 allow-then-disconnect fence / ≠ #302 cancel-then-disconnect fence / ≠ #248 idle-close fence / ≠ #118 plain double-fault / ≠ idle-close family).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ACP_ADAPTER_VERSION,
  createExperimentalRegistryGooseAcpHarness,
  createExperimentalRegistryOpenCodeAcpHarness,
  gooseAcpProfile,
  linkAcpTransports,
  openCodeAcpProfile,
  type AcpJsonRpcMessage,
  type AcpTransport,
} from "../src/agent-adapters/acp/index.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { loadExplicitHarnessPlugins } from "../src/agent-host/harnessPluginLoader.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";

const here = dirname(fileURLToPath(import.meta.url));
const lazySrc = join(here, "../src/agent-host/lazyTargetService.ts");

interface FakePeerOptions {
  /** Delay before answering session/prompt (late-response path). */
  readonly promptDelayMs?: number;
  /**
   * Mid-prompt transport fault: emit a partial chunk, then JSON-RPC error + close
   * (mirrors ACP transport closed without hanging the Host wait).
   */
  readonly disconnectOnPrompt?: boolean;
  /** Advertise agentCapabilities.loadSession so SessionHost.open → attach can resume. */
  readonly loadSession?: boolean;
  /**
   * Fault mid session/load (or session/resume): JSON-RPC error + close instead of
   * returning sessionId (reopen attach path; fault-during-session-load).
   */
  readonly faultOnSessionLoad?: boolean;
  /**
   * Hold session/load (or session/resume) unanswered until abortHeldSessionLoad() —
   * mirrors holdUntilCancel for prompts (cancel-during-session-load / abort in-flight open).
   */
  readonly holdOnSessionLoad?: boolean;
  readonly permissionWhileHeldSessionLoad?: boolean;
  /**
   * While session/load is held unanswered, emit agent_message_chunk session/update(s)
   * (prompt-like mid-load / #replaying traffic), then complete load successfully
   (load-then-send / mid-load prompt; Host must swallow as acp.replay applied:false).
   */
  readonly promptWhileHeldSessionLoad?: boolean;
  /**
   * Emit a partial chunk, then wait for session/cancel before answering with stopReason cancelled
   * (SessionHost cancelTurn mid-prompt path).
   */
  readonly holdUntilCancel?: boolean;
  /**
   * Emit a partial chunk, wait for session/cancel, then fault the prompt
   * (Host cancel mid-prompt → peer disconnect; cancel-then-disconnect).
   */
  readonly disconnectAfterCancel?: boolean;
  /**
   * Mid-tool-call transport fault: emit tool_call + pending session/request_permission,
   * then JSON-RPC error + close (permission left unresolved).
   */
  readonly disconnectOnToolCall?: boolean;
  /**
   * Emit tool_call + await session/request_permission; after Host responds (deny),
   * fault the prompt with JSON-RPC error + close.
   */
  readonly disconnectAfterPermissionDenied?: boolean;
  /**
   * Emit tool_call + await session/request_permission; after Host deny, hold until
   * session/cancel then answer cancelled (deny-then-cancel).
   */
  readonly holdAfterPermissionDenied?: boolean;
  /**
   * Emit tool_call + await session/request_permission; after Host allow, hold until
   * session/cancel then answer cancelled (allow-then-cancel).
   */
  readonly holdAfterPermissionAllowed?: boolean;
  /**
   * Emit tool_call + await session/request_permission; after Host responds (allow),
   * fault the prompt with JSON-RPC error + close (allow-then-disconnect mid-turn).
   */
  readonly disconnectAfterPermissionAllowed?: boolean;
  /**
   * Emit tool_call + await session/request_permission; Host cancelTurn rejects the
   * permission and notifies session/cancel; peer then answers prompt as cancelled.
   */
  readonly cancelDuringPermission?: boolean;
  /**
   * Emit tool_call + pending session/request_permission and hold the prompt unanswered
   * until faultDuringPendingPermission() (JSON-RPC error + close) after Host journals
   * interaction.requested (disconnect-during-permission; ≠ disconnectOnToolCall which
   * faults immediately with no Host wait gate).
   */
  readonly disconnectDuringPermission?: boolean;
  /**
   * Emit tool_call + await session/request_permission; after Host responds (deny/allow),
   * complete the prompt with end_turn (post-reopen clean resolve path).
   */
  readonly awaitPermissionThenContinue?: boolean;
}

/** Minimal fake ACP peer: initialize / session/new / session/prompt. */
class FakePeer {
  readonly methods: string[] = [];
  readonly #transport: AcpTransport;
  readonly #sessionId: string;
  readonly #agentName: string;
  readonly #options: FakePeerOptions;
  #cancelled = false;
  #cancelWaiters: Array<() => void> = [];
  #holdingSessionLoad = false;
  #sessionLoadHoldWaiters: Array<() => void> = [];
  /** When set, held session/load wakes into idle close (no JSON-RPC error reply). */
  #idleCloseHeld = false;
  #permissionRejectedDuringHeldLoad = false;
  #permissionRejectMessage?: string;
  #promptEmittedDuringHeldLoad = false;
  #holdingPermission = false;
  #heldPromptId: string | number | null = null;
  #permissionHoldWaiters: Array<() => void> = [];
  readonly #pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    transport: AcpTransport,
    sessionId: string,
    agentName: string,
    options: FakePeerOptions = {},
  ) {
    this.#transport = transport;
    this.#sessionId = sessionId;
    this.#agentName = agentName;
    this.#options = options;
    transport.subscribe((message) => {
      void this.#receive(message);
    });
  }

  /** True while FakePeer has received session/load|resume and has not yet answered. */
  get holdingSessionLoad(): boolean {
    return this.#holdingSessionLoad;
  }
  get permissionRejectedDuringHeldLoad(): boolean {
    return this.#permissionRejectedDuringHeldLoad;
  }
  get permissionRejectMessage(): string | undefined {
    return this.#permissionRejectMessage;
  }
  get promptEmittedDuringHeldLoad(): boolean {
    return this.#promptEmittedDuringHeldLoad;
  }
  /** True while disconnectDuringPermission has emitted permission and awaits fault. */
  get holdingPermission(): boolean {
    return this.#holdingPermission;
  }

  /**
   * Abort an in-flight held session/load (cancel-during-session-load concurrent path).
   * Host.cancelTurn cannot run until SessionHost.open returns; open awaits attach/load.
   */
  abortHeldSessionLoad(): void {
    if (!this.#holdingSessionLoad) throw new Error("session/load is not held");
    for (const wake of this.#sessionLoadHoldWaiters) wake();
    this.#sessionLoadHoldWaiters = [];
  }

  /**
   * Idle-close an in-flight held session/load (disconnect-during-session-load).
   * Closes the transport only — no JSON-RPC error reply for the pending load id —
   * so Host open sees transport closed mid-await (distinct from abortHeldSessionLoad).
   */
  async idleCloseHeldSessionLoad(): Promise<void> {
    if (!this.#holdingSessionLoad) throw new Error("session/load is not held");
    this.#idleCloseHeld = true;
    for (const wake of this.#sessionLoadHoldWaiters) wake();
    this.#sessionLoadHoldWaiters = [];
    await this.#transport.close();
  }

  /**
   * Idle peer transport fault: close without an in-flight RPC
   * (load-then-disconnect after successful session/load).
   */
  async disconnect(): Promise<void> {
    await this.#transport.close();
  }

  /**
   * Fault a held disconnectDuringPermission prompt: JSON-RPC error + close
   * (Host wait gate already passed — ≠ disconnectOnToolCall immediate fault).
   */
  async faultDuringPendingPermission(): Promise<void> {
    if (!this.#holdingPermission || this.#heldPromptId === null) {
      throw new Error("permission prompt is not held");
    }
    const promptId = this.#heldPromptId;
    for (const wake of this.#permissionHoldWaiters) wake();
    this.#permissionHoldWaiters = [];
    await this.#transport.send({
      jsonrpc: "2.0",
      id: promptId,
      error: { code: -32000, message: "ACP transport closed" },
    });
    await this.#transport.close();
  }

  /**
   * Idle-close a held disconnectDuringPermission prompt: transport close only,
   * with no JSON-RPC error reply for the pending prompt id.
   */
  async idleCloseDuringPendingPermission(): Promise<void> {
    if (!this.#holdingPermission || this.#heldPromptId === null) {
      throw new Error("permission prompt is not held");
    }
    for (const wake of this.#permissionHoldWaiters) wake();
    this.#permissionHoldWaiters = [];
    await this.#transport.close();
  }

  async #agentRequest(method: string, params: unknown): Promise<unknown> {
    const id = `agent-${this.methods.length}-${this.#pending.size}`;
    const result = new Promise((resolve, reject) => {
      this.#pending.set(String(id), { resolve, reject });
    });
    await this.#transport.send({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  async #receive(message: AcpJsonRpcMessage): Promise<void> {
    if (message.method === undefined && message.id !== undefined && message.id !== null) {
      const pending = this.#pending.get(String(message.id));
      if (!pending) return;
      this.#pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.methods.push(message.method);
    if (message.method === "session/cancel") {
      this.#cancelled = true;
      for (const wake of this.#cancelWaiters) wake();
      this.#cancelWaiters = [];
    }
    if (message.id === undefined || message.id === null) return;
    if (message.method === "initialize") {
      await this.#transport.send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            promptCapabilities: {},
            ...(this.#options.loadSession ? { loadSession: true } : {}),
          },
          authMethods: [],
          agentInfo: { name: this.#agentName, version: "1.0.0" },
        },
      });
      return;
    }
    if (message.method === "session/new") {
      await this.#transport.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { sessionId: this.#sessionId },
      });
      return;
    }
    if (message.method === "session/load" || message.method === "session/resume") {
      if (this.#options.faultOnSessionLoad) {
        await this.#transport.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "ACP transport closed" },
        });
        await this.#transport.close();
        return;
      }
      if (this.#options.holdOnSessionLoad) {
        this.#holdingSessionLoad = true;
        try {
          if (this.#options.permissionWhileHeldSessionLoad) {
            // Peer emits tool_call + permission while session/load RPC is still unanswered.
            // Host has no active turn during attach/load → rejects as stale; load then completes.
            await this.#transport.send({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: this.#sessionId,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: "tool-perm-during-load",
                  title: "write",
                  status: "pending",
                },
              },
            });
            try {
              await this.#agentRequest("session/request_permission", {
                sessionId: this.#sessionId,
                toolCall: { toolCallId: "tool-perm-during-load", title: "Write a file?" },
                options: [
                  { optionId: "allow", kind: "allow_once" },
                  { optionId: "reject", kind: "reject_once" },
                ],
              });
            } catch (error) {
              this.#permissionRejectedDuringHeldLoad = true;
              this.#permissionRejectMessage =
                error instanceof Error ? error.message : String(error);
            }
            await this.#transport.send({
              jsonrpc: "2.0",
              id: message.id,
              result: { sessionId: this.#sessionId },
            });
            return;
          }
          if (this.#options.promptWhileHeldSessionLoad) {
            // Peer emits prompt-like agent_message_chunk while session/load RPC is unanswered.
            // Host AcpSessionMachine.resumeNative sets #replaying during load → chunks counted
            // as replay (not journal body); load then completes successfully.
            for (const text of ["mid-load replay chunk", "mid-load replay chunk 2"]) {
              await this.#transport.send({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: this.#sessionId,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text },
                  },
                },
              });
            }
            this.#promptEmittedDuringHeldLoad = true;
            await this.#transport.send({
              jsonrpc: "2.0",
              id: message.id,
              result: { sessionId: this.#sessionId },
            });
            return;
          }
          await new Promise<void>((resolve) => {
            this.#sessionLoadHoldWaiters.push(resolve);
          });
        } finally {
          this.#holdingSessionLoad = false;
        }
        // Idle peer close mid-load: transport already closed (or close now) — no JSON-RPC error reply.
        if (this.#idleCloseHeld) {
          this.#idleCloseHeld = false;
          await this.#transport.close();
          return;
        }
        // Concurrent abort of held load — open must reject clean (no hang).
        await this.#transport.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "ACP transport closed" },
        });
        await this.#transport.close();
        return;
      }
      await this.#transport.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { sessionId: this.#sessionId },
      });
      return;
    }
    if (message.method === "session/prompt") {
      const delay = this.#options.promptDelayMs ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      if (this.#options.holdUntilCancel) {
        await this.#transport.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.#sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "partial before cancel" },
            },
          },
        });
        if (!this.#cancelled) {
          await new Promise<void>((resolve) => {
            this.#cancelWaiters.push(resolve);
          });
        }
        await this.#transport.send({
          jsonrpc: "2.0",
          id: message.id,
          result: { stopReason: "cancelled" },
        });
        return;
      }
      if (this.#options.disconnectAfterCancel) {
        await this.#transport.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.#sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "partial before cancel-disconnect" },
            },
          },
        });
        if (!this.#cancelled) {
          await new Promise<void>((resolve) => {
            this.#cancelWaiters.push(resolve);
          });
        }
        // Host already cancelled; peer faults instead of clean cancelled stopReason.
        await this.#transport.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "ACP transport closed" },
        });
        await this.#transport.close();
        return;
      }
      if (this.#options.awaitPermissionThenContinue) {
        await this.#transport.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.#sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool-perm-reopen",
              title: "write",
              status: "pending",
            },
          },
        });
        await this.#agentRequest("session/request_permission", {
          sessionId: this.#sessionId,
          toolCall: { toolCallId: "tool-perm-reopen", title: "Write a file?" },
          options: [
            { optionId: "allow", kind: "allow_once" },
            { optionId: "reject", kind: "reject_once" },
          ],
        });
        const text = readPrompt(message.params);
        await this.#transport.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.#sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          },
        });
        await this.#transport.send({
          jsonrpc: "2.0",
          id: message.id,
          result: { stopReason: "end_turn" },
        });
        return;
      }
      if (this.#options.disconnectDuringPermission) {
        await this.#transport.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.#sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool-ddp",
              title: "write",
              status: "pending",
            },
          },
        });
        // Fire permission without awaiting — Host journals interaction.requested.
        // Hold prompt unanswered until faultDuringPendingPermission() (Host wait gate).
        await this.#transport.send({
          jsonrpc: "2.0",
          id: "agent-perm-ddp",
          method: "session/request_permission",
          params: {
            sessionId: this.#sessionId,
            toolCall: { toolCallId: "tool-ddp", title: "Write a file?" },
            options: [
              { optionId: "allow", kind: "allow_once" },
              { optionId: "reject", kind: "reject_once" },
            ],
          },
        });
        this.#heldPromptId = message.id;
        this.#holdingPermission = true;
        await new Promise<void>((resolve) => {
          this.#permissionHoldWaiters.push(resolve);
        });
        this.#holdingPermission = false;
        this.#heldPromptId = null;
        return;
      }
      if (this.#options.cancelDuringPermission) {
        await this.#transport.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.#sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool-cancel-perm",
              title: "write",
              status: "pending",
            },
          },
        });
        await this.#agentRequest("session/request_permission", {
          sessionId: this.#sessionId,
          toolCall: { toolCallId: "tool-cancel-perm", title: "Write a file?" },
          options: [
            { optionId: "allow", kind: "allow_once" },
            { optionId: "reject", kind: "reject_once" },
          ],
        });
        // cancelTurn notifies session/cancel and rejects the pending permission.
        await this.#transport.send({
          jsonrpc: "2.0",
          id: message.id,
          result: { stopReason: this.#cancelled ? "cancelled" : "end_turn" },
        });
        return;
      }
      if (this.#options.disconnectAfterPermissionDenied) {
        await this.#transport.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.#sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool-perm-deny",
              title: "write",
              status: "pending",
            },
          },
        });
        const decision = await this.#agentRequest("session/request_permission", {
          sessionId: this.#sessionId,
          toolCall: { toolCallId: "tool-perm-deny", title: "Write a file?" },
          options: [
            { optionId: "allow", kind: "allow_once" },
            { optionId: "reject", kind: "reject_once" },
          ],
        });
        // Host deny must select the reject option before we fault the transport.
        if (!JSON.stringify(decision).includes("reject")) {
          throw new Error("expected Host to deny permission before disconnect");
        }
        await this.#transport.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "ACP transport closed" },
        });
        await this.#transport.close();
        return;
      }
      if (this.#options.holdAfterPermissionDenied) {
        await this.#transport.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.#sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool-deny-then-cancel",
              title: "write",
              status: "pending",
            },
          },
        });
        const decision = await this.#agentRequest("session/request_permission", {
          sessionId: this.#sessionId,
          toolCall: { toolCallId: "tool-deny-then-cancel", title: "Write a file?" },
          options: [
            { optionId: "allow", kind: "allow_once" },
            { optionId: "reject", kind: "reject_once" },
          ],
        });
        if (!JSON.stringify(decision).includes("reject")) {
          throw new Error("expected Host to deny permission before cancel");
        }
        if (!this.#cancelled) {
          await new Promise<void>((resolve) => {
            this.#cancelWaiters.push(resolve);
          });
        }
        await this.#transport.send({
          jsonrpc: "2.0",
          id: message.id,
          result: { stopReason: "cancelled" },
        });
        return;
      }
      if (this.#options.holdAfterPermissionAllowed) {
        await this.#transport.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.#sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool-allow-then-cancel",
              title: "write",
              status: "pending",
            },
          },
        });
        const decision = await this.#agentRequest("session/request_permission", {
          sessionId: this.#sessionId,
          toolCall: { toolCallId: "tool-allow-then-cancel", title: "Write a file?" },
          options: [
            { optionId: "allow", kind: "allow_once" },
            { optionId: "reject", kind: "reject_once" },
          ],
        });
        if (!JSON.stringify(decision).includes("allow")) {
          throw new Error("expected Host to allow permission before cancel");
        }
        if (!this.#cancelled) {
          await new Promise<void>((resolve) => {
            this.#cancelWaiters.push(resolve);
          });
        }
        await this.#transport.send({
          jsonrpc: "2.0",
          id: message.id,
          result: { stopReason: "cancelled" },
        });
        return;
      }
      if (this.#options.disconnectAfterPermissionAllowed) {
        await this.#transport.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.#sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool-perm-allow",
              title: "write",
              status: "pending",
            },
          },
        });
        const decision = await this.#agentRequest("session/request_permission", {
          sessionId: this.#sessionId,
          toolCall: { toolCallId: "tool-perm-allow", title: "Write a file?" },
          options: [
            { optionId: "allow", kind: "allow_once" },
            { optionId: "reject", kind: "reject_once" },
          ],
        });
        // Host allow must select the allow option before we fault mid-turn.
        if (!JSON.stringify(decision).includes("allow")) {
          throw new Error("expected Host to allow permission before disconnect");
        }
        await this.#transport.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "ACP transport closed" },
        });
        await this.#transport.close();
        return;
      }
      if (this.#options.disconnectOnToolCall) {
        await this.#transport.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.#sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool-mid-disconnect",
              title: "write",
              status: "pending",
            },
          },
        });
        // Fire permission request without awaiting — Host journals interaction.requested, then we fault.
        await this.#transport.send({
          jsonrpc: "2.0",
          id: "agent-perm-mid-disconnect",
          method: "session/request_permission",
          params: {
            sessionId: this.#sessionId,
            toolCall: { toolCallId: "tool-mid-disconnect", title: "Write a file?" },
            options: [
              { optionId: "allow", kind: "allow_once" },
              { optionId: "reject", kind: "reject_once" },
            ],
          },
        });
        await this.#transport.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "ACP transport closed" },
        });
        await this.#transport.close();
        return;
      }
      if (this.#options.disconnectOnPrompt) {
        await this.#transport.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.#sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "partial before disconnect" },
            },
          },
        });
        await this.#transport.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "ACP transport closed" },
        });
        await this.#transport.close();
        return;
      }
      const text = readPrompt(message.params);
      await this.#transport.send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: this.#sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        },
      });
      await this.#transport.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { stopReason: "end_turn" },
      });
    }
  }
}

function readPrompt(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const prompt = (params as { prompt?: unknown }).prompt;
  if (!Array.isArray(prompt)) return "";
  const first = prompt[0];
  if (!first || typeof first !== "object") return "";
  const text = (first as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function openFakeTransport(
  agentName: string,
  sessionId: string,
  options: FakePeerOptions = {},
  peers?: FakePeer[],
): AcpTransport {
  const link = linkAcpTransports();
  const peer = new FakePeer(link.agent, sessionId, agentName, options);
  peers?.push(peer);
  return link.client;
}

test("lazyTargetService does not register OpenCode or Goose ACP opt-in factories", () => {
  const src = readFileSync(lazySrc, "utf8");
  assert.doesNotMatch(src, /createExperimentalRegistryOpenCodeAcpHarness/);
  assert.doesNotMatch(src, /createExperimentalRegistryGooseAcpHarness/);
  assert.doesNotMatch(src, /openCodeAcpProfile/);
  assert.doesNotMatch(src, /gooseAcpProfile/);
  assert.doesNotMatch(src, /agent-adapters\/acp/);
});

test("opt-in OpenCode ACP factory registers only when caller enables the id", () => {
  const registry = new HarnessRegistry();
  const plugins = [
    {
      manifest: openCodeAcpProfile.manifest,
      trusted: true,
      create: () =>
        createExperimentalRegistryOpenCodeAcpHarness({
          openTransport: () => openFakeTransport("OpenCode", "oc-optin"),
        }),
    },
    {
      manifest: gooseAcpProfile.manifest,
      trusted: true,
      create: () =>
        createExperimentalRegistryGooseAcpHarness({
          openTransport: () => openFakeTransport("Goose", "goose-optin"),
        }),
    },
  ];
  const disabled = loadExplicitHarnessPlugins(registry, plugins, new Set());
  assert.deepEqual(disabled.loaded, []);
  assert.equal(disabled.skipped.length, 2);

  const enabledOpenCode = loadExplicitHarnessPlugins(
    new HarnessRegistry(),
    plugins,
    new Set(["opencode"]),
  );
  assert.deepEqual(enabledOpenCode.loaded, ["opencode"]);
  assert.equal(
    enabledOpenCode.skipped.some((s) => s.id === "goose" && s.reason === "disabled"),
    true,
  );

  const enabledGoose = loadExplicitHarnessPlugins(
    new HarnessRegistry(),
    plugins,
    new Set(["goose"]),
  );
  assert.deepEqual(enabledGoose.loaded, ["goose"]);
  assert.equal(
    enabledGoose.skipped.some((s) => s.id === "opencode" && s.reason === "disabled"),
    true,
  );
});

test("SessionHost + opt-in OpenCode ACP: create/send journals a fake-transport turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-opencode-acp-host-"));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  let connection = 0;
  const registry = new HarnessRegistry();
  registry.register(
    createExperimentalRegistryOpenCodeAcpHarness({
      openTransport: () => {
        connection += 1;
        return openFakeTransport("OpenCode", `oc-session-${connection}`);
      },
    }),
  );

  const hostSessionId = "opencode-host-1";
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: "workspace-opencode",
      worktreePath: worktree,
    },
    harness: { id: "opencode", adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });
  assert.equal(host.plan.route, "harness-managed");
  assert.equal(host.plan.support.support, "supported");
  assert.equal(host.plan.harnessId, "opencode");
  assert.equal(host.plan.adapterVersion, ACP_ADAPTER_VERSION);
  assert.equal(host.plan.capabilities.hostManagedModel?.support, "unsupported");

  const receipt = await host.dispatch({
    type: "send",
    commandId: "oc-cmd-1",
    hostSessionId,
    turnId: "turn-1",
    text: "hello from SessionHost",
  });
  assert.equal(receipt.status, "accepted");
  await host.whenIdle();
  assert.equal(host.queryCommand("oc-cmd-1")?.status, "completed");

  const events = host.eventsSince(0);
  const kinds = events.map((event) => event.kind);
  assert.ok(kinds.includes("turn.started"));
  assert.ok(kinds.includes("text.delta"));
  assert.ok(kinds.includes("message.finished"));
  assert.ok(kinds.includes("turn.finished"));
  const message = events.find((event) => event.kind === "message.finished");
  assert.ok(message && message.kind === "message.finished");
  assert.equal(message.text, "hello from SessionHost");

  await host.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "message.finished"));
});

test("SessionHost + opt-in Goose ACP: create/send journals a fake-transport turn (symmetric)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-goose-acp-host-"));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  let connection = 0;
  const registry = new HarnessRegistry();
  registry.register(
    createExperimentalRegistryGooseAcpHarness({
      openTransport: () => {
        connection += 1;
        return openFakeTransport("Goose", `goose-session-${connection}`);
      },
    }),
  );

  const hostSessionId = "goose-host-1";
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: "workspace-goose",
      worktreePath: worktree,
    },
    harness: { id: "goose", adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });
  assert.equal(host.plan.route, "harness-managed");
  assert.equal(host.plan.support.support, "supported");
  assert.equal(host.plan.harnessId, "goose");
  assert.equal(host.plan.adapterVersion, ACP_ADAPTER_VERSION);
  assert.equal(host.plan.capabilities.hostManagedModel?.support, "unsupported");

  const receipt = await host.dispatch({
    type: "send",
    commandId: "goose-cmd-1",
    hostSessionId,
    turnId: "turn-1",
    text: "hello from Goose SessionHost",
  });
  assert.equal(receipt.status, "accepted");
  await host.whenIdle();
  assert.equal(host.queryCommand("goose-cmd-1")?.status, "completed");

  const events = host.eventsSince(0);
  const kinds = events.map((event) => event.kind);
  assert.ok(kinds.includes("turn.started"));
  assert.ok(kinds.includes("text.delta"));
  assert.ok(kinds.includes("message.finished"));
  assert.ok(kinds.includes("turn.finished"));
  const message = events.find((event) => event.kind === "message.finished");
  assert.ok(message && message.kind === "message.finished");
  assert.equal(message.text, "hello from Goose SessionHost");

  await host.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "message.finished"));
});

test("SessionHost + opt-in OpenCode ACP: late prompt reply still journals the turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-opencode-acp-late-"));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  let connection = 0;
  const registry = new HarnessRegistry();
  registry.register(
    createExperimentalRegistryOpenCodeAcpHarness({
      openTransport: () => {
        connection += 1;
        return openFakeTransport("OpenCode", `oc-late-${connection}`, { promptDelayMs: 40 });
      },
    }),
  );

  const hostSessionId = "opencode-late-1";
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: "workspace-opencode-late",
      worktreePath: worktree,
    },
    harness: { id: "opencode", adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });

  const started = Date.now();
  const receipt = await host.dispatch({
    type: "send",
    commandId: "oc-late-1",
    hostSessionId,
    turnId: "turn-late",
    text: "late reply please",
  });
  assert.equal(receipt.status, "accepted");
  await host.whenIdle();
  assert.ok(Date.now() - started >= 35, "expected prompt delay to elapse before idle");
  assert.equal(host.queryCommand("oc-late-1")?.status, "completed");

  const message = host.eventsSince(0).find((event) => event.kind === "message.finished");
  assert.ok(message && message.kind === "message.finished");
  assert.equal(message.text, "late reply please");
  await host.close();
});

test("SessionHost + opt-in Goose ACP: late prompt reply still journals the turn (symmetric)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-goose-acp-late-"));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  let connection = 0;
  const registry = new HarnessRegistry();
  registry.register(
    createExperimentalRegistryGooseAcpHarness({
      openTransport: () => {
        connection += 1;
        return openFakeTransport("Goose", `goose-late-${connection}`, { promptDelayMs: 40 });
      },
    }),
  );

  const hostSessionId = "goose-late-1";
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: "workspace-goose-late",
      worktreePath: worktree,
    },
    harness: { id: "goose", adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });

  const started = Date.now();
  const receipt = await host.dispatch({
    type: "send",
    commandId: "goose-late-1",
    hostSessionId,
    turnId: "turn-late",
    text: "late reply from Goose",
  });
  assert.equal(receipt.status, "accepted");
  await host.whenIdle();
  assert.ok(Date.now() - started >= 35, "expected prompt delay to elapse before idle");
  assert.equal(host.queryCommand("goose-late-1")?.status, "completed");

  const message = host.eventsSince(0).find((event) => event.kind === "message.finished");
  assert.ok(message && message.kind === "message.finished");
  assert.equal(message.text, "late reply from Goose");
  await host.close();
});

async function assertSessionHostTransportDisconnect(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-disconnect-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  let connection = 0;
  const registry = new HarnessRegistry();
  registry.register(
    input.createHarness(() => {
      connection += 1;
      return openFakeTransport(input.agentName, `${input.harnessId}-disconnect-${connection}`, {
        disconnectOnPrompt: true,
      });
    }),
  );

  const hostSessionId = `${input.harnessId}-disconnect-1`;
  const commandId = `${input.harnessId}-disconnect-cmd`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-disconnect`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });

  const receipt = await host.dispatch({
    type: "send",
    commandId,
    hostSessionId,
    turnId: "turn-disconnect",
    text: "survive disconnect",
  });
  assert.equal(receipt.status, "accepted");
  await host.whenIdle();

  const events = host.eventsSince(0);
  assert.ok(events.some((event) => event.kind === "turn.started"));
  assert.ok(
    events.some(
      (event) => event.kind === "text.delta" && event.text === "partial before disconnect",
    ),
  );
  const error = events.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const finished = events.find((event) => event.kind === "turn.finished");
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "unknown");

  // Fault fence: Host must not leave the turn unmarked; receipt settles (completed or unknown).
  const settled = host.queryCommand(commandId)?.status;
  assert.ok(settled === "completed" || settled === "execution-unknown", settled);

  await host.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "session.error"));
  assert.ok(persisted.some((event) => event.kind === "turn.finished"));
}

test("SessionHost + opt-in OpenCode ACP: transport disconnect mid-prompt journals fault fence", async (t) => {
  await assertSessionHostTransportDisconnect({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: transport disconnect mid-prompt journals fault fence (symmetric)", async (t) => {
  await assertSessionHostTransportDisconnect({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostResumeAfterDisconnect(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-rad-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  // Stable backend session id across recreate/open (attach must resume this id).
  const backendSessionId = `${input.harnessId}-rad-session`;
  const peers: FakePeer[] = [];

  const hostSessionId = `${input.harnessId}-rad-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-rad`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Connection 1: negotiate loadSession, disconnect mid-prompt.
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, disconnectOnPrompt: true },
        peers,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const faultReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-rad-fault`,
    hostSessionId,
    turnId: "turn-rad-fault",
    text: "die mid-prompt",
  });
  assert.equal(faultReceipt.status, "accepted");
  await host.whenIdle();
  assert.ok(host.eventsSince(0).some((event) => event.kind === "session.error"));
  await host.close();

  // Fresh adapter registry simulates Host reopen after transport death (same journal + binding).
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, { loadSession: true }, peersAfter),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "attach must call session/load after disconnect",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "resume must not open a replacement session/new",
  );

  const resumeReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-rad-resume`,
    hostSessionId,
    turnId: "turn-rad-resume",
    text: "after resume",
  });
  assert.equal(resumeReceipt.status, "accepted");
  await resumed.whenIdle();

  const after = resumed.eventsSince(0);
  assert.ok(after.some((event) => event.kind === "session.error"));
  assert.ok(
    after.some((event) => event.kind === "message.finished" && event.text === "after resume"),
  );
  assert.ok(
    after.some((event) => event.kind === "turn.finished" && event.turnId === "turn-rad-resume"),
  );

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some((event) => event.kind === "message.finished" && event.text === "after resume"),
  );
}

test("SessionHost + opt-in OpenCode ACP: resume-after-disconnect via session/load then send", async (t) => {
  await assertSessionHostResumeAfterDisconnect({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: resume-after-disconnect via session/load then send (symmetric)", async (t) => {
  await assertSessionHostResumeAfterDisconnect({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostCancelAfterDisconnect(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-cad-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-cad-session`;
  const hostSessionId = `${input.harnessId}-cad-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-cad`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Connection 1: disconnect mid-prompt → fault fence; cancel of the dead turn is stale.
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, {
        loadSession: true,
        disconnectOnPrompt: true,
      }),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const faultReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-cad-fault`,
    hostSessionId,
    turnId: "turn-cad-fault",
    text: "die mid-prompt",
  });
  assert.equal(faultReceipt.status, "accepted");
  await host.whenIdle();
  assert.ok(host.eventsSince(0).some((event) => event.kind === "session.error"));

  const staleCancel = await host.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-cad-stale-cancel`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-cad-fault",
  });
  assert.equal(staleCancel.status, "rejected");
  assert.equal(staleCancel.reasonCode, "stale-turn");
  await host.close();

  // Connection 2: reopen + session/load, then cancel mid-prompt journals cancelled.
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, holdUntilCancel: true },
        peersAfter,
      ),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "attach must call session/load after disconnect",
  );

  const sendReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-cad-send`,
    hostSessionId,
    turnId: "turn-cad-live",
    text: "cancel me after resume",
  });
  assert.equal(sendReceipt.status, "accepted");

  // Wait until the peer has emitted the pre-cancel partial (turn is live).
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const partial = resumed
      .eventsSince(0)
      .some((event) => event.kind === "text.delta" && event.text === "partial before cancel");
    if (partial) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    resumed
      .eventsSince(0)
      .some((event) => event.kind === "text.delta" && event.text === "partial before cancel"),
    "expected partial before cancel",
  );

  const cancelReceipt = await resumed.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-cad-cancel`,
    hostSessionId,
    runtimeEpoch: resumed.binding.runtimeEpoch!,
    turnId: "turn-cad-live",
  });
  assert.equal(cancelReceipt.status, "completed");
  await resumed.whenIdle();

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/cancel")),
    "cancel must reach the ACP peer after resume",
  );
  const finished = resumed
    .eventsSince(0)
    .find((event) => event.kind === "turn.finished" && event.turnId === "turn-cad-live");
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "cancelled");

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-cad-live" &&
        event.outcome === "cancelled",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: cancel-after-disconnect (stale then mid-prompt cancel)", async (t) => {
  await assertSessionHostCancelAfterDisconnect({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: cancel-after-disconnect (stale then mid-prompt cancel, symmetric)", async (t) => {
  await assertSessionHostCancelAfterDisconnect({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostDoubleFaultReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-dfr-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-dfr-session`;
  const hostSessionId = `${input.harnessId}-dfr-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-dfr`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  async function createHostWithDisconnect(peers: FakePeer[]): Promise<SessionHost> {
    const registry = new HarnessRegistry();
    registry.register(
      input.createHarness(() =>
        openFakeTransport(
          input.agentName,
          backendSessionId,
          { loadSession: true, disconnectOnPrompt: true },
          peers,
        ),
      ),
    );
    return SessionHost.create({
      root: journalRoot,
      spec,
      target,
      catalog,
      registry,
    });
  }

  async function openHostWith(options: FakePeerOptions, peers: FakePeer[]): Promise<SessionHost> {
    const registry = new HarnessRegistry();
    registry.register(
      input.createHarness(() =>
        openFakeTransport(input.agentName, backendSessionId, options, peers),
      ),
    );
    return SessionHost.open({
      root: journalRoot,
      spec,
      target,
      catalog,
      registry,
    });
  }

  // Round 1: fault → close.
  const peers1: FakePeer[] = [];
  const host1 = await createHostWithDisconnect(peers1);
  const fault1 = await host1.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dfr-fault-1`,
    hostSessionId,
    turnId: "turn-dfr-fault-1",
    text: "first fault",
  });
  assert.equal(fault1.status, "accepted");
  await host1.whenIdle();
  assert.ok(host1.eventsSince(0).some((event) => event.kind === "session.error"));
  await host1.close();

  // Round 2: reopen (session/load) → fault again → close.
  const peers2: FakePeer[] = [];
  const host2 = await openHostWith({ loadSession: true, disconnectOnPrompt: true }, peers2);
  assert.ok(
    peers2.some((peer) => peer.methods.includes("session/load")),
    "first reopen must session/load",
  );
  assert.ok(
    peers2.every((peer) => !peer.methods.includes("session/new")),
    "first reopen must not session/new",
  );

  const fault2 = await host2.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dfr-fault-2`,
    hostSessionId,
    turnId: "turn-dfr-fault-2",
    text: "second fault",
  });
  assert.equal(fault2.status, "accepted");
  await host2.whenIdle();
  const afterSecondFault = host2.eventsSince(0);
  const errorsAfterTwo = afterSecondFault.filter((event) => event.kind === "session.error");
  assert.ok(errorsAfterTwo.length >= 2, `expected ≥2 session.error, got ${errorsAfterTwo.length}`);
  assert.ok(
    afterSecondFault.some(
      (event) => event.kind === "turn.finished" && event.turnId === "turn-dfr-fault-2",
    ),
  );
  await host2.close();

  // Round 3: second reopen stays idempotent (session/load again), then healthy send.
  const peers3: FakePeer[] = [];
  const host3 = await openHostWith({ loadSession: true }, peers3);
  assert.ok(
    peers3.some((peer) => peer.methods.includes("session/load")),
    "second reopen must session/load (idempotent)",
  );
  assert.ok(
    peers3.every((peer) => !peer.methods.includes("session/new")),
    "second reopen must not session/new",
  );

  const ok = await host3.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dfr-ok`,
    hostSessionId,
    turnId: "turn-dfr-ok",
    text: "after double fault",
  });
  assert.equal(ok.status, "accepted");
  await host3.whenIdle();

  const finalEvents = host3.eventsSince(0);
  assert.ok(
    finalEvents.some(
      (event) => event.kind === "message.finished" && event.text === "after double fault",
    ),
  );
  assert.ok(
    finalEvents.some((event) => event.kind === "turn.finished" && event.turnId === "turn-dfr-ok"),
  );

  await host3.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.filter((event) => event.kind === "session.error").length >= 2,
    "journal must keep both fault fences",
  );
  assert.ok(
    persisted.some(
      (event) => event.kind === "message.finished" && event.text === "after double fault",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: double-fault reopen idempotency then send", async (t) => {
  await assertSessionHostDoubleFaultReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: double-fault reopen idempotency then send (symmetric)", async (t) => {
  await assertSessionHostDoubleFaultReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostMidToolDisconnectResume(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-mtd-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-mtd-session`;
  const hostSessionId = `${input.harnessId}-mtd-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-mtd`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const peersFault: FakePeer[] = [];
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, disconnectOnToolCall: true },
        peersFault,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const faultReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-mtd-fault`,
    hostSessionId,
    turnId: "turn-mtd-fault",
    text: "tool then die",
  });
  assert.equal(faultReceipt.status, "accepted");
  await host.whenIdle();

  const faultEvents = host.eventsSince(0);
  assert.ok(
    faultEvents.some((event) => event.kind === "tool.started"),
    "expected tool.started before disconnect",
  );
  assert.ok(
    faultEvents.some((event) => event.kind === "interaction.requested"),
    "expected interaction.requested before disconnect",
  );
  const error = faultEvents.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  assert.ok(
    faultEvents.some(
      (event) => event.kind === "turn.finished" && event.turnId === "turn-mtd-fault",
    ),
  );
  await host.close();

  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, { loadSession: true }, peersAfter),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen after mid-tool disconnect must session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "resume must not session/new",
  );

  const resumeReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-mtd-resume`,
    hostSessionId,
    turnId: "turn-mtd-resume",
    text: "after mid-tool resume",
  });
  assert.equal(resumeReceipt.status, "accepted");
  await resumed.whenIdle();

  const after = resumed.eventsSince(0);
  assert.ok(after.some((event) => event.kind === "session.error"));
  assert.ok(
    after.some(
      (event) => event.kind === "message.finished" && event.text === "after mid-tool resume",
    ),
  );
  assert.ok(
    after.some((event) => event.kind === "turn.finished" && event.turnId === "turn-mtd-resume"),
  );

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "tool.started"));
  assert.ok(persisted.some((event) => event.kind === "interaction.requested"));
  assert.ok(
    persisted.some(
      (event) => event.kind === "message.finished" && event.text === "after mid-tool resume",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: mid-tool-call disconnect then reopen resume", async (t) => {
  await assertSessionHostMidToolDisconnectResume({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: mid-tool-call disconnect then reopen resume (symmetric)", async (t) => {
  await assertSessionHostMidToolDisconnectResume({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostPermissionDeniedThenDisconnect(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-pdd-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const hostSessionId = `${input.harnessId}-pdd-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-pdd`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const registry = new HarnessRegistry();
  registry.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, `${input.harnessId}-pdd-session`, {
        disconnectAfterPermissionDenied: true,
      }),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });

  const sendReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-pdd-send`,
    hostSessionId,
    turnId: "turn-pdd",
    text: "deny then die",
  });
  assert.equal(sendReceipt.status, "accepted");

  const deadline = Date.now() + 5_000;
  let interactionId: string | undefined;
  while (Date.now() < deadline) {
    const requested = host.eventsSince(0).find((event) => event.kind === "interaction.requested");
    if (requested && requested.kind === "interaction.requested") {
      interactionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(interactionId, "expected interaction.requested before deny");

  const denyReceipt = await host.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-pdd-deny`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-pdd",
    interactionId,
    decision: "deny",
  });
  assert.equal(denyReceipt.status, "completed");

  await host.whenIdle();

  const events = host.eventsSince(0);
  assert.ok(events.some((event) => event.kind === "tool.started"));
  assert.ok(
    events.some((event) => event.kind === "interaction.resolved" && event.decision === "deny"),
  );
  const error = events.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const finished = events.find((event) => event.kind === "turn.finished");
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "unknown");

  await host.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some((event) => event.kind === "interaction.resolved" && event.decision === "deny"),
  );
  assert.ok(persisted.some((event) => event.kind === "session.error"));
}

test("SessionHost + opt-in OpenCode ACP: permission-denied-then-disconnect journals deny + fault", async (t) => {
  await assertSessionHostPermissionDeniedThenDisconnect({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: permission-denied-then-disconnect journals deny + fault (symmetric)", async (t) => {
  await assertSessionHostPermissionDeniedThenDisconnect({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostCancelDuringPermission(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-cdp-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const peers: FakePeer[] = [];
  const hostSessionId = `${input.harnessId}-cdp-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-cdp`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const registry = new HarnessRegistry();
  registry.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        `${input.harnessId}-cdp-session`,
        { cancelDuringPermission: true },
        peers,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });

  const sendReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-cdp-send`,
    hostSessionId,
    turnId: "turn-cdp",
    text: "cancel while permission pending",
  });
  assert.equal(sendReceipt.status, "accepted");

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (host.eventsSince(0).some((event) => event.kind === "interaction.requested")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    host.eventsSince(0).some((event) => event.kind === "interaction.requested"),
    "expected interaction.requested before cancel",
  );

  const cancelReceipt = await host.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-cdp-cancel`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-cdp",
  });
  assert.equal(cancelReceipt.status, "completed");
  await host.whenIdle();

  assert.ok(
    peers.some((peer) => peer.methods.includes("session/cancel")),
    "cancel must reach ACP peer during pending permission",
  );
  const events = host.eventsSince(0);
  assert.ok(events.some((event) => event.kind === "tool.started"));
  assert.ok(events.some((event) => event.kind === "interaction.requested"));
  const finished = events.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-cdp",
  );
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "cancelled");

  await host.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-cdp" &&
        event.outcome === "cancelled",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: cancel-during-permission journals cancelled", async (t) => {
  await assertSessionHostCancelDuringPermission({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: cancel-during-permission journals cancelled (symmetric)", async (t) => {
  await assertSessionHostCancelDuringPermission({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostDisconnectDuringPermission(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-ddp-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const peers: FakePeer[] = [];
  const hostSessionId = `${input.harnessId}-ddp-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-ddp`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const registry = new HarnessRegistry();
  registry.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        `${input.harnessId}-ddp-session`,
        { disconnectDuringPermission: true },
        peers,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });

  const sendReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ddp-send`,
    hostSessionId,
    turnId: "turn-ddp",
    text: "disconnect while permission pending",
  });
  assert.equal(sendReceipt.status, "accepted");

  // Host wait gate — peer holds permission unanswered until we fault (≠ disconnectOnToolCall).
  const deadline = Date.now() + 5_000;
  let interactionId: string | undefined;
  while (Date.now() < deadline) {
    const requested = host.eventsSince(0).find((event) => event.kind === "interaction.requested");
    if (requested && requested.kind === "interaction.requested") {
      interactionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(interactionId, "expected interaction.requested before peer disconnect");

  await waitForCondition(
    () => peers.some((peer) => peer.holdingPermission),
    "FakePeer hold mid permission",
  );
  const held = peers.find((peer) => peer.holdingPermission);
  assert.ok(held, "expected FakePeer holding permission");
  // After Host wait gate: JSON-RPC error + close (≠ cancelTurn; ≠ Host resolve first).
  await held.faultDuringPendingPermission();
  await host.whenIdle();

  const events = host.eventsSince(0);
  assert.ok(events.some((event) => event.kind === "tool.started"));
  assert.ok(events.some((event) => event.kind === "interaction.requested"));
  const error = events.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const finished = events.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-ddp",
  );
  assert.ok(finished && finished.kind === "turn.finished");
  // Host did not cancelTurn — fault/unknown (align mid-tool / allow-then-disconnect), not cancelled.
  assert.equal(finished.outcome, "unknown");
  assert.ok(
    events.every((event) => event.kind !== "interaction.resolved"),
    "peer disconnect before Host resolve must not journal interaction.resolved",
  );

  // Thin post-fault: resolveInteraction against the dead turn is rejected (stale).
  const stale = await host.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-ddp-stale`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-ddp",
    interactionId,
    decision: "deny",
  });
  assert.equal(stale.status, "rejected");
  assert.equal(stale.reasonCode, "stale-interaction");

  await host.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-ddp" &&
        event.outcome === "unknown",
    ),
  );
  assert.ok(
    persisted.every((event) => event.kind !== "interaction.resolved"),
    "persisted journal must not contain interaction.resolved",
  );
  assert.ok(persisted.some((event) => event.kind === "session.error"));
}

test("SessionHost + opt-in OpenCode ACP: disconnect-during-permission journals fault without resolve", async (t) => {
  await assertSessionHostDisconnectDuringPermission({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: disconnect-during-permission journals fault without resolve (symmetric)", async (t) => {
  await assertSessionHostDisconnectDuringPermission({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostDisconnectDuringPermissionThenReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-ddp-ro-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-ddp-ro-session`;
  const hostSessionId = `${input.harnessId}-ddp-ro-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-ddp-ro`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: #223 disconnect-during-permission fence (Host wait + faultDuringPendingPermission).
  const peersFault: FakePeer[] = [];
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, disconnectDuringPermission: true },
        peersFault,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const sendReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ddp-ro-send`,
    hostSessionId,
    turnId: "turn-ddp-ro",
    text: "disconnect while permission pending",
  });
  assert.equal(sendReceipt.status, "accepted");

  // Host wait gate — peer holds permission unanswered until we fault (≠ disconnectOnToolCall).
  const deadline = Date.now() + 5_000;
  let interactionId: string | undefined;
  while (Date.now() < deadline) {
    const requested = host.eventsSince(0).find((event) => event.kind === "interaction.requested");
    if (requested && requested.kind === "interaction.requested") {
      interactionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(interactionId, "expected interaction.requested before peer disconnect");

  await waitForCondition(
    () => peersFault.some((peer) => peer.holdingPermission),
    "FakePeer hold mid permission",
  );
  const held = peersFault.find((peer) => peer.holdingPermission);
  assert.ok(held, "expected FakePeer holding permission");
  await held.faultDuringPendingPermission();
  await host.whenIdle();

  const faultEvents = host.eventsSince(0);
  assert.ok(faultEvents.some((event) => event.kind === "tool.started"));
  assert.ok(faultEvents.some((event) => event.kind === "interaction.requested"));
  const error = faultEvents.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const finished = faultEvents.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-ddp-ro",
  );
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "unknown");
  assert.ok(
    faultEvents.every((event) => event.kind !== "interaction.resolved"),
    "peer disconnect before Host resolve must not journal interaction.resolved",
  );

  // Thin post-fault: resolveInteraction against the dead turn is rejected (stale; #223).
  const stale = await host.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-ddp-ro-stale`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-ddp-ro",
    interactionId,
    decision: "deny",
  });
  assert.equal(stale.status, "rejected");
  assert.equal(stale.reasonCode, "stale-interaction");

  await host.close();

  // Round 2: reopen like mid-tool — session/load then first send succeeds.
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, { loadSession: true }, peersAfter),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen after disconnect-during-permission must session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "resume must not session/new",
  );

  const resumeReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ddp-ro-resume`,
    hostSessionId,
    turnId: "turn-ddp-ro-resume",
    text: "after ddp reopen",
  });
  assert.equal(resumeReceipt.status, "accepted");
  await resumed.whenIdle();

  const after = resumed.eventsSince(0);
  assert.ok(after.some((event) => event.kind === "session.error"));
  assert.ok(
    after.some((event) => event.kind === "message.finished" && event.text === "after ddp reopen"),
  );
  assert.ok(
    after.some((event) => event.kind === "turn.finished" && event.turnId === "turn-ddp-ro-resume"),
  );

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "interaction.requested"));
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-ddp-ro" &&
        event.outcome === "unknown",
    ),
  );
  assert.ok(persisted.some((event) => event.kind === "session.error"));
  assert.ok(
    persisted.every((event) => event.kind !== "interaction.resolved"),
    "fault-era journal must not contain interaction.resolved",
  );
  assert.ok(
    persisted.some(
      (event) => event.kind === "message.finished" && event.text === "after ddp reopen",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: disconnect-during-permission then reopen first send succeeds", async (t) => {
  await assertSessionHostDisconnectDuringPermissionThenReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: disconnect-during-permission then reopen first send succeeds (symmetric)", async (t) => {
  await assertSessionHostDisconnectDuringPermissionThenReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostIdleCloseDuringPermission(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-idcp-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const peers: FakePeer[] = [];
  const hostSessionId = `${input.harnessId}-idcp-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-idcp`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const registry = new HarnessRegistry();
  registry.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        `${input.harnessId}-idcp-session`,
        { disconnectDuringPermission: true },
        peers,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });

  const sendReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-idcp-send`,
    hostSessionId,
    turnId: "turn-idcp",
    text: "idle close while permission pending",
  });
  assert.equal(sendReceipt.status, "accepted");

  // Host wait gate: close only after interaction.requested is durably visible.
  await waitForCondition(
    () => host.eventsSince(0).some((event) => event.kind === "interaction.requested"),
    "interaction.requested before idle close",
  );
  await waitForCondition(
    () => peers.some((peer) => peer.holdingPermission),
    "FakePeer hold mid permission",
  );
  const held = peers.find((peer) => peer.holdingPermission);
  assert.ok(held, "expected FakePeer holding permission");

  // Transport close only: no JSON-RPC error reply for the held session/prompt.
  await held.idleCloseDuringPendingPermission();
  await host.whenIdle();

  const events = host.eventsSince(0);
  assert.ok(events.some((event) => event.kind === "tool.started"));
  assert.ok(events.some((event) => event.kind === "interaction.requested"));
  const error = events.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const finished = events.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-idcp",
  );
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "unknown");
  assert.notEqual(finished.outcome, "cancelled");
  assert.ok(
    events.every((event) => event.kind !== "interaction.resolved"),
    "idle close before Host resolve must not journal interaction.resolved",
  );

  await host.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-idcp" &&
        event.outcome === "unknown",
    ),
  );
  assert.ok(
    persisted.every((event) => event.kind !== "interaction.resolved"),
    "persisted journal must not contain interaction.resolved",
  );
  assert.ok(
    persisted.some(
      (event) => event.kind === "session.error" && /ACP transport closed/.test(event.message),
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: idle-close-during-permission journals fault without resolve", async (t) => {
  await assertSessionHostIdleCloseDuringPermission({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: idle-close-during-permission journals fault without resolve (symmetric)", async (t) => {
  await assertSessionHostIdleCloseDuringPermission({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostIdleCloseDuringPermissionThenReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-idcp-ro-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-idcp-ro-session`;
  const hostSessionId = `${input.harnessId}-idcp-ro-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-idcp-ro`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: #236 idle-close-during-permission fence (Host wait + idleCloseDuringPendingPermission).
  const peersFault: FakePeer[] = [];
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, disconnectDuringPermission: true },
        peersFault,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const sendReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-idcp-ro-send`,
    hostSessionId,
    turnId: "turn-idcp-ro",
    text: "idle close while permission pending",
  });
  assert.equal(sendReceipt.status, "accepted");

  // Host wait gate — peer holds permission unanswered until idle close (≠ JSON-RPC fault).
  const deadline = Date.now() + 5_000;
  let interactionId: string | undefined;
  while (Date.now() < deadline) {
    const requested = host.eventsSince(0).find((event) => event.kind === "interaction.requested");
    if (requested && requested.kind === "interaction.requested") {
      interactionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(interactionId, "expected interaction.requested before peer idle close");

  await waitForCondition(
    () => peersFault.some((peer) => peer.holdingPermission),
    "FakePeer hold mid permission",
  );
  const held = peersFault.find((peer) => peer.holdingPermission);
  assert.ok(held, "expected FakePeer holding permission");
  // Transport close only: no JSON-RPC error reply for the held session/prompt (#236).
  await held.idleCloseDuringPendingPermission();
  await host.whenIdle();

  const faultEvents = host.eventsSince(0);
  assert.ok(faultEvents.some((event) => event.kind === "tool.started"));
  assert.ok(faultEvents.some((event) => event.kind === "interaction.requested"));
  const error = faultEvents.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const finished = faultEvents.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-idcp-ro",
  );
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "unknown");
  assert.notEqual(finished.outcome, "cancelled");
  assert.ok(
    faultEvents.every((event) => event.kind !== "interaction.resolved"),
    "peer idle close before Host resolve must not journal interaction.resolved",
  );

  // Thin post-fault: resolveInteraction against the dead turn is rejected (stale; #236 fence).
  const stale = await host.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-idcp-ro-stale`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-idcp-ro",
    interactionId,
    decision: "deny",
  });
  assert.equal(stale.status, "rejected");
  assert.equal(stale.reasonCode, "stale-interaction");

  await host.close();

  // Round 2: reopen like #229 after #236 — session/load then first send succeeds.
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, { loadSession: true }, peersAfter),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen after idle-close-during-permission must session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "resume must not session/new",
  );

  const resumeReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-idcp-ro-resume`,
    hostSessionId,
    turnId: "turn-idcp-ro-resume",
    text: "after idcp reopen",
  });
  assert.equal(resumeReceipt.status, "accepted");
  await resumed.whenIdle();

  const after = resumed.eventsSince(0);
  assert.ok(after.some((event) => event.kind === "session.error"));
  assert.ok(
    after.some((event) => event.kind === "message.finished" && event.text === "after idcp reopen"),
  );
  assert.ok(
    after.some((event) => event.kind === "turn.finished" && event.turnId === "turn-idcp-ro-resume"),
  );

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "interaction.requested"));
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-idcp-ro" &&
        event.outcome === "unknown",
    ),
  );
  assert.ok(persisted.some((event) => event.kind === "session.error"));
  assert.ok(
    persisted.every((event) => event.kind !== "interaction.resolved"),
    "fault-era journal must not contain interaction.resolved",
  );
  assert.ok(
    persisted.some(
      (event) => event.kind === "message.finished" && event.text === "after idcp reopen",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: idle-close-during-permission then reopen first send succeeds", async (t) => {
  await assertSessionHostIdleCloseDuringPermissionThenReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: idle-close-during-permission then reopen first send succeeds (symmetric)", async (t) => {
  await assertSessionHostIdleCloseDuringPermissionThenReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostIdleCloseThenFaultReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-icfr-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-icfr-session`;
  const hostSessionId = `${input.harnessId}-icfr-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-icfr`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  async function openHostWith(
    options: FakePeerOptions,
    peers: FakePeer[],
    mode: "create" | "open",
  ): Promise<SessionHost> {
    const registry = new HarnessRegistry();
    registry.register(
      input.createHarness(() =>
        openFakeTransport(input.agentName, backendSessionId, options, peers),
      ),
    );
    if (mode === "create") {
      return SessionHost.create({
        root: journalRoot,
        spec,
        target,
        catalog,
        registry,
      });
    }
    return SessionHost.open({
      root: journalRoot,
      spec,
      target,
      catalog,
      registry,
    });
  }

  // Round 1: #236/#242 idle-close-during-permission fence → close.
  const peers1: FakePeer[] = [];
  const host1 = await openHostWith(
    { loadSession: true, disconnectDuringPermission: true },
    peers1,
    "create",
  );
  const send1 = await host1.dispatch({
    type: "send",
    commandId: `${input.harnessId}-icfr-idle`,
    hostSessionId,
    turnId: "turn-icfr-idle",
    text: "idle close while permission pending",
  });
  assert.equal(send1.status, "accepted");
  await waitForCondition(
    () => host1.eventsSince(0).some((event) => event.kind === "interaction.requested"),
    "interaction.requested before idle close",
  );
  await waitForCondition(
    () => peers1.some((peer) => peer.holdingPermission),
    "FakePeer hold mid permission",
  );
  const held = peers1.find((peer) => peer.holdingPermission);
  assert.ok(held, "expected FakePeer holding permission");
  await held.idleCloseDuringPendingPermission();
  await host1.whenIdle();

  const idleEvents = host1.eventsSince(0);
  assert.ok(idleEvents.some((event) => event.kind === "tool.started"));
  assert.ok(idleEvents.some((event) => event.kind === "interaction.requested"));
  const idleError = idleEvents.find((event) => event.kind === "session.error");
  assert.ok(idleError && idleError.kind === "session.error");
  assert.match(idleError.message, /ACP transport closed/);
  const idleFinished = idleEvents.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-icfr-idle",
  );
  assert.ok(idleFinished && idleFinished.kind === "turn.finished");
  assert.equal(idleFinished.outcome, "unknown");
  assert.ok(
    idleEvents.every((event) => event.kind !== "interaction.resolved"),
    "idle close before Host resolve must not journal interaction.resolved",
  );
  await host1.close();

  // Round 2: reopen (session/load) → JSON-RPC mid-prompt fault (≠ second idle-close;
  // duplicate tool-ddp across two idle-close eras fails projector on open).
  const peers2: FakePeer[] = [];
  const host2 = await openHostWith({ loadSession: true, disconnectOnPrompt: true }, peers2, "open");
  assert.ok(
    peers2.some((peer) => peer.methods.includes("session/load")),
    "first reopen must session/load",
  );
  assert.ok(
    peers2.every((peer) => !peer.methods.includes("session/new")),
    "first reopen must not session/new",
  );
  const fault2 = await host2.dispatch({
    type: "send",
    commandId: `${input.harnessId}-icfr-fault`,
    hostSessionId,
    turnId: "turn-icfr-fault",
    text: "second fault mid-prompt",
  });
  assert.equal(fault2.status, "accepted");
  await host2.whenIdle();
  const afterFault = host2.eventsSince(0);
  const errorsAfterTwo = afterFault.filter((event) => event.kind === "session.error");
  assert.ok(errorsAfterTwo.length >= 2, `expected ≥2 session.error, got ${errorsAfterTwo.length}`);
  assert.ok(
    afterFault.some(
      (event) => event.kind === "turn.finished" && event.turnId === "turn-icfr-fault",
    ),
  );
  await host2.close();

  // Round 3: second reopen stays idempotent (session/load again), then healthy send.
  const peers3: FakePeer[] = [];
  const host3 = await openHostWith({ loadSession: true }, peers3, "open");
  assert.ok(
    peers3.some((peer) => peer.methods.includes("session/load")),
    "second reopen must session/load (idempotent)",
  );
  assert.ok(
    peers3.every((peer) => !peer.methods.includes("session/new")),
    "second reopen must not session/new",
  );

  const ok = await host3.dispatch({
    type: "send",
    commandId: `${input.harnessId}-icfr-ok`,
    hostSessionId,
    turnId: "turn-icfr-ok",
    text: "after idle-close then fault",
  });
  assert.equal(ok.status, "accepted");
  await host3.whenIdle();

  const finalEvents = host3.eventsSince(0);
  assert.ok(
    finalEvents.some(
      (event) => event.kind === "message.finished" && event.text === "after idle-close then fault",
    ),
  );
  assert.ok(
    finalEvents.some((event) => event.kind === "turn.finished" && event.turnId === "turn-icfr-ok"),
  );

  await host3.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.filter((event) => event.kind === "session.error").length >= 2,
    "journal must keep idle-close + fault fences",
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-icfr-idle" &&
        event.outcome === "unknown",
    ),
  );
  assert.ok(
    persisted.every((event) => event.kind !== "interaction.resolved"),
    "journal must not contain interaction.resolved",
  );
  assert.ok(
    persisted.some(
      (event) => event.kind === "message.finished" && event.text === "after idle-close then fault",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: idle-close-then-fault reopen idempotency then send", async (t) => {
  await assertSessionHostIdleCloseThenFaultReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: idle-close-then-fault reopen idempotency then send (symmetric)", async (t) => {
  await assertSessionHostIdleCloseThenFaultReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostCancelAfterIdleClose(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-caic-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-caic-session`;
  const hostSessionId = `${input.harnessId}-caic-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-caic`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: #236 idle-close-during-permission fence; cancel + resolve of dead turn are stale.
  const peersFault: FakePeer[] = [];
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, disconnectDuringPermission: true },
        peersFault,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const sendReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-caic-idle`,
    hostSessionId,
    turnId: "turn-caic-idle",
    text: "idle close while permission pending",
  });
  assert.equal(sendReceipt.status, "accepted");

  const deadline = Date.now() + 5_000;
  let interactionId: string | undefined;
  while (Date.now() < deadline) {
    const requested = host.eventsSince(0).find((event) => event.kind === "interaction.requested");
    if (requested && requested.kind === "interaction.requested") {
      interactionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(interactionId, "expected interaction.requested before peer idle close");

  await waitForCondition(
    () => peersFault.some((peer) => peer.holdingPermission),
    "FakePeer hold mid permission",
  );
  const held = peersFault.find((peer) => peer.holdingPermission);
  assert.ok(held, "expected FakePeer holding permission");
  await held.idleCloseDuringPendingPermission();
  await host.whenIdle();

  const faultEvents = host.eventsSince(0);
  assert.ok(faultEvents.some((event) => event.kind === "tool.started"));
  assert.ok(faultEvents.some((event) => event.kind === "interaction.requested"));
  const error = faultEvents.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const finished = faultEvents.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-caic-idle",
  );
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "unknown");
  assert.ok(
    faultEvents.every((event) => event.kind !== "interaction.resolved"),
    "idle close before Host resolve must not journal interaction.resolved",
  );

  // Thin post-fault missing from #236: cancelTurn + resolveInteraction against the dead turn.
  const staleCancel = await host.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-caic-stale-cancel`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-caic-idle",
  });
  assert.equal(staleCancel.status, "rejected");
  assert.equal(staleCancel.reasonCode, "stale-turn");

  const staleResolve = await host.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-caic-stale-resolve`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-caic-idle",
    interactionId,
    decision: "deny",
  });
  assert.equal(staleResolve.status, "rejected");
  assert.equal(staleResolve.reasonCode, "stale-interaction");

  await host.close();

  // Round 2: reopen + session/load, then cancel mid-prompt journals cancelled (mirror #115).
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, holdUntilCancel: true },
        peersAfter,
      ),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen after idle-close must session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "resume must not session/new",
  );

  const liveReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-caic-live`,
    hostSessionId,
    turnId: "turn-caic-live",
    text: "cancel me after idle-close resume",
  });
  assert.equal(liveReceipt.status, "accepted");

  const liveDeadline = Date.now() + 5_000;
  while (Date.now() < liveDeadline) {
    const partial = resumed
      .eventsSince(0)
      .some((event) => event.kind === "text.delta" && event.text === "partial before cancel");
    if (partial) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    resumed
      .eventsSince(0)
      .some((event) => event.kind === "text.delta" && event.text === "partial before cancel"),
    "expected partial before cancel",
  );

  const cancelReceipt = await resumed.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-caic-cancel`,
    hostSessionId,
    runtimeEpoch: resumed.binding.runtimeEpoch!,
    turnId: "turn-caic-live",
  });
  assert.equal(cancelReceipt.status, "completed");
  await resumed.whenIdle();

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/cancel")),
    "cancel must reach the ACP peer after idle-close resume",
  );
  const liveFinished = resumed
    .eventsSince(0)
    .find((event) => event.kind === "turn.finished" && event.turnId === "turn-caic-live");
  assert.ok(liveFinished && liveFinished.kind === "turn.finished");
  assert.equal(liveFinished.outcome, "cancelled");

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-caic-idle" &&
        event.outcome === "unknown",
    ),
  );
  assert.ok(
    persisted.every((event) => event.kind !== "interaction.resolved"),
    "fault-era journal must not contain interaction.resolved",
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-caic-live" &&
        event.outcome === "cancelled",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: cancel-after-idle-close (stale then mid-prompt cancel)", async (t) => {
  await assertSessionHostCancelAfterIdleClose({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: cancel-after-idle-close (stale then mid-prompt cancel, symmetric)", async (t) => {
  await assertSessionHostCancelAfterIdleClose({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostAllowAfterIdleCloseReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-aaicr-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-aaicr-session`;
  const hostSessionId = `${input.harnessId}-aaicr-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-aaicr`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: #236 idle-close-during-permission fence (≠ #136 JSON-RPC mid-permission fault).
  const peersFault: FakePeer[] = [];
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, disconnectDuringPermission: true },
        peersFault,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const idleReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-aaicr-idle`,
    hostSessionId,
    turnId: "turn-aaicr-idle",
    text: "idle close while permission pending",
  });
  assert.equal(idleReceipt.status, "accepted");

  const idleDeadline = Date.now() + 5_000;
  let idleInteractionId: string | undefined;
  while (Date.now() < idleDeadline) {
    const requested = host.eventsSince(0).find((event) => event.kind === "interaction.requested");
    if (requested && requested.kind === "interaction.requested") {
      idleInteractionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(idleInteractionId, "expected interaction.requested before peer idle close");

  await waitForCondition(
    () => peersFault.some((peer) => peer.holdingPermission),
    "FakePeer hold mid permission",
  );
  const held = peersFault.find((peer) => peer.holdingPermission);
  assert.ok(held, "expected FakePeer holding permission");
  await held.idleCloseDuringPendingPermission();
  await host.whenIdle();

  const faultEvents = host.eventsSince(0);
  assert.ok(faultEvents.some((event) => event.kind === "tool.started"));
  assert.ok(faultEvents.some((event) => event.kind === "interaction.requested"));
  const error = faultEvents.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const idleFinished = faultEvents.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-aaicr-idle",
  );
  assert.ok(idleFinished && idleFinished.kind === "turn.finished");
  assert.equal(idleFinished.outcome, "unknown");
  assert.ok(
    faultEvents.every((event) => event.kind !== "interaction.resolved"),
    "idle close before Host resolve must not journal interaction.resolved",
  );

  // Stale allow against the dead idle-close turn must be rejected (thin post-fault; ≠ #256 cancel).
  const staleAllow = await host.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-aaicr-stale-allow`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-aaicr-idle",
    interactionId: idleInteractionId,
    decision: "allow",
  });
  assert.equal(staleAllow.status, "rejected");
  assert.equal(staleAllow.reasonCode, "stale-interaction");

  await host.close();

  // Round 2: reopen + session/load; fresh permission allow completes send (≠ #242 send-without-permission).
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, awaitPermissionThenContinue: true },
        peersAfter,
      ),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen after idle-close must session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "resume must not session/new",
  );

  const sendReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-aaicr-send`,
    hostSessionId,
    turnId: "turn-aaicr-live",
    text: "allow after idle-close reopen",
  });
  assert.equal(sendReceipt.status, "accepted");

  const liveDeadline = Date.now() + 5_000;
  let liveInteractionId: string | undefined;
  while (Date.now() < liveDeadline) {
    const requested = resumed
      .eventsSince(0)
      .find(
        (event) => event.kind === "interaction.requested" && event.turnId === "turn-aaicr-live",
      );
    if (requested && requested.kind === "interaction.requested") {
      liveInteractionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(liveInteractionId, "expected fresh interaction.requested after idle-close reopen");

  const allowReceipt = await resumed.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-aaicr-allow`,
    hostSessionId,
    runtimeEpoch: resumed.binding.runtimeEpoch!,
    turnId: "turn-aaicr-live",
    interactionId: liveInteractionId,
    decision: "allow",
  });
  assert.equal(allowReceipt.status, "completed");
  await resumed.whenIdle();

  const after = resumed.eventsSince(0);
  assert.ok(
    after.some(
      (event) =>
        event.kind === "interaction.resolved" &&
        event.turnId === "turn-aaicr-live" &&
        event.decision === "allow",
    ),
  );
  assert.ok(
    after.some(
      (event) =>
        event.kind === "message.finished" && event.text === "allow after idle-close reopen",
    ),
  );
  const liveFinished = after.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-aaicr-live",
  );
  assert.ok(liveFinished && liveFinished.kind === "turn.finished");
  assert.equal(liveFinished.outcome, "success");

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-aaicr-idle" &&
        event.outcome === "unknown",
    ),
  );
  assert.ok(
    persisted.every(
      (event) => !(event.kind === "interaction.resolved" && event.turnId === "turn-aaicr-idle"),
    ),
    "fault-era journal must not contain interaction.resolved for the idle-close turn",
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "interaction.resolved" &&
        event.turnId === "turn-aaicr-live" &&
        event.decision === "allow",
    ),
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "message.finished" && event.text === "allow after idle-close reopen",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: allow-after-idle-close-reopen succeeds send", async (t) => {
  await assertSessionHostAllowAfterIdleCloseReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: allow-after-idle-close-reopen succeeds send (symmetric)", async (t) => {
  await assertSessionHostAllowAfterIdleCloseReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostDenyAfterIdleCloseReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-daicr-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-daicr-session`;
  const hostSessionId = `${input.harnessId}-daicr-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-daicr`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: #236 idle-close-during-permission fence (≠ #134 JSON-RPC mid-permission fault).
  const peersFault: FakePeer[] = [];
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, disconnectDuringPermission: true },
        peersFault,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const idleReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-daicr-idle`,
    hostSessionId,
    turnId: "turn-daicr-idle",
    text: "idle close while permission pending",
  });
  assert.equal(idleReceipt.status, "accepted");

  const idleDeadline = Date.now() + 5_000;
  let idleInteractionId: string | undefined;
  while (Date.now() < idleDeadline) {
    const requested = host.eventsSince(0).find((event) => event.kind === "interaction.requested");
    if (requested && requested.kind === "interaction.requested") {
      idleInteractionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(idleInteractionId, "expected interaction.requested before peer idle close");

  await waitForCondition(
    () => peersFault.some((peer) => peer.holdingPermission),
    "FakePeer hold mid permission",
  );
  const held = peersFault.find((peer) => peer.holdingPermission);
  assert.ok(held, "expected FakePeer holding permission");
  await held.idleCloseDuringPendingPermission();
  await host.whenIdle();

  const faultEvents = host.eventsSince(0);
  assert.ok(faultEvents.some((event) => event.kind === "tool.started"));
  assert.ok(faultEvents.some((event) => event.kind === "interaction.requested"));
  const error = faultEvents.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const idleFinished = faultEvents.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-daicr-idle",
  );
  assert.ok(idleFinished && idleFinished.kind === "turn.finished");
  assert.equal(idleFinished.outcome, "unknown");
  assert.ok(
    faultEvents.every((event) => event.kind !== "interaction.resolved"),
    "idle close before Host resolve must not journal interaction.resolved",
  );

  // Stale deny against the dead idle-close turn must be rejected (thin post-fault; ≠ #260 stale allow).
  const staleDeny = await host.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-daicr-stale-deny`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-daicr-idle",
    interactionId: idleInteractionId,
    decision: "deny",
  });
  assert.equal(staleDeny.status, "rejected");
  assert.equal(staleDeny.reasonCode, "stale-interaction");

  await host.close();

  // Round 2: reopen + session/load; fresh permission deny journals clean (≠ #260 allow / ≠ #195 load fence).
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, awaitPermissionThenContinue: true },
        peersAfter,
      ),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen after idle-close must session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "resume must not session/new",
  );

  const errorCountBefore = resumed
    .eventsSince(0)
    .filter((event) => event.kind === "session.error").length;

  const sendReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-daicr-send`,
    hostSessionId,
    turnId: "turn-daicr-live",
    text: "deny after idle-close reopen",
  });
  assert.equal(sendReceipt.status, "accepted");

  const liveDeadline = Date.now() + 5_000;
  let liveInteractionId: string | undefined;
  while (Date.now() < liveDeadline) {
    const requested = resumed
      .eventsSince(0)
      .find(
        (event) => event.kind === "interaction.requested" && event.turnId === "turn-daicr-live",
      );
    if (requested && requested.kind === "interaction.requested") {
      liveInteractionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(liveInteractionId, "expected fresh interaction.requested after idle-close reopen");

  const denyReceipt = await resumed.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-daicr-deny`,
    hostSessionId,
    runtimeEpoch: resumed.binding.runtimeEpoch!,
    turnId: "turn-daicr-live",
    interactionId: liveInteractionId,
    decision: "deny",
  });
  assert.equal(denyReceipt.status, "completed");
  await resumed.whenIdle();

  const after = resumed.eventsSince(0);
  assert.ok(
    after.some(
      (event) =>
        event.kind === "interaction.resolved" &&
        event.turnId === "turn-daicr-live" &&
        event.decision === "deny",
    ),
  );
  assert.ok(
    after.some(
      (event) => event.kind === "message.finished" && event.text === "deny after idle-close reopen",
    ),
  );
  const liveFinished = after.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-daicr-live",
  );
  assert.ok(liveFinished && liveFinished.kind === "turn.finished");
  assert.equal(liveFinished.outcome, "success");
  assert.equal(
    after.filter((event) => event.kind === "session.error").length,
    errorCountBefore,
    "Host deny after idle-close reopen must not journal a new session.error",
  );

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-daicr-idle" &&
        event.outcome === "unknown",
    ),
  );
  assert.ok(
    persisted.every(
      (event) => !(event.kind === "interaction.resolved" && event.turnId === "turn-daicr-idle"),
    ),
    "fault-era journal must not contain interaction.resolved for the idle-close turn",
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "interaction.resolved" &&
        event.turnId === "turn-daicr-live" &&
        event.decision === "deny",
    ),
  );
  assert.ok(
    persisted.some(
      (event) => event.kind === "message.finished" && event.text === "deny after idle-close reopen",
    ),
  );
  assert.equal(
    persisted.filter((event) => event.kind === "session.error").length,
    errorCountBefore,
    "persisted journal must keep prior idle-close errors only",
  );
}

test("SessionHost + opt-in OpenCode ACP: deny-after-idle-close-reopen journals clean", async (t) => {
  await assertSessionHostDenyAfterIdleCloseReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: deny-after-idle-close-reopen journals clean (symmetric)", async (t) => {
  await assertSessionHostDenyAfterIdleCloseReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostDoubleSendAfterIdleCloseReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-dsaicr-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-dsaicr-session`;
  const hostSessionId = `${input.harnessId}-dsaicr-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-dsaicr`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: #236 idle-close-during-permission fence (≠ #223 JSON-RPC mid-permission fault).
  const peersFault: FakePeer[] = [];
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, disconnectDuringPermission: true },
        peersFault,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const idleReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dsaicr-idle`,
    hostSessionId,
    turnId: "turn-dsaicr-idle",
    text: "idle close while permission pending",
  });
  assert.equal(idleReceipt.status, "accepted");

  const idleDeadline = Date.now() + 5_000;
  let idleInteractionId: string | undefined;
  while (Date.now() < idleDeadline) {
    const requested = host.eventsSince(0).find((event) => event.kind === "interaction.requested");
    if (requested && requested.kind === "interaction.requested") {
      idleInteractionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(idleInteractionId, "expected interaction.requested before peer idle close");

  await waitForCondition(
    () => peersFault.some((peer) => peer.holdingPermission),
    "FakePeer hold mid permission",
  );
  const held = peersFault.find((peer) => peer.holdingPermission);
  assert.ok(held, "expected FakePeer holding permission");
  await held.idleCloseDuringPendingPermission();
  await host.whenIdle();

  const faultEvents = host.eventsSince(0);
  assert.ok(faultEvents.some((event) => event.kind === "tool.started"));
  assert.ok(faultEvents.some((event) => event.kind === "interaction.requested"));
  const error = faultEvents.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const idleFinished = faultEvents.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-dsaicr-idle",
  );
  assert.ok(idleFinished && idleFinished.kind === "turn.finished");
  assert.equal(idleFinished.outcome, "unknown");
  assert.ok(
    faultEvents.every((event) => event.kind !== "interaction.resolved"),
    "idle close before Host resolve must not journal interaction.resolved",
  );

  // Thin post-fault: resolveInteraction against the dead idle-close turn is rejected (stale).
  const staleDeny = await host.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-dsaicr-stale-deny`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-dsaicr-idle",
    interactionId: idleInteractionId,
    decision: "deny",
  });
  assert.equal(staleDeny.status, "rejected");
  assert.equal(staleDeny.reasonCode, "stale-interaction");

  await host.close();

  // Round 2: reopen + session/load; two consecutive plain sends both succeed
  // (≠ #242 single first-send / ≠ #260/#263 permission / ≠ #256 cancel).
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, { loadSession: true }, peersAfter),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen after idle-close must session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "resume must not session/new",
  );

  const errorCountBefore = resumed
    .eventsSince(0)
    .filter((event) => event.kind === "session.error").length;

  const firstReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dsaicr-send-1`,
    hostSessionId,
    turnId: "turn-dsaicr-1",
    text: "double-send after idle-close reopen first",
  });
  assert.equal(firstReceipt.status, "accepted");
  await resumed.whenIdle();

  const afterFirst = resumed.eventsSince(0);
  assert.ok(
    afterFirst.some(
      (event) =>
        event.kind === "message.finished" &&
        event.text === "double-send after idle-close reopen first",
    ),
  );
  const firstFinished = afterFirst.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-dsaicr-1",
  );
  assert.ok(firstFinished && firstFinished.kind === "turn.finished");
  assert.equal(firstFinished.outcome, "success");
  assert.equal(
    afterFirst.filter((event) => event.kind === "session.error").length,
    errorCountBefore,
    "first send after idle-close reopen must not journal a new session.error",
  );

  const secondReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dsaicr-send-2`,
    hostSessionId,
    turnId: "turn-dsaicr-2",
    text: "double-send after idle-close reopen second",
  });
  assert.equal(secondReceipt.status, "accepted");
  await resumed.whenIdle();

  const afterSecond = resumed.eventsSince(0);
  assert.ok(
    afterSecond.some(
      (event) =>
        event.kind === "message.finished" &&
        event.text === "double-send after idle-close reopen second",
    ),
  );
  const secondFinished = afterSecond.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-dsaicr-2",
  );
  assert.ok(secondFinished && secondFinished.kind === "turn.finished");
  assert.equal(secondFinished.outcome, "success");
  assert.equal(
    afterSecond.filter((event) => event.kind === "session.error").length,
    errorCountBefore,
    "second send after idle-close reopen must not journal a new session.error",
  );

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-dsaicr-idle" &&
        event.outcome === "unknown",
    ),
  );
  assert.ok(
    persisted.every((event) => event.kind !== "interaction.resolved"),
    "fault-era journal must not contain interaction.resolved",
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "message.finished" &&
        event.text === "double-send after idle-close reopen first",
    ),
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "message.finished" &&
        event.text === "double-send after idle-close reopen second",
    ),
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-dsaicr-1" &&
        event.outcome === "success",
    ),
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-dsaicr-2" &&
        event.outcome === "success",
    ),
  );
  assert.equal(
    persisted.filter((event) => event.kind === "session.error").length,
    errorCountBefore,
    "persisted journal must keep prior idle-close errors only",
  );
}

test("SessionHost + opt-in OpenCode ACP: double-send-after-idle-close-reopen both sends succeed", async (t) => {
  await assertSessionHostDoubleSendAfterIdleCloseReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: double-send-after-idle-close-reopen both sends succeed (symmetric)", async (t) => {
  await assertSessionHostDoubleSendAfterIdleCloseReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostCancelAfterIdleCloseReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-caicr-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-caicr-session`;
  const hostSessionId = `${input.harnessId}-caicr-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-caicr`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: #236 idle-close-during-permission fence (≠ #223 JSON-RPC mid-permission fault).
  const peersFault: FakePeer[] = [];
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, disconnectDuringPermission: true },
        peersFault,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const idleReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-caicr-idle`,
    hostSessionId,
    turnId: "turn-caicr-idle",
    text: "idle close while permission pending",
  });
  assert.equal(idleReceipt.status, "accepted");

  const idleDeadline = Date.now() + 5_000;
  let idleInteractionId: string | undefined;
  while (Date.now() < idleDeadline) {
    const requested = host.eventsSince(0).find((event) => event.kind === "interaction.requested");
    if (requested && requested.kind === "interaction.requested") {
      idleInteractionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(idleInteractionId, "expected interaction.requested before peer idle close");

  await waitForCondition(
    () => peersFault.some((peer) => peer.holdingPermission),
    "FakePeer hold mid permission",
  );
  const held = peersFault.find((peer) => peer.holdingPermission);
  assert.ok(held, "expected FakePeer holding permission");
  await held.idleCloseDuringPendingPermission();
  await host.whenIdle();

  const faultEvents = host.eventsSince(0);
  assert.ok(faultEvents.some((event) => event.kind === "tool.started"));
  assert.ok(faultEvents.some((event) => event.kind === "interaction.requested"));
  const error = faultEvents.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const idleFinished = faultEvents.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-caicr-idle",
  );
  assert.ok(idleFinished && idleFinished.kind === "turn.finished");
  assert.equal(idleFinished.outcome, "unknown");
  assert.ok(
    faultEvents.every((event) => event.kind !== "interaction.resolved"),
    "idle close before Host resolve must not journal interaction.resolved",
  );

  // Stale cancel against the dead idle-close turn must be rejected (thin post-fault; ≠ #260/#263 resolve).
  const staleCancel = await host.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-caicr-stale-cancel`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-caicr-idle",
  });
  assert.equal(staleCancel.status, "rejected");
  assert.equal(staleCancel.reasonCode, "stale-turn");

  await host.close();

  // Round 2: reopen + session/load; fresh permission then cancelTurn journals cancelled
  // (≠ #256 mid-prompt holdUntilCancel; ≠ #260 allow / ≠ #263 deny).
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, cancelDuringPermission: true },
        peersAfter,
      ),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen after idle-close must session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "resume must not session/new",
  );

  const sendReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-caicr-send`,
    hostSessionId,
    turnId: "turn-caicr-live",
    text: "cancel during permission after idle-close reopen",
  });
  assert.equal(sendReceipt.status, "accepted");

  const liveDeadline = Date.now() + 5_000;
  while (Date.now() < liveDeadline) {
    if (
      resumed
        .eventsSince(0)
        .some(
          (event) => event.kind === "interaction.requested" && event.turnId === "turn-caicr-live",
        )
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    resumed
      .eventsSince(0)
      .some(
        (event) => event.kind === "interaction.requested" && event.turnId === "turn-caicr-live",
      ),
    "expected fresh interaction.requested after idle-close reopen",
  );

  const cancelReceipt = await resumed.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-caicr-cancel`,
    hostSessionId,
    runtimeEpoch: resumed.binding.runtimeEpoch!,
    turnId: "turn-caicr-live",
  });
  assert.equal(cancelReceipt.status, "completed");
  await resumed.whenIdle();

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/cancel")),
    "cancel must reach ACP peer during pending permission after idle-close reopen",
  );
  const after = resumed.eventsSince(0);
  assert.ok(after.some((event) => event.kind === "tool.started"));
  assert.ok(
    after.every(
      (event) => !(event.kind === "interaction.resolved" && event.turnId === "turn-caicr-live"),
    ),
    "cancel during permission must not journal interaction.resolved for the live turn",
  );
  const liveFinished = after.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-caicr-live",
  );
  assert.ok(liveFinished && liveFinished.kind === "turn.finished");
  assert.equal(liveFinished.outcome, "cancelled");

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-caicr-idle" &&
        event.outcome === "unknown",
    ),
  );
  assert.ok(
    persisted.every(
      (event) => !(event.kind === "interaction.resolved" && event.turnId === "turn-caicr-idle"),
    ),
    "fault-era journal must not contain interaction.resolved for the idle-close turn",
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-caicr-live" &&
        event.outcome === "cancelled",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: cancel-after-idle-close-reopen journals cancelled", async (t) => {
  await assertSessionHostCancelAfterIdleCloseReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: cancel-after-idle-close-reopen journals cancelled (symmetric)", async (t) => {
  await assertSessionHostCancelAfterIdleCloseReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostDoubleCancelAfterIdleCloseReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-dcaicr-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-dcaicr-session`;
  const hostSessionId = `${input.harnessId}-dcaicr-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-dcaicr`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: #236 idle-close-during-permission fence (≠ #223 JSON-RPC mid-permission fault).
  const peersFault: FakePeer[] = [];
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, disconnectDuringPermission: true },
        peersFault,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const idleReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dcaicr-idle`,
    hostSessionId,
    turnId: "turn-dcaicr-idle",
    text: "idle close while permission pending",
  });
  assert.equal(idleReceipt.status, "accepted");

  const idleDeadline = Date.now() + 5_000;
  let idleInteractionId: string | undefined;
  while (Date.now() < idleDeadline) {
    const requested = host.eventsSince(0).find((event) => event.kind === "interaction.requested");
    if (requested && requested.kind === "interaction.requested") {
      idleInteractionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(idleInteractionId, "expected interaction.requested before peer idle close");

  await waitForCondition(
    () => peersFault.some((peer) => peer.holdingPermission),
    "FakePeer hold mid permission",
  );
  const held = peersFault.find((peer) => peer.holdingPermission);
  assert.ok(held, "expected FakePeer holding permission");
  await held.idleCloseDuringPendingPermission();
  await host.whenIdle();

  const faultEvents = host.eventsSince(0);
  assert.ok(faultEvents.some((event) => event.kind === "tool.started"));
  assert.ok(faultEvents.some((event) => event.kind === "interaction.requested"));
  const error = faultEvents.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const idleFinished = faultEvents.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-dcaicr-idle",
  );
  assert.ok(idleFinished && idleFinished.kind === "turn.finished");
  assert.equal(idleFinished.outcome, "unknown");
  assert.ok(
    faultEvents.every((event) => event.kind !== "interaction.resolved"),
    "idle close before Host resolve must not journal interaction.resolved",
  );

  // Stale cancel against the dead idle-close turn must be rejected (thin post-fault; ≠ #260/#263 resolve).
  const staleCancel = await host.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-dcaicr-stale-cancel`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-dcaicr-idle",
  });
  assert.equal(staleCancel.status, "rejected");
  assert.equal(staleCancel.reasonCode, "stale-turn");

  await host.close();

  // Round 2: reopen + session/load; mid-prompt cancelTurn×2 is idempotent
  // (≠ #140 no idle-close fence / ≠ #256 single cancel / ≠ #269 cancel-during-permission).
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, holdUntilCancel: true },
        peersAfter,
      ),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen after idle-close must session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "resume must not session/new",
  );

  const sendReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dcaicr-send`,
    hostSessionId,
    turnId: "turn-dcaicr-live",
    text: "double-cancel after idle-close reopen",
  });
  assert.equal(sendReceipt.status, "accepted");

  const liveDeadline = Date.now() + 5_000;
  while (Date.now() < liveDeadline) {
    if (
      resumed
        .eventsSince(0)
        .some((event) => event.kind === "text.delta" && event.text === "partial before cancel")
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    resumed
      .eventsSince(0)
      .some((event) => event.kind === "text.delta" && event.text === "partial before cancel"),
    "expected partial before cancel after idle-close reopen",
  );

  const epoch = resumed.binding.runtimeEpoch!;
  const first = await resumed.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-dcaicr-cancel-1`,
    hostSessionId,
    runtimeEpoch: epoch,
    turnId: "turn-dcaicr-live",
  });
  assert.equal(first.status, "completed");

  // Second cancel while/after the first: must not hang or crash.
  // Idempotent notify (completed) or already-finished (stale-turn) are both safe.
  const second = await resumed.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-dcaicr-cancel-2`,
    hostSessionId,
    runtimeEpoch: epoch,
    turnId: "turn-dcaicr-live",
  });
  assert.ok(
    second.status === "completed" ||
      (second.status === "rejected" && second.reasonCode === "stale-turn"),
    `second cancel must be idempotent-safe, got ${second.status}/${second.reasonCode}`,
  );

  await resumed.whenIdle();

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/cancel")),
    "at least one session/cancel must reach the peer after idle-close reopen",
  );

  const finished = resumed
    .eventsSince(0)
    .filter((event) => event.kind === "turn.finished" && event.turnId === "turn-dcaicr-live");
  assert.equal(finished.length, 1, "exactly one turn.finished for the cancelled live turn");
  assert.equal(finished[0]!.kind, "turn.finished");
  assert.equal(finished[0]!.outcome, "cancelled");

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-dcaicr-idle" &&
        event.outcome === "unknown",
    ),
  );
  assert.ok(
    persisted.every(
      (event) => !(event.kind === "interaction.resolved" && event.turnId === "turn-dcaicr-idle"),
    ),
    "fault-era journal must not contain interaction.resolved for the idle-close turn",
  );
  const persistedFinished = persisted.filter(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-dcaicr-live",
  );
  assert.equal(persistedFinished.length, 1);
  assert.equal(persistedFinished[0]!.kind, "turn.finished");
  assert.equal(persistedFinished[0]!.outcome, "cancelled");
}

test("SessionHost + opt-in OpenCode ACP: double-cancel-after-idle-close-reopen is idempotent", async (t) => {
  await assertSessionHostDoubleCancelAfterIdleCloseReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: double-cancel-after-idle-close-reopen is idempotent (symmetric)", async (t) => {
  await assertSessionHostDoubleCancelAfterIdleCloseReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostAllowThenCancelAfterIdleCloseReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-atcaicr-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-atcaicr-session`;
  const hostSessionId = `${input.harnessId}-atcaicr-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-atcaicr`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: #236 idle-close-during-permission fence (≠ #223 JSON-RPC mid-permission fault).
  const peersFault: FakePeer[] = [];
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, disconnectDuringPermission: true },
        peersFault,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const idleReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-atcaicr-idle`,
    hostSessionId,
    turnId: "turn-atcaicr-idle",
    text: "idle close while permission pending",
  });
  assert.equal(idleReceipt.status, "accepted");

  const idleDeadline = Date.now() + 5_000;
  let idleInteractionId: string | undefined;
  while (Date.now() < idleDeadline) {
    const requested = host.eventsSince(0).find((event) => event.kind === "interaction.requested");
    if (requested && requested.kind === "interaction.requested") {
      idleInteractionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(idleInteractionId, "expected interaction.requested before peer idle close");

  await waitForCondition(
    () => peersFault.some((peer) => peer.holdingPermission),
    "FakePeer hold mid permission",
  );
  const held = peersFault.find((peer) => peer.holdingPermission);
  assert.ok(held, "expected FakePeer holding permission");
  await held.idleCloseDuringPendingPermission();
  await host.whenIdle();

  const faultEvents = host.eventsSince(0);
  assert.ok(faultEvents.some((event) => event.kind === "tool.started"));
  assert.ok(faultEvents.some((event) => event.kind === "interaction.requested"));
  const error = faultEvents.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const idleFinished = faultEvents.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-atcaicr-idle",
  );
  assert.ok(idleFinished && idleFinished.kind === "turn.finished");
  assert.equal(idleFinished.outcome, "unknown");
  assert.ok(
    faultEvents.every((event) => event.kind !== "interaction.resolved"),
    "idle close before Host resolve must not journal interaction.resolved",
  );

  // Stale cancel against the dead idle-close turn must be rejected (thin post-fault).
  const staleCancel = await host.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-atcaicr-stale-cancel`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-atcaicr-idle",
  });
  assert.equal(staleCancel.status, "rejected");
  assert.equal(staleCancel.reasonCode, "stale-turn");

  await host.close();

  // Round 2: reopen + session/load; fresh permission allow then cancelTurn journals cancelled
  // (≠ #260 allow-completes-send / ≠ #269 cancel-during-permission / ≠ #274 mid-prompt double-cancel).
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, holdAfterPermissionAllowed: true },
        peersAfter,
      ),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen after idle-close must session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "resume must not session/new",
  );

  const errorCountBefore = resumed
    .eventsSince(0)
    .filter((event) => event.kind === "session.error").length;

  const sendReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-atcaicr-send`,
    hostSessionId,
    turnId: "turn-atcaicr-live",
    text: "allow then cancel after idle-close reopen",
  });
  assert.equal(sendReceipt.status, "accepted");

  const liveDeadline = Date.now() + 5_000;
  let liveInteractionId: string | undefined;
  while (Date.now() < liveDeadline) {
    const requested = resumed
      .eventsSince(0)
      .find(
        (event) => event.kind === "interaction.requested" && event.turnId === "turn-atcaicr-live",
      );
    if (requested && requested.kind === "interaction.requested") {
      liveInteractionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(liveInteractionId, "expected interaction.requested after idle-close reopen");

  const epoch = resumed.binding.runtimeEpoch!;
  const allowReceipt = await resumed.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-atcaicr-allow`,
    hostSessionId,
    runtimeEpoch: epoch,
    turnId: "turn-atcaicr-live",
    interactionId: liveInteractionId,
    decision: "allow",
  });
  assert.equal(allowReceipt.status, "completed");

  const cancelReceipt = await resumed.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-atcaicr-cancel`,
    hostSessionId,
    runtimeEpoch: epoch,
    turnId: "turn-atcaicr-live",
  });
  assert.equal(cancelReceipt.status, "completed");
  await resumed.whenIdle();

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/cancel")),
    "cancel must reach the peer after allow following idle-close reopen",
  );

  const liveEvents = resumed.eventsSince(0);
  assert.ok(liveEvents.some((event) => event.kind === "tool.started"));
  assert.ok(
    liveEvents.some((event) => event.kind === "interaction.resolved" && event.decision === "allow"),
  );
  const finished = liveEvents.filter(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-atcaicr-live",
  );
  assert.equal(finished.length, 1, "exactly one turn.finished for the live turn");
  assert.equal(finished[0]!.kind, "turn.finished");
  assert.equal(finished[0]!.outcome, "cancelled");
  assert.equal(
    liveEvents.filter((event) => event.kind === "session.error").length,
    errorCountBefore,
    "allow-then-cancel after idle-close reopen must not journal a new session.error",
  );

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-atcaicr-idle" &&
        event.outcome === "unknown",
    ),
  );
  assert.ok(
    persisted.every(
      (event) => !(event.kind === "interaction.resolved" && event.turnId === "turn-atcaicr-idle"),
    ),
    "fault-era journal must not contain interaction.resolved for the idle-close turn",
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "interaction.resolved" &&
        event.turnId === "turn-atcaicr-live" &&
        event.decision === "allow",
    ),
  );
  const persistedFinished = persisted.filter(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-atcaicr-live",
  );
  assert.equal(persistedFinished.length, 1);
  assert.equal(persistedFinished[0]!.kind, "turn.finished");
  assert.equal(persistedFinished[0]!.outcome, "cancelled");
  assert.equal(
    persisted.filter((event) => event.kind === "session.error").length,
    errorCountBefore,
    "persisted journal must keep prior idle-close errors only",
  );
}

test("SessionHost + opt-in OpenCode ACP: allow-then-cancel-after-idle-close-reopen journals clean", async (t) => {
  await assertSessionHostAllowThenCancelAfterIdleCloseReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: allow-then-cancel-after-idle-close-reopen journals clean (symmetric)", async (t) => {
  await assertSessionHostAllowThenCancelAfterIdleCloseReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostDenyThenCancelAfterIdleCloseReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-dtcaicr-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-dtcaicr-session`;
  const hostSessionId = `${input.harnessId}-dtcaicr-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-dtcaicr`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: #236 idle-close-during-permission fence (≠ #223 JSON-RPC mid-permission fault).
  const peersFault: FakePeer[] = [];
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, disconnectDuringPermission: true },
        peersFault,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const idleReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dtcaicr-idle`,
    hostSessionId,
    turnId: "turn-dtcaicr-idle",
    text: "idle close while permission pending",
  });
  assert.equal(idleReceipt.status, "accepted");

  const idleDeadline = Date.now() + 5_000;
  let idleInteractionId: string | undefined;
  while (Date.now() < idleDeadline) {
    const requested = host.eventsSince(0).find((event) => event.kind === "interaction.requested");
    if (requested && requested.kind === "interaction.requested") {
      idleInteractionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(idleInteractionId, "expected interaction.requested before peer idle close");

  await waitForCondition(
    () => peersFault.some((peer) => peer.holdingPermission),
    "FakePeer hold mid permission",
  );
  const held = peersFault.find((peer) => peer.holdingPermission);
  assert.ok(held, "expected FakePeer holding permission");
  await held.idleCloseDuringPendingPermission();
  await host.whenIdle();

  const faultEvents = host.eventsSince(0);
  assert.ok(faultEvents.some((event) => event.kind === "tool.started"));
  assert.ok(faultEvents.some((event) => event.kind === "interaction.requested"));
  const error = faultEvents.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const idleFinished = faultEvents.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-dtcaicr-idle",
  );
  assert.ok(idleFinished && idleFinished.kind === "turn.finished");
  assert.equal(idleFinished.outcome, "unknown");
  assert.ok(
    faultEvents.every((event) => event.kind !== "interaction.resolved"),
    "idle close before Host resolve must not journal interaction.resolved",
  );

  // Stale cancel against the dead idle-close turn must be rejected (thin post-fault).
  const staleCancel = await host.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-dtcaicr-stale-cancel`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-dtcaicr-idle",
  });
  assert.equal(staleCancel.status, "rejected");
  assert.equal(staleCancel.reasonCode, "stale-turn");

  await host.close();

  // Round 2: reopen + session/load; fresh permission deny then cancelTurn journals cancelled
  // (≠ #263 deny-completes / ≠ #269 cancel-during-permission / ≠ #280 allow-then-cancel).
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, holdAfterPermissionDenied: true },
        peersAfter,
      ),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen after idle-close must session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "resume must not session/new",
  );

  const errorCountBefore = resumed
    .eventsSince(0)
    .filter((event) => event.kind === "session.error").length;

  const sendReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dtcaicr-send`,
    hostSessionId,
    turnId: "turn-dtcaicr-live",
    text: "deny then cancel after idle-close reopen",
  });
  assert.equal(sendReceipt.status, "accepted");

  const liveDeadline = Date.now() + 5_000;
  let liveInteractionId: string | undefined;
  while (Date.now() < liveDeadline) {
    const requested = resumed
      .eventsSince(0)
      .find(
        (event) => event.kind === "interaction.requested" && event.turnId === "turn-dtcaicr-live",
      );
    if (requested && requested.kind === "interaction.requested") {
      liveInteractionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(liveInteractionId, "expected interaction.requested after idle-close reopen");

  const epoch = resumed.binding.runtimeEpoch!;
  const denyReceipt = await resumed.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-dtcaicr-deny`,
    hostSessionId,
    runtimeEpoch: epoch,
    turnId: "turn-dtcaicr-live",
    interactionId: liveInteractionId,
    decision: "deny",
  });
  assert.equal(denyReceipt.status, "completed");

  const cancelReceipt = await resumed.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-dtcaicr-cancel`,
    hostSessionId,
    runtimeEpoch: epoch,
    turnId: "turn-dtcaicr-live",
  });
  assert.equal(cancelReceipt.status, "completed");
  await resumed.whenIdle();

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/cancel")),
    "cancel must reach the peer after deny following idle-close reopen",
  );

  const liveEvents = resumed.eventsSince(0);
  assert.ok(liveEvents.some((event) => event.kind === "tool.started"));
  assert.ok(
    liveEvents.some((event) => event.kind === "interaction.resolved" && event.decision === "deny"),
  );
  const finished = liveEvents.filter(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-dtcaicr-live",
  );
  assert.equal(finished.length, 1, "exactly one turn.finished for the live turn");
  assert.equal(finished[0]!.kind, "turn.finished");
  assert.equal(finished[0]!.outcome, "cancelled");
  assert.equal(
    liveEvents.filter((event) => event.kind === "session.error").length,
    errorCountBefore,
    "deny-then-cancel after idle-close reopen must not journal a new session.error",
  );

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-dtcaicr-idle" &&
        event.outcome === "unknown",
    ),
  );
  assert.ok(
    persisted.every(
      (event) => !(event.kind === "interaction.resolved" && event.turnId === "turn-dtcaicr-idle"),
    ),
    "fault-era journal must not contain interaction.resolved for the idle-close turn",
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "interaction.resolved" &&
        event.turnId === "turn-dtcaicr-live" &&
        event.decision === "deny",
    ),
  );
  const persistedFinished = persisted.filter(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-dtcaicr-live",
  );
  assert.equal(persistedFinished.length, 1);
  assert.equal(persistedFinished[0]!.kind, "turn.finished");
  assert.equal(persistedFinished[0]!.outcome, "cancelled");
  assert.equal(
    persisted.filter((event) => event.kind === "session.error").length,
    errorCountBefore,
    "persisted journal must keep prior idle-close errors only",
  );
}

test("SessionHost + opt-in OpenCode ACP: deny-then-cancel-after-idle-close-reopen journals clean", async (t) => {
  await assertSessionHostDenyThenCancelAfterIdleCloseReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: deny-then-cancel-after-idle-close-reopen journals clean (symmetric)", async (t) => {
  await assertSessionHostDenyThenCancelAfterIdleCloseReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostPermissionResolveAfterReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-prr-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-prr-session`;
  const hostSessionId = `${input.harnessId}-prr-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-prr`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: fault mid-permission (unresolved), then close.
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, {
        loadSession: true,
        disconnectOnToolCall: true,
      }),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const faultReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-prr-fault`,
    hostSessionId,
    turnId: "turn-prr-fault",
    text: "die mid-permission",
  });
  assert.equal(faultReceipt.status, "accepted");
  await host.whenIdle();

  const faultEvents = host.eventsSince(0);
  assert.ok(faultEvents.some((event) => event.kind === "interaction.requested"));
  assert.ok(faultEvents.some((event) => event.kind === "session.error"));
  // Stale resolve against the dead turn must be rejected (no hang / no crash).
  const stale = await host.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-prr-stale`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-prr-fault",
    interactionId: "acp-permission:tool-mid-disconnect",
    decision: "deny",
  });
  assert.equal(stale.status, "rejected");
  assert.equal(stale.reasonCode, "stale-interaction");
  await host.close();

  // Round 2: reopen + session/load; fresh permission deny completes cleanly.
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, awaitPermissionThenContinue: true },
        peersAfter,
      ),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen must session/load after mid-permission fault",
  );

  const sendReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-prr-send`,
    hostSessionId,
    turnId: "turn-prr-live",
    text: "deny after reopen",
  });
  assert.equal(sendReceipt.status, "accepted");

  const deadline = Date.now() + 5_000;
  let interactionId: string | undefined;
  while (Date.now() < deadline) {
    const requested = resumed
      .eventsSince(0)
      .find((event) => event.kind === "interaction.requested" && event.turnId === "turn-prr-live");
    if (requested && requested.kind === "interaction.requested") {
      interactionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(interactionId, "expected fresh interaction.requested after reopen");

  const denyReceipt = await resumed.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-prr-deny`,
    hostSessionId,
    runtimeEpoch: resumed.binding.runtimeEpoch!,
    turnId: "turn-prr-live",
    interactionId,
    decision: "deny",
  });
  assert.equal(denyReceipt.status, "completed");
  await resumed.whenIdle();

  const after = resumed.eventsSince(0);
  assert.ok(
    after.some(
      (event) =>
        event.kind === "interaction.resolved" &&
        event.turnId === "turn-prr-live" &&
        event.decision === "deny",
    ),
  );
  assert.ok(
    after.some((event) => event.kind === "message.finished" && event.text === "deny after reopen"),
  );
  assert.ok(
    after.some((event) => event.kind === "turn.finished" && event.turnId === "turn-prr-live"),
  );

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "session.error"));
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "interaction.resolved" &&
        event.turnId === "turn-prr-live" &&
        event.decision === "deny",
    ),
  );
  assert.ok(
    persisted.some(
      (event) => event.kind === "message.finished" && event.text === "deny after reopen",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: permission-resolve-after-reopen deny is clean", async (t) => {
  await assertSessionHostPermissionResolveAfterReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: permission-resolve-after-reopen deny is clean (symmetric)", async (t) => {
  await assertSessionHostPermissionResolveAfterReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostAllowAfterReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-aar-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-aar-session`;
  const hostSessionId = `${input.harnessId}-aar-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-aar`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: fault mid-permission (unresolved), then close.
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, {
        loadSession: true,
        disconnectOnToolCall: true,
      }),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const faultReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-aar-fault`,
    hostSessionId,
    turnId: "turn-aar-fault",
    text: "die mid-permission",
  });
  assert.equal(faultReceipt.status, "accepted");
  await host.whenIdle();

  const faultEvents = host.eventsSince(0);
  assert.ok(faultEvents.some((event) => event.kind === "interaction.requested"));
  assert.ok(faultEvents.some((event) => event.kind === "session.error"));
  // Stale resolve against the dead turn must be rejected (no hang / no crash).
  const stale = await host.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-aar-stale`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-aar-fault",
    interactionId: "acp-permission:tool-mid-disconnect",
    decision: "allow",
  });
  assert.equal(stale.status, "rejected");
  assert.equal(stale.reasonCode, "stale-interaction");
  await host.close();

  // Round 2: reopen + session/load; fresh permission allow completes send.
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, awaitPermissionThenContinue: true },
        peersAfter,
      ),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen must session/load after mid-permission fault",
  );

  const sendReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-aar-send`,
    hostSessionId,
    turnId: "turn-aar-live",
    text: "allow after reopen",
  });
  assert.equal(sendReceipt.status, "accepted");

  const deadline = Date.now() + 5_000;
  let interactionId: string | undefined;
  while (Date.now() < deadline) {
    const requested = resumed
      .eventsSince(0)
      .find((event) => event.kind === "interaction.requested" && event.turnId === "turn-aar-live");
    if (requested && requested.kind === "interaction.requested") {
      interactionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(interactionId, "expected fresh interaction.requested after reopen");

  const allowReceipt = await resumed.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-aar-allow`,
    hostSessionId,
    runtimeEpoch: resumed.binding.runtimeEpoch!,
    turnId: "turn-aar-live",
    interactionId,
    decision: "allow",
  });
  assert.equal(allowReceipt.status, "completed");
  await resumed.whenIdle();

  const after = resumed.eventsSince(0);
  assert.ok(
    after.some(
      (event) =>
        event.kind === "interaction.resolved" &&
        event.turnId === "turn-aar-live" &&
        event.decision === "allow",
    ),
  );
  assert.ok(
    after.some((event) => event.kind === "message.finished" && event.text === "allow after reopen"),
  );
  assert.ok(
    after.some((event) => event.kind === "turn.finished" && event.turnId === "turn-aar-live"),
  );

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "session.error"));
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "interaction.resolved" &&
        event.turnId === "turn-aar-live" &&
        event.decision === "allow",
    ),
  );
  assert.ok(
    persisted.some(
      (event) => event.kind === "message.finished" && event.text === "allow after reopen",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: allow-after-reopen succeeds send", async (t) => {
  await assertSessionHostAllowAfterReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: allow-after-reopen succeeds send (symmetric)", async (t) => {
  await assertSessionHostAllowAfterReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostDoubleCancel(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-dc-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-dc-session`;
  const hostSessionId = `${input.harnessId}-dc-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-dc`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const peers: FakePeer[] = [];
  const registry = new HarnessRegistry();
  registry.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, { holdUntilCancel: true }, peers),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });

  const sendReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dc-send`,
    hostSessionId,
    turnId: "turn-dc-1",
    text: "cancel me twice",
  });
  assert.equal(sendReceipt.status, "accepted");

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (
      host
        .eventsSince(0)
        .some((event) => event.kind === "text.delta" && event.text === "partial before cancel")
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    host
      .eventsSince(0)
      .some((event) => event.kind === "text.delta" && event.text === "partial before cancel"),
    "expected partial before cancel",
  );

  const epoch = host.binding.runtimeEpoch!;
  const first = await host.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-dc-cancel-1`,
    hostSessionId,
    runtimeEpoch: epoch,
    turnId: "turn-dc-1",
  });
  assert.equal(first.status, "completed");

  // Second cancel while/after the first: must not hang or crash.
  // Idempotent notify (completed) or already-finished (stale-turn) are both safe.
  const second = await host.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-dc-cancel-2`,
    hostSessionId,
    runtimeEpoch: epoch,
    turnId: "turn-dc-1",
  });
  assert.ok(
    second.status === "completed" ||
      (second.status === "rejected" && second.reasonCode === "stale-turn"),
    `second cancel must be idempotent-safe, got ${second.status}/${second.reasonCode}`,
  );

  await host.whenIdle();

  assert.ok(
    peers.some((peer) => peer.methods.includes("session/cancel")),
    "at least one session/cancel must reach the peer",
  );

  const finished = host
    .eventsSince(0)
    .filter((event) => event.kind === "turn.finished" && event.turnId === "turn-dc-1");
  assert.equal(finished.length, 1, "exactly one turn.finished for the cancelled turn");
  assert.equal(finished[0]!.kind, "turn.finished");
  assert.equal(finished[0]!.outcome, "cancelled");

  await host.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  const persistedFinished = persisted.filter(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-dc-1",
  );
  assert.equal(persistedFinished.length, 1);
  assert.equal(persistedFinished[0]!.kind, "turn.finished");
  assert.equal(persistedFinished[0]!.outcome, "cancelled");
}

test("SessionHost + opt-in OpenCode ACP: double-cancel is idempotent", async (t) => {
  await assertSessionHostDoubleCancel({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: double-cancel is idempotent (symmetric)", async (t) => {
  await assertSessionHostDoubleCancel({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostAllowThenDisconnect(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-atd-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const hostSessionId = `${input.harnessId}-atd-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-atd`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const registry = new HarnessRegistry();
  registry.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, `${input.harnessId}-atd-session`, {
        disconnectAfterPermissionAllowed: true,
      }),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });

  const sendReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-atd-send`,
    hostSessionId,
    turnId: "turn-atd",
    text: "allow then die",
  });
  assert.equal(sendReceipt.status, "accepted");

  const deadline = Date.now() + 5_000;
  let interactionId: string | undefined;
  while (Date.now() < deadline) {
    const requested = host.eventsSince(0).find((event) => event.kind === "interaction.requested");
    if (requested && requested.kind === "interaction.requested") {
      interactionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(interactionId, "expected interaction.requested before allow");

  const allowReceipt = await host.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-atd-allow`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-atd",
    interactionId,
    decision: "allow",
  });
  assert.equal(allowReceipt.status, "completed");

  await host.whenIdle();

  const events = host.eventsSince(0);
  assert.ok(events.some((event) => event.kind === "tool.started"));
  assert.ok(
    events.some((event) => event.kind === "interaction.resolved" && event.decision === "allow"),
  );
  const error = events.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const finished = events.find((event) => event.kind === "turn.finished");
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "unknown");

  await host.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some((event) => event.kind === "interaction.resolved" && event.decision === "allow"),
  );
  assert.ok(persisted.some((event) => event.kind === "session.error"));
}

test("SessionHost + opt-in OpenCode ACP: allow-then-disconnect journals allow + fault", async (t) => {
  await assertSessionHostAllowThenDisconnect({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: allow-then-disconnect journals allow + fault (symmetric)", async (t) => {
  await assertSessionHostAllowThenDisconnect({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostAllowThenDisconnectThenReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-atd-ro-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-atd-ro-session`;
  const hostSessionId = `${input.harnessId}-atd-ro-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-atd-ro`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: allow-then-disconnect fence (Host allow → peer JSON-RPC fault mid-turn).
  // ≠ #229/#223 (no interaction.resolved) / ≠ #242/#236 idle-close.
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, {
        loadSession: true,
        disconnectAfterPermissionAllowed: true,
      }),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const sendReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-atd-ro-send`,
    hostSessionId,
    turnId: "turn-atd-ro",
    text: "allow then die then reopen",
  });
  assert.equal(sendReceipt.status, "accepted");

  const deadline = Date.now() + 5_000;
  let interactionId: string | undefined;
  while (Date.now() < deadline) {
    const requested = host.eventsSince(0).find((event) => event.kind === "interaction.requested");
    if (requested && requested.kind === "interaction.requested") {
      interactionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(interactionId, "expected interaction.requested before allow");

  const allowReceipt = await host.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-atd-ro-allow`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-atd-ro",
    interactionId,
    decision: "allow",
  });
  assert.equal(allowReceipt.status, "completed");

  await host.whenIdle();

  const faultEvents = host.eventsSince(0);
  assert.ok(faultEvents.some((event) => event.kind === "tool.started"));
  assert.ok(
    faultEvents.some(
      (event) => event.kind === "interaction.resolved" && event.decision === "allow",
    ),
  );
  const error = faultEvents.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const finished = faultEvents.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-atd-ro",
  );
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "unknown");

  await host.close();

  // Round 2: reopen session/load then first send succeeds (mirror #229←#223, but after allow+fault).
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, { loadSession: true }, peersAfter),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen after allow-then-disconnect must session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "resume must not session/new",
  );

  const resumeReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-atd-ro-resume`,
    hostSessionId,
    turnId: "turn-atd-ro-resume",
    text: "after atd reopen",
  });
  assert.equal(resumeReceipt.status, "accepted");
  await resumed.whenIdle();

  const after = resumed.eventsSince(0);
  assert.ok(after.some((event) => event.kind === "session.error"));
  assert.ok(
    after.some((event) => event.kind === "message.finished" && event.text === "after atd reopen"),
  );
  assert.ok(
    after.some((event) => event.kind === "turn.finished" && event.turnId === "turn-atd-ro-resume"),
  );

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some((event) => event.kind === "interaction.resolved" && event.decision === "allow"),
    "fault-era journal must keep interaction.resolved allow",
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-atd-ro" &&
        event.outcome === "unknown",
    ),
  );
  assert.ok(persisted.some((event) => event.kind === "session.error"));
  assert.ok(
    persisted.some(
      (event) => event.kind === "message.finished" && event.text === "after atd reopen",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: allow-then-disconnect then reopen first send succeeds", async (t) => {
  await assertSessionHostAllowThenDisconnectThenReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: allow-then-disconnect then reopen first send succeeds (symmetric)", async (t) => {
  await assertSessionHostAllowThenDisconnectThenReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostCancelThenDisconnect(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-ctd-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const hostSessionId = `${input.harnessId}-ctd-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-ctd`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const peers: FakePeer[] = [];
  const registry = new HarnessRegistry();
  registry.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        `${input.harnessId}-ctd-session`,
        { disconnectAfterCancel: true },
        peers,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });

  const sendReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ctd-send`,
    hostSessionId,
    turnId: "turn-ctd",
    text: "cancel then die",
  });
  assert.equal(sendReceipt.status, "accepted");

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (
      host
        .eventsSince(0)
        .some(
          (event) =>
            event.kind === "text.delta" && event.text === "partial before cancel-disconnect",
        )
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    host
      .eventsSince(0)
      .some(
        (event) => event.kind === "text.delta" && event.text === "partial before cancel-disconnect",
      ),
    "expected partial before cancel-disconnect",
  );

  const cancelReceipt = await host.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-ctd-cancel`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-ctd",
  });
  assert.equal(cancelReceipt.status, "completed");
  await host.whenIdle();

  assert.ok(
    peers.some((peer) => peer.methods.includes("session/cancel")),
    "cancel must reach the ACP peer before disconnect",
  );

  const events = host.eventsSince(0);
  const error = events.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const finished = events.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-ctd",
  );
  assert.ok(finished && finished.kind === "turn.finished");
  // Host marked cancelled before the peer fault; outcome stays cancelled (not a hang).
  assert.equal(finished.outcome, "cancelled");

  await host.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "session.error"));
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-ctd" &&
        event.outcome === "cancelled",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: cancel-then-disconnect journals cancel + fault", async (t) => {
  await assertSessionHostCancelThenDisconnect({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: cancel-then-disconnect journals cancel + fault (symmetric)", async (t) => {
  await assertSessionHostCancelThenDisconnect({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostCancelThenDisconnectThenReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-ctd-ro-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-ctd-ro-session`;
  const hostSessionId = `${input.harnessId}-ctd-ro-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-ctd-ro`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: cancel-then-disconnect fence (Host cancel mid-prompt → peer JSON-RPC fault).
  // ≠ #288 allow-then-disconnect-then-reopen / ≠ #229 no-resolve permission disconnect / ≠ idle-close.
  const peersLive: FakePeer[] = [];
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, disconnectAfterCancel: true },
        peersLive,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const sendReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ctd-ro-send`,
    hostSessionId,
    turnId: "turn-ctd-ro",
    text: "cancel then die then reopen",
  });
  assert.equal(sendReceipt.status, "accepted");

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (
      host
        .eventsSince(0)
        .some(
          (event) =>
            event.kind === "text.delta" && event.text === "partial before cancel-disconnect",
        )
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    host
      .eventsSince(0)
      .some(
        (event) => event.kind === "text.delta" && event.text === "partial before cancel-disconnect",
      ),
    "expected partial before cancel-disconnect",
  );

  const cancelReceipt = await host.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-ctd-ro-cancel`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-ctd-ro",
  });
  assert.equal(cancelReceipt.status, "completed");
  await host.whenIdle();

  assert.ok(
    peersLive.some((peer) => peer.methods.includes("session/cancel")),
    "cancel must reach the ACP peer before disconnect",
  );

  const faultEvents = host.eventsSince(0);
  const error = faultEvents.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const finished = faultEvents.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-ctd-ro",
  );
  assert.ok(finished && finished.kind === "turn.finished");
  // Host marked cancelled before the peer fault; outcome stays cancelled (not a hang).
  assert.equal(finished.outcome, "cancelled");

  await host.close();

  // Round 2: reopen session/load then first send succeeds (mirror #288←#143, but after cancel+fault).
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, { loadSession: true }, peersAfter),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen after cancel-then-disconnect must session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "resume must not session/new",
  );

  const resumeReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ctd-ro-resume`,
    hostSessionId,
    turnId: "turn-ctd-ro-resume",
    text: "after ctd reopen",
  });
  assert.equal(resumeReceipt.status, "accepted");
  await resumed.whenIdle();

  const after = resumed.eventsSince(0);
  assert.ok(after.some((event) => event.kind === "session.error"));
  assert.ok(
    after.some((event) => event.kind === "message.finished" && event.text === "after ctd reopen"),
  );
  assert.ok(
    after.some((event) => event.kind === "turn.finished" && event.turnId === "turn-ctd-ro-resume"),
  );

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-ctd-ro" &&
        event.outcome === "cancelled",
    ),
    "fault-era journal must keep turn.finished cancelled",
  );
  assert.ok(persisted.some((event) => event.kind === "session.error"));
  assert.ok(
    persisted.some(
      (event) => event.kind === "message.finished" && event.text === "after ctd reopen",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: cancel-then-disconnect then reopen first send succeeds", async (t) => {
  await assertSessionHostCancelThenDisconnectThenReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: cancel-then-disconnect then reopen first send succeeds (symmetric)", async (t) => {
  await assertSessionHostCancelThenDisconnectThenReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostDenyThenDisconnectThenReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-dtd-ro-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-dtd-ro-session`;
  const hostSessionId = `${input.harnessId}-dtd-ro-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-dtd-ro`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: deny-then-disconnect fence (Host deny → peer JSON-RPC fault mid-turn).
  // ≠ #288 allow+fault / ≠ #291 cancel+fault / ≠ #229 no interaction.resolved / ≠ idle-close.
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, {
        loadSession: true,
        disconnectAfterPermissionDenied: true,
      }),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const sendReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dtd-ro-send`,
    hostSessionId,
    turnId: "turn-dtd-ro",
    text: "deny then die then reopen",
  });
  assert.equal(sendReceipt.status, "accepted");

  const deadline = Date.now() + 5_000;
  let interactionId: string | undefined;
  while (Date.now() < deadline) {
    const requested = host.eventsSince(0).find((event) => event.kind === "interaction.requested");
    if (requested && requested.kind === "interaction.requested") {
      interactionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(interactionId, "expected interaction.requested before deny");

  const denyReceipt = await host.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-dtd-ro-deny`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-dtd-ro",
    interactionId,
    decision: "deny",
  });
  assert.equal(denyReceipt.status, "completed");

  await host.whenIdle();

  const faultEvents = host.eventsSince(0);
  assert.ok(faultEvents.some((event) => event.kind === "tool.started"));
  assert.ok(
    faultEvents.some((event) => event.kind === "interaction.resolved" && event.decision === "deny"),
  );
  const error = faultEvents.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const finished = faultEvents.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-dtd-ro",
  );
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "unknown");

  await host.close();

  // Round 2: reopen session/load then first send succeeds (mirror #288/#291, after deny+fault).
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, { loadSession: true }, peersAfter),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen after deny-then-disconnect must session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "resume must not session/new",
  );

  const resumeReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dtd-ro-resume`,
    hostSessionId,
    turnId: "turn-dtd-ro-resume",
    text: "after dtd reopen",
  });
  assert.equal(resumeReceipt.status, "accepted");
  await resumed.whenIdle();

  const after = resumed.eventsSince(0);
  assert.ok(after.some((event) => event.kind === "session.error"));
  assert.ok(
    after.some((event) => event.kind === "message.finished" && event.text === "after dtd reopen"),
  );
  assert.ok(
    after.some((event) => event.kind === "turn.finished" && event.turnId === "turn-dtd-ro-resume"),
  );

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some((event) => event.kind === "interaction.resolved" && event.decision === "deny"),
    "fault-era journal must keep interaction.resolved deny",
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-dtd-ro" &&
        event.outcome === "unknown",
    ),
  );
  assert.ok(persisted.some((event) => event.kind === "session.error"));
  assert.ok(
    persisted.some(
      (event) => event.kind === "message.finished" && event.text === "after dtd reopen",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: deny-then-disconnect then reopen first send succeeds", async (t) => {
  await assertSessionHostDenyThenDisconnectThenReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: deny-then-disconnect then reopen first send succeeds (symmetric)", async (t) => {
  await assertSessionHostDenyThenDisconnectThenReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostAllowThenDisconnectThenFaultReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-atdfr-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-atdfr-session`;
  const hostSessionId = `${input.harnessId}-atdfr-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-atdfr`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  async function openHostWith(
    options: FakePeerOptions,
    peers: FakePeer[],
    mode: "create" | "open",
  ): Promise<SessionHost> {
    const registry = new HarnessRegistry();
    registry.register(
      input.createHarness(() =>
        openFakeTransport(input.agentName, backendSessionId, options, peers),
      ),
    );
    if (mode === "create") {
      return SessionHost.create({
        root: journalRoot,
        spec,
        target,
        catalog,
        registry,
      });
    }
    return SessionHost.open({
      root: journalRoot,
      spec,
      target,
      catalog,
      registry,
    });
  }

  // Round 1: allow-then-disconnect fence (Host allow → peer JSON-RPC fault mid-turn).
  // ≠ #248 idle-close (no interaction.resolved) / ≠ #229 no-resolve / ≠ #294 deny+fault.
  const peers1: FakePeer[] = [];
  const host1 = await openHostWith(
    { loadSession: true, disconnectAfterPermissionAllowed: true },
    peers1,
    "create",
  );
  const send1 = await host1.dispatch({
    type: "send",
    commandId: `${input.harnessId}-atdfr-allow`,
    hostSessionId,
    turnId: "turn-atdfr-allow",
    text: "allow then die then fault reopen",
  });
  assert.equal(send1.status, "accepted");

  const deadline = Date.now() + 5_000;
  let interactionId: string | undefined;
  while (Date.now() < deadline) {
    const requested = host1.eventsSince(0).find((event) => event.kind === "interaction.requested");
    if (requested && requested.kind === "interaction.requested") {
      interactionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(interactionId, "expected interaction.requested before allow");

  const allowReceipt = await host1.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-atdfr-resolve`,
    hostSessionId,
    runtimeEpoch: host1.binding.runtimeEpoch!,
    turnId: "turn-atdfr-allow",
    interactionId,
    decision: "allow",
  });
  assert.equal(allowReceipt.status, "completed");
  await host1.whenIdle();

  const allowEvents = host1.eventsSince(0);
  assert.ok(allowEvents.some((event) => event.kind === "tool.started"));
  assert.ok(
    allowEvents.some(
      (event) => event.kind === "interaction.resolved" && event.decision === "allow",
    ),
  );
  const allowError = allowEvents.find((event) => event.kind === "session.error");
  assert.ok(allowError && allowError.kind === "session.error");
  assert.match(allowError.message, /ACP transport closed/);
  const allowFinished = allowEvents.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-atdfr-allow",
  );
  assert.ok(allowFinished && allowFinished.kind === "turn.finished");
  assert.equal(allowFinished.outcome, "unknown");
  await host1.close();

  // Round 2: reopen (session/load) → JSON-RPC mid-prompt fault (mirror #248 round 2;
  // ≠ #288 which stops at healthy first send after reopen).
  const peers2: FakePeer[] = [];
  const host2 = await openHostWith({ loadSession: true, disconnectOnPrompt: true }, peers2, "open");
  assert.ok(
    peers2.some((peer) => peer.methods.includes("session/load")),
    "first reopen must session/load",
  );
  assert.ok(
    peers2.every((peer) => !peer.methods.includes("session/new")),
    "first reopen must not session/new",
  );
  const fault2 = await host2.dispatch({
    type: "send",
    commandId: `${input.harnessId}-atdfr-fault`,
    hostSessionId,
    turnId: "turn-atdfr-fault",
    text: "second fault mid-prompt after atd",
  });
  assert.equal(fault2.status, "accepted");
  await host2.whenIdle();
  const afterFault = host2.eventsSince(0);
  const errorsAfterTwo = afterFault.filter((event) => event.kind === "session.error");
  assert.ok(errorsAfterTwo.length >= 2, `expected ≥2 session.error, got ${errorsAfterTwo.length}`);
  assert.ok(
    afterFault.some(
      (event) => event.kind === "turn.finished" && event.turnId === "turn-atdfr-fault",
    ),
  );
  await host2.close();

  // Round 3: second reopen stays idempotent (session/load again), then healthy send.
  const peers3: FakePeer[] = [];
  const host3 = await openHostWith({ loadSession: true }, peers3, "open");
  assert.ok(
    peers3.some((peer) => peer.methods.includes("session/load")),
    "second reopen must session/load (idempotent)",
  );
  assert.ok(
    peers3.every((peer) => !peer.methods.includes("session/new")),
    "second reopen must not session/new",
  );

  const ok = await host3.dispatch({
    type: "send",
    commandId: `${input.harnessId}-atdfr-ok`,
    hostSessionId,
    turnId: "turn-atdfr-ok",
    text: "after allow-then-disconnect then fault",
  });
  assert.equal(ok.status, "accepted");
  await host3.whenIdle();

  const finalEvents = host3.eventsSince(0);
  assert.ok(
    finalEvents.some(
      (event) =>
        event.kind === "message.finished" &&
        event.text === "after allow-then-disconnect then fault",
    ),
  );
  assert.ok(
    finalEvents.some((event) => event.kind === "turn.finished" && event.turnId === "turn-atdfr-ok"),
  );

  await host3.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.filter((event) => event.kind === "session.error").length >= 2,
    "journal must keep allow-then-disconnect + mid-prompt fault fences",
  );
  assert.ok(
    persisted.some((event) => event.kind === "interaction.resolved" && event.decision === "allow"),
    "fault-era journal must keep interaction.resolved allow",
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-atdfr-allow" &&
        event.outcome === "unknown",
    ),
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "message.finished" &&
        event.text === "after allow-then-disconnect then fault",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: allow-then-disconnect-then-fault reopen idempotency then send", async (t) => {
  await assertSessionHostAllowThenDisconnectThenFaultReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: allow-then-disconnect-then-fault reopen idempotency then send (symmetric)", async (t) => {
  await assertSessionHostAllowThenDisconnectThenFaultReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostCancelThenDisconnectThenFaultReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-ctdfr-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-ctdfr-session`;
  const hostSessionId = `${input.harnessId}-ctdfr-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-ctdfr`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  async function openHostWith(
    options: FakePeerOptions,
    peers: FakePeer[],
    mode: "create" | "open",
  ): Promise<SessionHost> {
    const registry = new HarnessRegistry();
    registry.register(
      input.createHarness(() =>
        openFakeTransport(input.agentName, backendSessionId, options, peers),
      ),
    );
    if (mode === "create") {
      return SessionHost.create({
        root: journalRoot,
        spec,
        target,
        catalog,
        registry,
      });
    }
    return SessionHost.open({
      root: journalRoot,
      spec,
      target,
      catalog,
      registry,
    });
  }

  // Round 1: cancel-then-disconnect fence (Host cancel mid-prompt → peer JSON-RPC fault).
  // ≠ #299 allow-then-disconnect fence / ≠ #248 idle-close / ≠ #229 no-resolve.
  const peers1: FakePeer[] = [];
  const host1 = await openHostWith(
    { loadSession: true, disconnectAfterCancel: true },
    peers1,
    "create",
  );
  const send1 = await host1.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ctdfr-cancel`,
    hostSessionId,
    turnId: "turn-ctdfr-cancel",
    text: "cancel then die then fault reopen",
  });
  assert.equal(send1.status, "accepted");

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (
      host1
        .eventsSince(0)
        .some(
          (event) =>
            event.kind === "text.delta" && event.text === "partial before cancel-disconnect",
        )
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    host1
      .eventsSince(0)
      .some(
        (event) => event.kind === "text.delta" && event.text === "partial before cancel-disconnect",
      ),
    "expected partial before cancel-disconnect",
  );

  const cancelReceipt = await host1.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-ctdfr-cancel-cmd`,
    hostSessionId,
    runtimeEpoch: host1.binding.runtimeEpoch!,
    turnId: "turn-ctdfr-cancel",
  });
  assert.equal(cancelReceipt.status, "completed");
  await host1.whenIdle();

  assert.ok(
    peers1.some((peer) => peer.methods.includes("session/cancel")),
    "cancel must reach the ACP peer before disconnect",
  );

  const cancelEvents = host1.eventsSince(0);
  const cancelError = cancelEvents.find((event) => event.kind === "session.error");
  assert.ok(cancelError && cancelError.kind === "session.error");
  assert.match(cancelError.message, /ACP transport closed/);
  const cancelFinished = cancelEvents.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-ctdfr-cancel",
  );
  assert.ok(cancelFinished && cancelFinished.kind === "turn.finished");
  // Host marked cancelled before the peer fault; outcome stays cancelled (not a hang).
  assert.equal(cancelFinished.outcome, "cancelled");
  await host1.close();

  // Round 2: reopen (session/load) → JSON-RPC mid-prompt fault (mirror #299/#248 round 2;
  // ≠ #291 which stops at healthy first send after reopen).
  const peers2: FakePeer[] = [];
  const host2 = await openHostWith({ loadSession: true, disconnectOnPrompt: true }, peers2, "open");
  assert.ok(
    peers2.some((peer) => peer.methods.includes("session/load")),
    "first reopen must session/load",
  );
  assert.ok(
    peers2.every((peer) => !peer.methods.includes("session/new")),
    "first reopen must not session/new",
  );
  const fault2 = await host2.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ctdfr-fault`,
    hostSessionId,
    turnId: "turn-ctdfr-fault",
    text: "second fault mid-prompt after ctd",
  });
  assert.equal(fault2.status, "accepted");
  await host2.whenIdle();
  const afterFault = host2.eventsSince(0);
  const errorsAfterTwo = afterFault.filter((event) => event.kind === "session.error");
  assert.ok(errorsAfterTwo.length >= 2, `expected ≥2 session.error, got ${errorsAfterTwo.length}`);
  assert.ok(
    afterFault.some(
      (event) => event.kind === "turn.finished" && event.turnId === "turn-ctdfr-fault",
    ),
  );
  await host2.close();

  // Round 3: second reopen stays idempotent (session/load again), then healthy send.
  const peers3: FakePeer[] = [];
  const host3 = await openHostWith({ loadSession: true }, peers3, "open");
  assert.ok(
    peers3.some((peer) => peer.methods.includes("session/load")),
    "second reopen must session/load (idempotent)",
  );
  assert.ok(
    peers3.every((peer) => !peer.methods.includes("session/new")),
    "second reopen must not session/new",
  );

  const ok = await host3.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ctdfr-ok`,
    hostSessionId,
    turnId: "turn-ctdfr-ok",
    text: "after cancel-then-disconnect then fault",
  });
  assert.equal(ok.status, "accepted");
  await host3.whenIdle();

  const finalEvents = host3.eventsSince(0);
  assert.ok(
    finalEvents.some(
      (event) =>
        event.kind === "message.finished" &&
        event.text === "after cancel-then-disconnect then fault",
    ),
  );
  assert.ok(
    finalEvents.some((event) => event.kind === "turn.finished" && event.turnId === "turn-ctdfr-ok"),
  );

  await host3.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.filter((event) => event.kind === "session.error").length >= 2,
    "journal must keep cancel-then-disconnect + mid-prompt fault fences",
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-ctdfr-cancel" &&
        event.outcome === "cancelled",
    ),
    "fault-era journal must keep turn.finished cancelled",
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "message.finished" &&
        event.text === "after cancel-then-disconnect then fault",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: cancel-then-disconnect-then-fault reopen idempotency then send", async (t) => {
  await assertSessionHostCancelThenDisconnectThenFaultReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: cancel-then-disconnect-then-fault reopen idempotency then send (symmetric)", async (t) => {
  await assertSessionHostCancelThenDisconnectThenFaultReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostDenyThenDisconnectThenFaultReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-dtdfr-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-dtdfr-session`;
  const hostSessionId = `${input.harnessId}-dtdfr-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-dtdfr`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  async function openHostWith(
    options: FakePeerOptions,
    peers: FakePeer[],
    mode: "create" | "open",
  ): Promise<SessionHost> {
    const registry = new HarnessRegistry();
    registry.register(
      input.createHarness(() =>
        openFakeTransport(input.agentName, backendSessionId, options, peers),
      ),
    );
    if (mode === "create") {
      return SessionHost.create({
        root: journalRoot,
        spec,
        target,
        catalog,
        registry,
      });
    }
    return SessionHost.open({
      root: journalRoot,
      spec,
      target,
      catalog,
      registry,
    });
  }

  // Round 1: deny-then-disconnect fence (Host deny → peer JSON-RPC fault mid-turn).
  // ≠ #299 allow-then-disconnect fence / ≠ #302 cancel-then-disconnect / ≠ #248 idle-close / ≠ #229 no-resolve.
  const peers1: FakePeer[] = [];
  const host1 = await openHostWith(
    { loadSession: true, disconnectAfterPermissionDenied: true },
    peers1,
    "create",
  );
  const send1 = await host1.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dtdfr-deny`,
    hostSessionId,
    turnId: "turn-dtdfr-deny",
    text: "deny then die then fault reopen",
  });
  assert.equal(send1.status, "accepted");

  const deadline = Date.now() + 5_000;
  let interactionId: string | undefined;
  while (Date.now() < deadline) {
    const requested = host1.eventsSince(0).find((event) => event.kind === "interaction.requested");
    if (requested && requested.kind === "interaction.requested") {
      interactionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(interactionId, "expected interaction.requested before deny");

  const denyReceipt = await host1.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-dtdfr-resolve`,
    hostSessionId,
    runtimeEpoch: host1.binding.runtimeEpoch!,
    turnId: "turn-dtdfr-deny",
    interactionId,
    decision: "deny",
  });
  assert.equal(denyReceipt.status, "completed");
  await host1.whenIdle();

  const denyEvents = host1.eventsSince(0);
  assert.ok(denyEvents.some((event) => event.kind === "tool.started"));
  assert.ok(
    denyEvents.some((event) => event.kind === "interaction.resolved" && event.decision === "deny"),
  );
  const denyError = denyEvents.find((event) => event.kind === "session.error");
  assert.ok(denyError && denyError.kind === "session.error");
  assert.match(denyError.message, /ACP transport closed/);
  const denyFinished = denyEvents.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-dtdfr-deny",
  );
  assert.ok(denyFinished && denyFinished.kind === "turn.finished");
  assert.equal(denyFinished.outcome, "unknown");
  await host1.close();

  // Round 2: reopen (session/load) → JSON-RPC mid-prompt fault (mirror #299/#302/#248 round 2;
  // ≠ #294 which stops at healthy first send after reopen).
  const peers2: FakePeer[] = [];
  const host2 = await openHostWith({ loadSession: true, disconnectOnPrompt: true }, peers2, "open");
  assert.ok(
    peers2.some((peer) => peer.methods.includes("session/load")),
    "first reopen must session/load",
  );
  assert.ok(
    peers2.every((peer) => !peer.methods.includes("session/new")),
    "first reopen must not session/new",
  );
  const fault2 = await host2.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dtdfr-fault`,
    hostSessionId,
    turnId: "turn-dtdfr-fault",
    text: "second fault mid-prompt after dtd",
  });
  assert.equal(fault2.status, "accepted");
  await host2.whenIdle();
  const afterFault = host2.eventsSince(0);
  const errorsAfterTwo = afterFault.filter((event) => event.kind === "session.error");
  assert.ok(errorsAfterTwo.length >= 2, `expected ≥2 session.error, got ${errorsAfterTwo.length}`);
  assert.ok(
    afterFault.some(
      (event) => event.kind === "turn.finished" && event.turnId === "turn-dtdfr-fault",
    ),
  );
  await host2.close();

  // Round 3: second reopen stays idempotent (session/load again), then healthy send.
  const peers3: FakePeer[] = [];
  const host3 = await openHostWith({ loadSession: true }, peers3, "open");
  assert.ok(
    peers3.some((peer) => peer.methods.includes("session/load")),
    "second reopen must session/load (idempotent)",
  );
  assert.ok(
    peers3.every((peer) => !peer.methods.includes("session/new")),
    "second reopen must not session/new",
  );

  const ok = await host3.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dtdfr-ok`,
    hostSessionId,
    turnId: "turn-dtdfr-ok",
    text: "after deny-then-disconnect then fault",
  });
  assert.equal(ok.status, "accepted");
  await host3.whenIdle();

  const finalEvents = host3.eventsSince(0);
  assert.ok(
    finalEvents.some(
      (event) =>
        event.kind === "message.finished" && event.text === "after deny-then-disconnect then fault",
    ),
  );
  assert.ok(
    finalEvents.some((event) => event.kind === "turn.finished" && event.turnId === "turn-dtdfr-ok"),
  );

  await host3.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.filter((event) => event.kind === "session.error").length >= 2,
    "journal must keep deny-then-disconnect + mid-prompt fault fences",
  );
  assert.ok(
    persisted.some((event) => event.kind === "interaction.resolved" && event.decision === "deny"),
    "fault-era journal must keep interaction.resolved deny",
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-dtdfr-deny" &&
        event.outcome === "unknown",
    ),
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "message.finished" && event.text === "after deny-then-disconnect then fault",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: deny-then-disconnect-then-fault reopen idempotency then send", async (t) => {
  await assertSessionHostDenyThenDisconnectThenFaultReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: deny-then-disconnect-then-fault reopen idempotency then send (symmetric)", async (t) => {
  await assertSessionHostDenyThenDisconnectThenFaultReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostDenyThenCancel(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-dtc-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const hostSessionId = `${input.harnessId}-dtc-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-dtc`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const peers: FakePeer[] = [];
  const registry = new HarnessRegistry();
  registry.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        `${input.harnessId}-dtc-session`,
        { holdAfterPermissionDenied: true },
        peers,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });

  const sendReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dtc-send`,
    hostSessionId,
    turnId: "turn-dtc",
    text: "deny then cancel",
  });
  assert.equal(sendReceipt.status, "accepted");

  const deadline = Date.now() + 5_000;
  let interactionId: string | undefined;
  while (Date.now() < deadline) {
    const requested = host.eventsSince(0).find((event) => event.kind === "interaction.requested");
    if (requested && requested.kind === "interaction.requested") {
      interactionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(interactionId, "expected interaction.requested before deny");

  const denyReceipt = await host.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-dtc-deny`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-dtc",
    interactionId,
    decision: "deny",
  });
  assert.equal(denyReceipt.status, "completed");

  const cancelReceipt = await host.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-dtc-cancel`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-dtc",
  });
  assert.equal(cancelReceipt.status, "completed");
  await host.whenIdle();

  assert.ok(
    peers.some((peer) => peer.methods.includes("session/cancel")),
    "cancel must reach the peer after deny",
  );

  const events = host.eventsSince(0);
  assert.ok(events.some((event) => event.kind === "tool.started"));
  assert.ok(
    events.some((event) => event.kind === "interaction.resolved" && event.decision === "deny"),
  );
  const finished = events.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-dtc",
  );
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "cancelled");
  assert.ok(!events.some((event) => event.kind === "session.error"));

  await host.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some((event) => event.kind === "interaction.resolved" && event.decision === "deny"),
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-dtc" &&
        event.outcome === "cancelled",
    ),
  );
  assert.ok(!persisted.some((event) => event.kind === "session.error"));
}

test("SessionHost + opt-in OpenCode ACP: deny-then-cancel journals clean", async (t) => {
  await assertSessionHostDenyThenCancel({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: deny-then-cancel journals clean (symmetric)", async (t) => {
  await assertSessionHostDenyThenCancel({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostAllowThenCancel(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-atc-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const hostSessionId = `${input.harnessId}-atc-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-atc`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const peers: FakePeer[] = [];
  const registry = new HarnessRegistry();
  registry.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        `${input.harnessId}-atc-session`,
        { holdAfterPermissionAllowed: true },
        peers,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });

  const sendReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-atc-send`,
    hostSessionId,
    turnId: "turn-atc",
    text: "allow then cancel",
  });
  assert.equal(sendReceipt.status, "accepted");

  const deadline = Date.now() + 5_000;
  let interactionId: string | undefined;
  while (Date.now() < deadline) {
    const requested = host.eventsSince(0).find((event) => event.kind === "interaction.requested");
    if (requested && requested.kind === "interaction.requested") {
      interactionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(interactionId, "expected interaction.requested before allow");

  const allowReceipt = await host.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-atc-allow`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-atc",
    interactionId,
    decision: "allow",
  });
  assert.equal(allowReceipt.status, "completed");

  const cancelReceipt = await host.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-atc-cancel`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-atc",
  });
  assert.equal(cancelReceipt.status, "completed");
  await host.whenIdle();

  assert.ok(
    peers.some((peer) => peer.methods.includes("session/cancel")),
    "cancel must reach the peer after allow",
  );

  const events = host.eventsSince(0);
  assert.ok(events.some((event) => event.kind === "tool.started"));
  assert.ok(
    events.some((event) => event.kind === "interaction.resolved" && event.decision === "allow"),
  );
  const finished = events.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-atc",
  );
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "cancelled");
  assert.ok(!events.some((event) => event.kind === "session.error"));

  await host.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some((event) => event.kind === "interaction.resolved" && event.decision === "allow"),
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-atc" &&
        event.outcome === "cancelled",
    ),
  );
  assert.ok(!persisted.some((event) => event.kind === "session.error"));
}

test("SessionHost + opt-in OpenCode ACP: allow-then-cancel journals clean", async (t) => {
  await assertSessionHostAllowThenCancel({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: allow-then-cancel journals clean (symmetric)", async (t) => {
  await assertSessionHostAllowThenCancel({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostFaultDuringSessionLoad(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-fdsl-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-fdsl-session`;
  const hostSessionId = `${input.harnessId}-fdsl-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-fdsl`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: negotiate loadSession, disconnect mid-prompt, close.
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, {
        loadSession: true,
        disconnectOnPrompt: true,
      }),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const faultReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-fdsl-fault`,
    hostSessionId,
    turnId: "turn-fdsl-fault",
    text: "die mid-prompt",
  });
  assert.equal(faultReceipt.status, "accepted");
  await host.whenIdle();
  assert.ok(host.eventsSince(0).some((event) => event.kind === "session.error"));
  await host.close();

  // Round 2: reopen attach hits session/load mid-fault — open must fail clean (no hang).
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, faultOnSessionLoad: true },
        peersAfter,
      ),
    ),
  );

  await assert.rejects(
    () =>
      SessionHost.open({
        root: journalRoot,
        spec,
        target,
        catalog,
        registry: registryReopen,
      }),
    (error: unknown) => error instanceof Error && /ACP transport closed/.test(error.message),
  );

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen must attempt session/load before fault",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "failed load must not fall back to session/new",
  );

  // Prior journal remains readable; load fault did not corrupt history.
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "session.error"));
}

test("SessionHost + opt-in OpenCode ACP: fault-during-session-load fails open clean", async (t) => {
  await assertSessionHostFaultDuringSessionLoad({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: fault-during-session-load fails open clean (symmetric)", async (t) => {
  await assertSessionHostFaultDuringSessionLoad({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostLoadThenCancel(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-ltc-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-ltc-session`;
  const hostSessionId = `${input.harnessId}-ltc-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-ltc`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: negotiate loadSession, disconnect mid-prompt, close — same fence as resume/fault-load.
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, {
        loadSession: true,
        disconnectOnPrompt: true,
      }),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const faultReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ltc-fault`,
    hostSessionId,
    turnId: "turn-ltc-fault",
    text: "die mid-prompt",
  });
  assert.equal(faultReceipt.status, "accepted");
  await host.whenIdle();
  assert.ok(host.eventsSince(0).some((event) => event.kind === "session.error"));
  await host.close();

  // Round 2: reopen attach via session/load (must succeed — no faultOnSessionLoad).
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, { loadSession: true }, peersAfter),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen must attach via session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "successful load must not fall back to session/new",
  );

  const errorCountBefore = resumed
    .eventsSince(0)
    .filter((event) => event.kind === "session.error").length;

  // Cancel before any new send: no in-flight turn after successful load → stale.
  const staleCancel = await resumed.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-ltc-stale-cancel`,
    hostSessionId,
    runtimeEpoch: resumed.binding.runtimeEpoch!,
    turnId: "turn-ltc-fault",
  });
  assert.equal(staleCancel.status, "rejected");
  assert.equal(staleCancel.reasonCode, "stale-turn");
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/cancel")),
    "stale cancel must not notify session/cancel",
  );
  assert.equal(
    resumed.eventsSince(0).filter((event) => event.kind === "session.error").length,
    errorCountBefore,
    "stale cancel must not journal a new session.error",
  );

  // Recovery: fresh send after the no-op cancel still works.
  const sendReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ltc-send`,
    hostSessionId,
    turnId: "turn-ltc-live",
    text: "hello after load-then-cancel",
  });
  assert.equal(sendReceipt.status, "accepted");
  await resumed.whenIdle();
  const finished = resumed
    .eventsSince(0)
    .find((event) => event.kind === "turn.finished" && event.turnId === "turn-ltc-live");
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "success");

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "session.error"));
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-ltc-live" &&
        event.outcome === "success",
    ),
  );
  assert.equal(
    persisted.filter((event) => event.kind === "session.error").length,
    errorCountBefore,
    "persisted journal must keep prior fault errors only",
  );
}

test("SessionHost + opt-in OpenCode ACP: load-then-cancel is stale before first send", async (t) => {
  await assertSessionHostLoadThenCancel({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: load-then-cancel is stale before first send (symmetric)", async (t) => {
  await assertSessionHostLoadThenCancel({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function waitForCondition(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function assertSessionHostCancelDuringSessionLoad(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-cdsl-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-cdsl-session`;
  const hostSessionId = `${input.harnessId}-cdsl-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-cdsl`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: negotiate loadSession, disconnect mid-prompt, close — same fence as load-then-cancel.
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, {
        loadSession: true,
        disconnectOnPrompt: true,
      }),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const faultReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-cdsl-fault`,
    hostSessionId,
    turnId: "turn-cdsl-fault",
    text: "die mid-prompt",
  });
  assert.equal(faultReceipt.status, "accepted");
  await host.whenIdle();
  assert.ok(host.eventsSince(0).some((event) => event.kind === "session.error"));
  await host.close();

  // Round 2: reopen attach holds session/load in-flight. Host.cancelTurn cannot race here:
  // SessionHost.open awaits adapter.attach (session/load) before returning a host
  // (sessionHost.ts open/#mount→attach); adapter registers the machine only after load
  // (acpHarnessAdapter attach); cancelTurn needs an active turn + sessionId
  // (acpSessionMachine.cancelTurn). Concurrent path: abort the held load → open rejects.
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, holdOnSessionLoad: true },
        peersAfter,
      ),
    ),
  );

  const openPromise = SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  await waitForCondition(
    () => peersAfter.some((peer) => peer.holdingSessionLoad),
    "FakePeer hold mid session/load",
  );
  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen must attempt session/load before abort",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "held load must not fall back to session/new",
  );

  const held = peersAfter.find((peer) => peer.holdingSessionLoad);
  assert.ok(held, "expected a peer holding session/load");
  held.abortHeldSessionLoad();

  await assert.rejects(
    () => openPromise,
    (error: unknown) => error instanceof Error && /ACP transport closed/.test(error.message),
  );

  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "aborted load must not fall back to session/new",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/cancel")),
    "abort-held-load path must not notify session/cancel (no Host cancelTurn mid-open)",
  );

  // Prior journal remains readable; held-load abort did not corrupt history.
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "session.error"));
}

test("SessionHost + opt-in OpenCode ACP: cancel-during-session-load aborts held open clean", async (t) => {
  await assertSessionHostCancelDuringSessionLoad({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: cancel-during-session-load aborts held open clean (symmetric)", async (t) => {
  await assertSessionHostCancelDuringSessionLoad({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostLoadThenDisconnect(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-ltd-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-ltd-session`;
  const hostSessionId = `${input.harnessId}-ltd-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-ltd`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: negotiate loadSession, disconnect mid-prompt, close — same fence as load-then-cancel.
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, {
        loadSession: true,
        disconnectOnPrompt: true,
      }),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const faultReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ltd-fault`,
    hostSessionId,
    turnId: "turn-ltd-fault",
    text: "die mid-prompt",
  });
  assert.equal(faultReceipt.status, "accepted");
  await host.whenIdle();
  assert.ok(host.eventsSince(0).some((event) => event.kind === "session.error"));
  await host.close();

  // Round 2: reopen attach via session/load (must succeed — no faultOnSessionLoad).
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, { loadSession: true }, peersAfter),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen must attach via session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "successful load must not fall back to session/new",
  );

  const errorCountBefore = resumed
    .eventsSince(0)
    .filter((event) => event.kind === "session.error").length;

  // Peer disconnect before any new send: no active turn after successful load.
  // Host ignores idle peer close until the next RPC (honest fake-transport semantics).
  // peersAfter may include a capabilities-probe transport (initialize only); disconnect the live load peer.
  const livePeer = peersAfter.find((peer) => peer.methods.includes("session/load"));
  assert.ok(livePeer, "expected live peer after session/load");
  await livePeer.disconnect();

  await resumed.whenIdle();
  assert.equal(
    resumed.eventsSince(0).filter((event) => event.kind === "session.error").length,
    errorCountBefore,
    "idle peer close must not journal a new session.error until next RPC",
  );

  // Next send surfaces the transport fault cleanly (no hang).
  const probeReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ltd-probe`,
    hostSessionId,
    turnId: "turn-ltd-probe",
    text: "probe after idle disconnect",
  });
  assert.equal(probeReceipt.status, "accepted");
  await resumed.whenIdle();

  const after = resumed.eventsSince(0);
  const newErrors = after.filter((event) => event.kind === "session.error");
  assert.ok(
    newErrors.length > errorCountBefore,
    "next send after idle disconnect must journal session.error",
  );
  const latestError = newErrors[newErrors.length - 1]!;
  assert.equal(latestError.kind, "session.error");
  assert.match(latestError.message, /ACP transport closed/);
  const probeFinished = after.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-ltd-probe",
  );
  assert.ok(probeFinished && probeFinished.kind === "turn.finished");
  assert.equal(probeFinished.outcome, "unknown");

  await resumed.close();

  // Prior round-1 fault remains in journal; probe fault also persisted.
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.filter((event) => event.kind === "session.error").length >= 2,
    "journal must keep prior fault and the idle-disconnect probe fault",
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-ltd-probe" &&
        event.outcome === "unknown",
    ),
  );

  // Optional thin recovery: further reopen still attaches via session/load and can send.
  const peersRecover: FakePeer[] = [];
  const registryRecover = new HarnessRegistry();
  registryRecover.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, { loadSession: true }, peersRecover),
    ),
  );
  const recovered = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryRecover,
  });
  assert.ok(
    peersRecover.some((peer) => peer.methods.includes("session/load")),
    "recovery reopen must attach via session/load",
  );
  const recoverReceipt = await recovered.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ltd-recover`,
    hostSessionId,
    turnId: "turn-ltd-recover",
    text: "hello after load-then-disconnect",
  });
  assert.equal(recoverReceipt.status, "accepted");
  await recovered.whenIdle();
  const recoverFinished = recovered
    .eventsSince(0)
    .find((event) => event.kind === "turn.finished" && event.turnId === "turn-ltd-recover");
  assert.ok(recoverFinished && recoverFinished.kind === "turn.finished");
  assert.equal(recoverFinished.outcome, "success");
  await recovered.close();
}

test("SessionHost + opt-in OpenCode ACP: load-then-disconnect faults on next send", async (t) => {
  await assertSessionHostLoadThenDisconnect({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: load-then-disconnect faults on next send (symmetric)", async (t) => {
  await assertSessionHostLoadThenDisconnect({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostDisconnectDuringSessionLoad(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-ddsl-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-ddsl-session`;
  const hostSessionId = `${input.harnessId}-ddsl-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-ddsl`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: negotiate loadSession, disconnect mid-prompt, close — same fence as cancel-during-session-load.
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, {
        loadSession: true,
        disconnectOnPrompt: true,
      }),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const faultReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ddsl-fault`,
    hostSessionId,
    turnId: "turn-ddsl-fault",
    text: "die mid-prompt",
  });
  assert.equal(faultReceipt.status, "accepted");
  await host.whenIdle();
  assert.ok(host.eventsSince(0).some((event) => event.kind === "session.error"));
  await host.close();

  // Round 2: reopen attach holds session/load in-flight; peer idle-closes transport
  // without a JSON-RPC error reply (≠ abortHeldSessionLoad / faultOnSessionLoad).
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, holdOnSessionLoad: true },
        peersAfter,
      ),
    ),
  );

  const openPromise = SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  await waitForCondition(
    () => peersAfter.some((peer) => peer.holdingSessionLoad),
    "FakePeer hold mid session/load",
  );
  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen must attempt session/load before idle close",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "held load must not fall back to session/new",
  );

  const held = peersAfter.find((peer) => peer.holdingSessionLoad);
  assert.ok(held, "expected a peer holding session/load");
  await held.idleCloseHeldSessionLoad();

  await assert.rejects(
    () => openPromise,
    (error: unknown) => error instanceof Error && /ACP transport closed/.test(error.message),
  );

  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "idle-closed load must not fall back to session/new",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/cancel")),
    "idle-close mid-load must not notify session/cancel",
  );

  // Prior journal remains readable; idle-close mid-load did not corrupt history.
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "session.error"));
}

test("SessionHost + opt-in OpenCode ACP: disconnect-during-session-load rejects held open clean", async (t) => {
  await assertSessionHostDisconnectDuringSessionLoad({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: disconnect-during-session-load rejects held open clean (symmetric)", async (t) => {
  await assertSessionHostDisconnectDuringSessionLoad({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostPermissionDuringSessionLoad(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-pdsl-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-pdsl-session`;
  const hostSessionId = `${input.harnessId}-pdsl-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-pdsl`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: negotiate loadSession, disconnect mid-prompt, close — same fence as mid-load axis.
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, {
        loadSession: true,
        disconnectOnPrompt: true,
      }),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const faultReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-pdsl-fault`,
    hostSessionId,
    turnId: "turn-pdsl-fault",
    text: "die mid-prompt",
  });
  assert.equal(faultReceipt.status, "accepted");
  await host.whenIdle();
  assert.ok(host.eventsSince(0).some((event) => event.kind === "session.error"));
  await host.close();

  // Round 2: reopen attach holds session/load; while unanswered, peer fires tool_call +
  // session/request_permission. Host has no active turn during attach/load
  // (acpSessionMachine.#requestPermission) → rejects "stale ACP permission"; no
  // interaction.requested. FakePeer then completes load; open succeeds.
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        {
          loadSession: true,
          holdOnSessionLoad: true,
          permissionWhileHeldSessionLoad: true,
        },
        peersAfter,
      ),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen must attach via session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "permission-during-held-load must not fall back to session/new",
  );

  const livePeer = peersAfter.find((peer) => peer.methods.includes("session/load"));
  assert.ok(livePeer, "expected live peer after session/load");
  assert.equal(
    livePeer.permissionRejectedDuringHeldLoad,
    true,
    "Host must reject permission fired while session/load was unanswered",
  );
  assert.match(
    livePeer.permissionRejectMessage ?? "",
    /stale ACP permission/,
    "mid-load permission rejection must be stale ACP permission (no active turn)",
  );

  await resumed.whenIdle();
  assert.ok(
    resumed
      .eventsSince(0)
      .every(
        (event) =>
          !(
            event.kind === "interaction.requested" &&
            event.interactionId === "acp-permission:tool-perm-during-load"
          ),
      ),
    "mid-load permission must not journal interaction.requested",
  );

  // Session is live after load completed past the rejected mid-load permission.
  const sendReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-pdsl-send`,
    hostSessionId,
    turnId: "turn-pdsl-send",
    text: "hello after permission-during-load",
  });
  assert.equal(sendReceipt.status, "accepted");
  await resumed.whenIdle();
  const finished = resumed
    .eventsSince(0)
    .find((event) => event.kind === "turn.finished" && event.turnId === "turn-pdsl-send");
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "success");
  await resumed.close();
}

test("SessionHost + opt-in OpenCode ACP: permission-during-session-load rejects stale then load completes", async (t) => {
  await assertSessionHostPermissionDuringSessionLoad({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: permission-during-session-load rejects stale then load completes (symmetric)", async (t) => {
  await assertSessionHostPermissionDuringSessionLoad({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

const MID_LOAD_REPLAY_CHUNK = "mid-load replay chunk";

async function assertSessionHostLoadThenSendMidLoadPrompt(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-ltsm-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-ltsm-session`;
  const hostSessionId = `${input.harnessId}-ltsm-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-ltsm`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: negotiate loadSession, disconnect mid-prompt, close — same fence as mid-load axis.
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, {
        loadSession: true,
        disconnectOnPrompt: true,
      }),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const faultReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ltsm-fault`,
    hostSessionId,
    turnId: "turn-ltsm-fault",
    text: "die mid-prompt",
  });
  assert.equal(faultReceipt.status, "accepted");
  await host.whenIdle();
  assert.ok(host.eventsSince(0).some((event) => event.kind === "session.error"));
  await host.close();

  // Round 2: reopen attach holds session/load; while unanswered, peer emits agent_message_chunk
  // (prompt-like mid-load / #replaying). Host swallows as replay → extension.event acp.replay
  // { applied: false }; mid-load text must not become message.finished. Load completes; first send succeeds.
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        {
          loadSession: true,
          holdOnSessionLoad: true,
          promptWhileHeldSessionLoad: true,
        },
        peersAfter,
      ),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen must attach via session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "mid-load prompt path must not fall back to session/new",
  );

  const livePeer = peersAfter.find((peer) => peer.methods.includes("session/load"));
  assert.ok(livePeer, "expected live peer after session/load");
  assert.equal(
    livePeer.promptEmittedDuringHeldLoad,
    true,
    "FakePeer must emit agent_message_chunk while session/load was unanswered",
  );

  await resumed.whenIdle();
  await resumed.whenEventsSettled();

  const replayEvent = resumed
    .eventsSince(0)
    .find((event) => event.kind === "extension.event" && event.namespace === "acp.replay");
  assert.ok(
    replayEvent && replayEvent.kind === "extension.event",
    "mid-load chunks must journal extension.event namespace acp.replay",
  );
  const replayPayload = replayEvent.payload;
  assert.ok(
    replayPayload !== null && typeof replayPayload === "object" && !Array.isArray(replayPayload),
    "acp.replay payload must be an object",
  );
  const payload = replayPayload as { replayedUpdates?: unknown; applied?: unknown };
  assert.equal(
    payload.applied,
    false,
    "acp.replay must report applied:false (swallowed, not journal body)",
  );
  assert.ok(
    typeof payload.replayedUpdates === "number" && payload.replayedUpdates >= 1,
    `expected replayedUpdates >= 1, got ${String(payload.replayedUpdates)}`,
  );

  assert.ok(
    resumed
      .eventsSince(0)
      .every(
        (event) =>
          !(
            event.kind === "message.finished" &&
            typeof event.text === "string" &&
            event.text.includes(MID_LOAD_REPLAY_CHUNK)
          ),
      ),
    "mid-load replay chunk must not become message.finished",
  );

  assert.ok(
    resumed.eventsSince(0).some((event) => event.kind === "session.error"),
    "prior fault session.error must still be present after mid-load replay",
  );

  const sendReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ltsm-send`,
    hostSessionId,
    turnId: "turn-lts-send",
    text: "hello after load-then-send",
  });
  assert.equal(sendReceipt.status, "accepted");
  await resumed.whenIdle();
  const finished = resumed
    .eventsSince(0)
    .find((event) => event.kind === "turn.finished" && event.turnId === "turn-lts-send");
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "success");

  await resumed.close();

  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.every(
      (event) =>
        !(
          event.kind === "message.finished" &&
          typeof event.text === "string" &&
          event.text.includes(MID_LOAD_REPLAY_CHUNK)
        ),
    ),
    "persisted history must not contain mid-load replay as message.finished",
  );
  assert.ok(
    persisted.some((event) => event.kind === "extension.event" && event.namespace === "acp.replay"),
    "persisted history must keep acp.replay extension.event",
  );
}

test("SessionHost + opt-in OpenCode ACP: load-then-send / mid-load prompt swallows replay then send succeeds", async (t) => {
  await assertSessionHostLoadThenSendMidLoadPrompt({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: load-then-send / mid-load prompt swallows replay then send succeeds (symmetric)", async (t) => {
  await assertSessionHostLoadThenSendMidLoadPrompt({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostLoadThenPermissionDeny(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-ltpd-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-ltpd-session`;
  const hostSessionId = `${input.harnessId}-ltpd-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-ltpd`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: negotiate loadSession, disconnect mid-prompt, close — same fence as load-then-cancel
  // (generic prompt fault, not mid-permission — distinct from permission-resolve-after-reopen).
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, {
        loadSession: true,
        disconnectOnPrompt: true,
      }),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const faultReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ltpd-fault`,
    hostSessionId,
    turnId: "turn-ltpd-fault",
    text: "die mid-prompt",
  });
  assert.equal(faultReceipt.status, "accepted");
  await host.whenIdle();
  assert.ok(host.eventsSince(0).some((event) => event.kind === "session.error"));
  assert.ok(
    !host.eventsSince(0).some((event) => event.kind === "interaction.requested"),
    "round-1 fence must not leave a mid-permission interaction (≠ permission-resolve-after-reopen)",
  );
  await host.close();

  // Round 2: reopen attach via session/load succeeds; first send emits tool_call + permission.
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, awaitPermissionThenContinue: true },
        peersAfter,
      ),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen must attach via session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "successful load must not fall back to session/new",
  );

  const errorCountBefore = resumed
    .eventsSince(0)
    .filter((event) => event.kind === "session.error").length;

  const sendReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ltpd-send`,
    hostSessionId,
    turnId: "turn-ltpd-live",
    text: "deny after load-then-permission",
  });
  assert.equal(sendReceipt.status, "accepted");

  const deadline = Date.now() + 5_000;
  let interactionId: string | undefined;
  while (Date.now() < deadline) {
    const requested = resumed
      .eventsSince(0)
      .find((event) => event.kind === "interaction.requested" && event.turnId === "turn-ltpd-live");
    if (requested && requested.kind === "interaction.requested") {
      interactionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(interactionId, "expected first post-load send to request permission");

  const denyReceipt = await resumed.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-ltpd-deny`,
    hostSessionId,
    runtimeEpoch: resumed.binding.runtimeEpoch!,
    turnId: "turn-ltpd-live",
    interactionId,
    decision: "deny",
  });
  assert.equal(denyReceipt.status, "completed");
  await resumed.whenIdle();

  const after = resumed.eventsSince(0);
  assert.ok(after.some((event) => event.kind === "tool.started"));
  assert.ok(
    after.some(
      (event) =>
        event.kind === "interaction.resolved" &&
        event.turnId === "turn-ltpd-live" &&
        event.decision === "deny",
    ),
  );
  assert.ok(
    after.some(
      (event) =>
        event.kind === "message.finished" && event.text === "deny after load-then-permission",
    ),
  );
  const finished = after.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-ltpd-live",
  );
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "success");
  assert.equal(
    after.filter((event) => event.kind === "session.error").length,
    errorCountBefore,
    "Host deny after successful load must not journal a new session.error",
  );

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "session.error"));
  assert.equal(
    persisted.filter((event) => event.kind === "session.error").length,
    errorCountBefore,
    "persisted journal must keep prior fault errors only",
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "interaction.resolved" &&
        event.turnId === "turn-ltpd-live" &&
        event.decision === "deny",
    ),
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-ltpd-live" &&
        event.outcome === "success",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: load-then-permission-deny journals clean after reopen", async (t) => {
  await assertSessionHostLoadThenPermissionDeny({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: load-then-permission-deny journals clean after reopen (symmetric)", async (t) => {
  await assertSessionHostLoadThenPermissionDeny({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostLoadThenPermissionAllow(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (
    openTransport: () => AcpTransport,
  ) => ReturnType<typeof createExperimentalRegistryOpenCodeAcpHarness>;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-ltpa-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-ltpa-session`;
  const hostSessionId = `${input.harnessId}-ltpa-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-ltpa`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: negotiate loadSession, disconnect mid-prompt, close — same fence as load-then-permission-deny
  // (generic prompt fault, not mid-permission — distinct from allow-after-reopen).
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, {
        loadSession: true,
        disconnectOnPrompt: true,
      }),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const faultReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ltpa-fault`,
    hostSessionId,
    turnId: "turn-ltpa-fault",
    text: "die mid-prompt",
  });
  assert.equal(faultReceipt.status, "accepted");
  await host.whenIdle();
  assert.ok(host.eventsSince(0).some((event) => event.kind === "session.error"));
  assert.ok(
    !host.eventsSince(0).some((event) => event.kind === "interaction.requested"),
    "round-1 fence must not leave a mid-permission interaction (≠ allow-after-reopen)",
  );
  await host.close();

  // Round 2: reopen attach via session/load succeeds; first send emits tool_call + permission.
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, awaitPermissionThenContinue: true },
        peersAfter,
      ),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen must attach via session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "successful load must not fall back to session/new",
  );

  const errorCountBefore = resumed
    .eventsSince(0)
    .filter((event) => event.kind === "session.error").length;

  const sendReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-ltpa-send`,
    hostSessionId,
    turnId: "turn-ltpa-live",
    text: "allow after load-then-permission",
  });
  assert.equal(sendReceipt.status, "accepted");

  const deadline = Date.now() + 5_000;
  let interactionId: string | undefined;
  while (Date.now() < deadline) {
    const requested = resumed
      .eventsSince(0)
      .find((event) => event.kind === "interaction.requested" && event.turnId === "turn-ltpa-live");
    if (requested && requested.kind === "interaction.requested") {
      interactionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(interactionId, "expected first post-load send to request permission");

  const allowReceipt = await resumed.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-ltpa-allow`,
    hostSessionId,
    runtimeEpoch: resumed.binding.runtimeEpoch!,
    turnId: "turn-ltpa-live",
    interactionId,
    decision: "allow",
  });
  assert.equal(allowReceipt.status, "completed");
  await resumed.whenIdle();

  const after = resumed.eventsSince(0);
  assert.ok(after.some((event) => event.kind === "tool.started"));
  assert.ok(
    after.some(
      (event) =>
        event.kind === "interaction.resolved" &&
        event.turnId === "turn-ltpa-live" &&
        event.decision === "allow",
    ),
  );
  assert.ok(
    after.some(
      (event) =>
        event.kind === "message.finished" && event.text === "allow after load-then-permission",
    ),
  );
  const finished = after.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-ltpa-live",
  );
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "success");
  assert.equal(
    after.filter((event) => event.kind === "session.error").length,
    errorCountBefore,
    "Host allow after successful load must not journal a new session.error",
  );

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "session.error"));
  assert.equal(
    persisted.filter((event) => event.kind === "session.error").length,
    errorCountBefore,
    "persisted journal must keep prior fault errors only",
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "interaction.resolved" &&
        event.turnId === "turn-ltpa-live" &&
        event.decision === "allow",
    ),
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-ltpa-live" &&
        event.outcome === "success",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: load-then-permission-allow journals clean after reopen", async (t) => {
  await assertSessionHostLoadThenPermissionAllow({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: load-then-permission-allow journals clean after reopen (symmetric)", async (t) => {
  await assertSessionHostLoadThenPermissionAllow({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) => createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});
