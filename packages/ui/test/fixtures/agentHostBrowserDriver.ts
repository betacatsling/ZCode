import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentCommand,
  type ExecutionTarget,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import { createAgentHostConversationBridge } from "../../../services/src/agent-host/conversationBridge.js";
import { HarnessRegistry } from "../../../services/src/agent-host/harnessRegistry.js";
import { AgentHostTargetService } from "../../../services/src/agent-host/targetService.js";
import type { HarnessAdapter } from "../../../services/src/agent-host/harnessRegistry.js";
import { AgentHostConversationFixtureHarness } from "../../../services/test/fixtures/agentHostConversationHarness.js";

const port = Number(process.env.AGENT_HOST_DRIVER_PORT ?? 43171);
const hostRoot = await mkdtemp(join(tmpdir(), "zcode-agent-host-browser-driver-"));
const workspacePath = join(hostRoot, "worktree");
await mkdir(workspacePath, { recursive: true });
const targetIdentity = {
  id: "fixture-target",
  kind: "local" as const,
  platform: process.platform as ExecutionTarget["platform"],
  available: true,
};
const fixtureHarness = new AgentHostConversationFixtureHarness();
const piHarness: HarnessAdapter = {
  id: "pi",
  version: "0.87.1",
  hostManagedRoute: "mock",
  probe: (target) => fixtureHarness.probe(target),
  capabilities: (target) => fixtureHarness.capabilities(target),
  hostManagedSupport: (target, selection) => fixtureHarness.hostManagedSupport(target, selection),
  harnessManagedSupport: (target, model) => fixtureHarness.harnessManagedSupport(target, model),
  create: async (spec, plan) => {
    const binding = {
      ...(await fixtureHarness.create(spec, plan)),
      backendVersion: "0.87.1",
    };
    return binding;
  },
  attach: (spec, binding) => fixtureHarness.attach(spec, binding),
  send: (command) => fixtureHarness.send(command),
  cancelTurn: (command) => fixtureHarness.cancelTurn(command),
  resolveInteraction: (command) => fixtureHarness.resolveInteraction(command),
  terminate: (hostSessionId) => fixtureHarness.terminate(hostSessionId),
  subscribe: (hostSessionId, listener) => fixtureHarness.subscribe(hostSessionId, listener),
};
const harnesses = new HarnessRegistry();
harnesses.register(piHarness);
const target = new AgentHostTargetService({
  root: join(hostRoot, "host"),
  target: targetIdentity,
  catalog: { fingerprint: "browser-fixture-v1", validateSelection: () => ({ ok: true as const }) },
  registry: harnesses,
  authorizeWorktree: async () => true,
});
const bridge = createAgentHostConversationBridge(target);
const sessionSpecs: SessionSpec[] = ["pi-review", "pi-idle"].map((hostSessionId) => ({
  schemaVersion: 1,
  hostSessionId,
  execution: {
    targetId: targetIdentity.id,
    workspaceIdentity: workspacePath,
    worktreePath: workspacePath,
  },
  harness: { id: "pi", adapterVersion: "0.87.1" },
  modelBinding: { kind: "harness-managed" },
}));
for (const spec of sessionSpecs) await bridge.createExternalSession({ spec });
const sessionSpecById = new Map(sessionSpecs.map((spec) => [spec.hostSessionId, spec]));
fixtureHarness.seedHistory("pi-review", 60);
await target.snapshot(sessionSpecById.get("pi-review")!);

interface RecordedCall {
  method: string;
  sessionId?: string;
  commandType?: string;
  commandId?: string;
  turnId?: string;
  runtimeEpoch?: string;
  interactionId?: string;
  decision?: string;
  text?: string;
  beforeRowId?: number;
  limit?: number;
  rowIds?: number[];
  hasMore?: boolean;
}
const calls: RecordedCall[] = [];
let failNextSubscribe = true;

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (request.method === "GET" && url.pathname === "/__agent-host/health") {
    json(response, 200, {
      ready: true,
      targetId: targetIdentity.id,
      workspacePath,
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/__agent-host/counters") {
    try {
      const snapshots: Record<string, Awaited<ReturnType<typeof target.snapshot>>> = {};
      for (const spec of sessionSpecs) {
        snapshots[spec.hostSessionId] = await target.snapshot(spec);
      }
      json(response, 200, {
        calls,
        failNextSubscribe,
        snapshots,
      });
    } catch (error) {
      process.stderr.write(
        `BROWSER_DRIVER_COUNTERS_FAILED ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/__agent-host/test/fail-next-subscribe") {
    failNextSubscribe = true;
    json(response, 200, { accepted: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__agent-host/test/hold-after-approval") {
    try {
      const body = (await readBody(request)) as { sessionId?: string };
      if (!body.sessionId || !sessionSpecById.has(body.sessionId)) {
        json(response, 400, { error: "unknown-session" });
        return;
      }
      fixtureHarness.holdNextAfterApproval(body.sessionId);
      json(response, 200, { accepted: true });
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/__agent-host/test/stale-approval") {
    try {
      const body = (await readBody(request)) as {
        sessionId?: string;
        mismatch?: "epoch" | "turn";
      };
      const spec = sessionSpecById.get(body.sessionId ?? "");
      if (!spec || (body.mismatch !== "epoch" && body.mismatch !== "turn")) {
        json(response, 400, { error: "invalid-stale-approval-probe" });
        return;
      }
      const before = await target.snapshot(spec);
      const turnId = before.control.activeWorks[0]?.foregroundExecutionId;
      const interaction = before.pendingInteractions[0];
      if (!turnId || !interaction) throw new Error("approval-is-not-pending");
      const command: AgentCommand = {
        type: "resolveInteraction",
        commandId: `browser-stale-${body.mismatch}-${spec.hostSessionId}`,
        hostSessionId: spec.hostSessionId,
        runtimeEpoch: body.mismatch === "epoch" ? "stale-runtime-epoch" : before.logEpoch,
        turnId: body.mismatch === "turn" ? "stale-turn" : turnId,
        interactionId: interaction.interactionId,
        decision: "allow",
      };
      calls.push({
        method: "test.staleApproval",
        sessionId: spec.hostSessionId,
        commandType: command.type,
        commandId: command.commandId,
        turnId: command.turnId,
        runtimeEpoch: command.runtimeEpoch,
        interactionId: command.interactionId,
        decision: command.decision,
      });
      const receipt = await target.dispatch(spec, command);
      const after = await target.snapshot(spec);
      json(response, 200, {
        receipt,
        before: {
          seq: before.seq,
          logEpoch: before.logEpoch,
          turnId,
          interactionId: interaction.interactionId,
        },
        after: {
          seq: after.seq,
          logEpoch: after.logEpoch,
          turnId: after.control.activeWorks[0]?.foregroundExecutionId,
          interactionIds: after.pendingInteractions.map((item) => item.interactionId),
        },
      });
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/__agent-host/frames") {
    response.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
    });
    response.write(": connected\n\n");
    const subscription = bridge.onFrame((frame) => {
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
    });
    request.on("close", () => subscription.dispose());
    return;
  }
  if (request.method !== "POST" || !url.pathname.startsWith("/__agent-host/rpc/")) {
    json(response, 404, { error: "not-found" });
    return;
  }

  const method = url.pathname.slice("/__agent-host/rpc/".length);
  try {
    const body = (await readBody(request)) as Record<string, unknown>;
    const spec = body.spec as SessionSpec | undefined;
    const serviceRequest = body.request as { sessionId?: string; spec?: SessionSpec } | undefined;
    const sessionId =
      spec?.hostSessionId ?? serviceRequest?.spec?.hostSessionId ?? serviceRequest?.sessionId;
    const command = body.command as AgentCommand | undefined;
    const call: RecordedCall = {
      method,
      ...(sessionId ? { sessionId } : {}),
      ...(command
        ? {
            commandType: command.type,
            commandId: command.commandId,
            ...("turnId" in command ? { turnId: command.turnId } : {}),
            ...("runtimeEpoch" in command ? { runtimeEpoch: command.runtimeEpoch } : {}),
            ...("interactionId" in command ? { interactionId: command.interactionId } : {}),
            ...("decision" in command ? { decision: command.decision } : {}),
            ...("text" in command ? { text: command.text } : {}),
          }
        : {}),
      ...(body.request && typeof body.request === "object" && "beforeRowId" in body.request
        ? { beforeRowId: Number((body.request as { beforeRowId: number }).beforeRowId) }
        : {}),
      ...(body.request && typeof body.request === "object" && "limit" in body.request
        ? { limit: Number((body.request as { limit: number }).limit) }
        : {}),
    };
    calls.push(call);
    switch (method) {
      case "getAvailability":
        json(response, 200, {
          target: targetIdentity,
          harnesses: ["pi"],
          admissionEnabled: true,
        });
        return;
      case "snapshot":
        if (!spec) throw new Error("missing-spec");
        json(response, 200, await target.snapshot(spec));
        return;
      case "dispatch":
        if (!spec || !body.command) throw new Error("missing-command");
        json(response, 200, await target.dispatch(spec, body.command as AgentCommand));
        return;
      case "queryCommand":
        if (!spec || typeof body.commandId !== "string") throw new Error("missing-command-id");
        json(response, 200, await target.queryCommand(spec, body.commandId));
        return;
      case "subscribeConversation":
        if (!body.request) throw new Error("missing-request");
        if (failNextSubscribe) {
          failNextSubscribe = false;
          json(response, 503, { error: "fixture-subscribe-failure" });
          return;
        }
        json(response, 200, await bridge.subscribeConversation(body.request as never));
        return;
      case "resyncConversation":
        if (!body.request) throw new Error("missing-request");
        json(response, 200, await bridge.resyncConversation(body.request as never));
        return;
      case "unsubscribeConversation":
        if (!body.request) throw new Error("missing-request");
        await bridge.unsubscribeConversation(body.request as never);
        json(response, 200, { ok: true });
        return;
      case "conversationRowsRange":
        if (!body.request) throw new Error("missing-request");
        {
          const result = await bridge.conversationRowsRange(body.request as never);
          call.rowIds = result.rows.map((row) => row.rowId);
          call.hasMore = result.hasMore;
          json(response, 200, result);
        }
        return;
      default:
        json(response, 404, { error: `unsupported-method:${method}` });
    }
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
process.stdout.write(`AGENT_HOST_BROWSER_DRIVER_READY ${port}\n`);

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  bridge.dispose();
  await target.close().catch(() => undefined);
  await rm(hostRoot, { recursive: true, force: true });
}
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
