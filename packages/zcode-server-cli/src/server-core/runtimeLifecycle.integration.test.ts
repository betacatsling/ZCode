import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Emitter, ChannelClient, SocketProtocol, VSBuffer } from "@zcode/rpc";
import type { IChannel, ISocket } from "@zcode/rpc";
import { IAgentHostService } from "@zcode/services";
import type { AgentCommand, AgentEvent, SessionSpec } from "@zcode/shared/agent-host";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { ZCODE_RPC_HOST_CAPABILITY_HEADER } from "@zcode/shared";
import { WebSocket } from "ws";
import { createMockAgentHostRuntime } from "@zcode/services/agent-host/mock-runtime-test";
import { Supervisor } from "../supervisor/supervisor.js";
import { requestControl } from "../ipc/controlClient.js";
import { resolveServerLayout } from "../runtime/paths.js";
import type { UpdatePreparationResult } from "../contracts.js";

interface AgentHostRpc {
  call<T>(method: string, ...args: unknown[]): Promise<T>;
  dispose(): void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  read: () => Promise<T> | T,
  accept: (value: T) => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function connectAgentHost(
  host: string,
  port: number,
  route = "/ws/host",
): Promise<AgentHostRpc> {
  const headers: Record<string, string> = {};
  if (route === "/ws/host") {
    const capabilityResponse = await fetch(`http://${host}:${port}/api/rpc-host-capability`, {
      method: "POST",
    });
    assert.equal(capabilityResponse.status, 200);
    const capability = (await capabilityResponse.json()) as { capability: string };
    headers[ZCODE_RPC_HOST_CAPABILITY_HEADER] = capability.capability;
  }
  const ws = new WebSocket(`ws://${host}:${port}${route}`, { headers });
  const data = new Emitter<VSBuffer>();
  const closed = new Emitter<void>();
  ws.on("message", (raw) =>
    data.fire(VSBuffer.wrap(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer))),
  );
  ws.on("close", () => closed.fire());
  ws.on("error", () => closed.fire());
  const socket: ISocket = {
    onData: data.event,
    onClose: closed.event,
    onEnd: closed.event,
    write(buffer) {
      if (ws.readyState === WebSocket.OPEN) ws.send(buffer.buffer);
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
      data.dispose();
      closed.dispose();
    },
  };
  const protocol = new SocketProtocol(socket);
  const client = new ChannelClient(protocol);
  const channel = client.getChannel<IChannel>(IAgentHostService.channelName);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return {
    call: (method, ...args) => channel.call(method, args),
    dispose() {
      client.dispose();
      protocol.dispose();
      socket.dispose();
    },
  };
}

function spec(targetId: string, worktreePath: string, hostSessionId: string): SessionSpec {
  return {
    schemaVersion: 1,
    hostSessionId,
    execution: { targetId, workspaceIdentity: "workspace-integration", worktreePath },
    harness: { id: "mock", adapterVersion: "1.0.0" },
    modelBinding: {
      kind: "host-managed",
      selection: { providerId: "provider-test", modelId: "model-test" },
    },
  };
}

function sendCommand(hostSessionId: string, commandId: string, turnId: string): AgentCommand {
  return {
    type: "send",
    hostSessionId,
    commandId,
    turnId,
    text: "mock integration prompt",
  };
}

test("forked Supervisor/Core keep Host work alive across client detach and fence crash recovery", async () => {
  // macOS 的 os.tmpdir() 位于 /var -> /private/var 符号链接下；mock 授权按 realpath 比较，
  // 因此先 realpath。该长路径同时覆盖 control.sock 超过 sun_path 时的短目录回退。
  const temp = await realpath(await mkdtemp(join(tmpdir(), "zcode-runtime-host-process-")));
  const serverRoot = join(temp, "server");
  const worktreePath = join(temp, "worktree");
  const configPath = join(temp, "provider-config.json");
  const agentHostRoot = join(serverRoot, "agent-host", "sessions");
  await mkdir(worktreePath, { recursive: true });
  await writeFile(configPath, "{}\n");
  const layout = resolveServerLayout(serverRoot);
  const coreEntry = fileURLToPath(new URL("./fixtures/mockCoreEntry.ts", import.meta.url));
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ZCODE_DATA_BASE_DIR: join(temp, "zcode-data"),
    ZCODE_SERVER_ROOT: "",
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: configPath,
    ZCODE_TEST_AGENT_HOST_ROOT: agentHostRoot,
    ZCODE_TEST_WORKTREE: worktreePath,
    ZCODE_TEST_TARGET_ID: "target-integration",
  };
  const supervisor = new Supervisor({
    layout,
    version: "runtime-integration-test",
    coreReadyTimeoutMs: 15_000,
    coreStopGraceTimeoutMs: 5_000,
    coreKillTimeoutMs: 2_000,
    launcher: {
      launch(generation) {
        return fork(coreEntry, [String(generation)], {
          cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
          env: childEnv,
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
      },
    },
  });
  let rpc: AgentHostRpc | undefined;
  try {
    await supervisor.start();
    const ready = await waitFor(
      () => supervisor.status(),
      (status) => status.state === "ready",
      "Core ready",
    );
    const rootLockProbePath = fileURLToPath(
      new URL("./fixtures/rootLockProbe.ts", import.meta.url),
    );
    const competingOwner = fork(rootLockProbePath, [serverRoot], {
      cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const lockResult = await new Promise<{ status: string; message?: string }>(
      (resolve, reject) => {
        competingOwner.once("message", resolve);
        competingOwner.once("error", reject);
        competingOwner.once("exit", (code) => {
          if (code !== 0) reject(new Error(`root lock probe exited with ${code}`));
        });
      },
    );
    assert.equal(
      lockResult.status,
      "blocked",
      "a second OS process cannot acquire the Supervisor data-root lock",
    );

    const untrustedRpc = await connectAgentHost(ready.host!, ready.port!, "/ws");
    await assert.rejects(untrustedRpc.call("getAvailability"), /Unknown channel|timed out/);
    untrustedRpc.dispose();

    const targetId = "target-integration";
    const firstSpec = spec(targetId, worktreePath, "detach-session");
    rpc = await connectAgentHost(ready.host!, ready.port!);
    const created = await rpc.call<ConversationSnapshot>("create", firstSpec);
    assert.equal(created.agentHost?.harnessId, "mock");
    const send = sendCommand(firstSpec.hostSessionId, "send-detach", "turn-detach");
    assert.equal(
      (await rpc.call<{ status: string }>("dispatch", firstSpec, send)).status,
      "accepted",
    );

    // Close the only RPC client while the Mock Harness is still advancing its delayed turn.
    rpc.dispose();
    rpc = undefined;
    await waitFor(
      () => supervisor.status(),
      (status) => status.state === "ready" && status.runningTaskCount === 1,
      "detached task activity",
    );
    const detachedStatus = supervisor.status();
    assert.equal(detachedStatus.state, "ready", "client detach leaves Server Core running");

    rpc = await connectAgentHost(detachedStatus.host!, detachedStatus.port!);
    const approvalSnapshot = await waitFor(
      () => rpc!.call<ConversationSnapshot>("snapshot", firstSpec),
      (snapshot) => snapshot.pendingInteractions.length === 1,
      "pending approval after reconnect",
    );
    const approvalId = approvalSnapshot.pendingInteractions[0]!.interactionId;
    assert.equal(approvalId, "approval-1");
    const competingHost = createMockAgentHostRuntime({
      root: agentHostRoot,
      targetId,
      worktreePath,
    });
    try {
      await assert.rejects(competingHost.service.attach(firstSpec), /live owner/);
    } finally {
      await competingHost.dispose();
    }
    assert.equal(
      (await rpc.call<{ status: string }>("queryCommand", firstSpec, "send-detach"))?.status,
      "accepted",
    );

    const updateGate = (await requestControl(layout.controlEndpoint, {
      command: "prepare-update",
    })) as UpdatePreparationResult;
    const uninstallGate = (await requestControl(layout.controlEndpoint, {
      command: "prepare-uninstall",
    })) as UpdatePreparationResult;
    assert.deepEqual(updateGate, { status: "blocked", runningTaskCount: 1 });
    assert.deepEqual(uninstallGate, { status: "blocked", runningTaskCount: 1 });
    await assert.rejects(
      requestControl(layout.controlEndpoint, {
        command: "confirm-uninstall",
        confirmation: "DELETE",
      }),
      /Cannot uninstall while 1 task/,
    );
    assert.equal(supervisor.status().state, "ready");

    const duplicate = await rpc.call<{ status: string }>("dispatch", firstSpec, send);
    assert.equal(duplicate.status, "duplicate");
    const reconnectAgain = await rpc.call<ConversationSnapshot>("snapshot", firstSpec);
    assert.equal(reconnectAgain.pendingInteractions[0]?.interactionId, approvalId);
    await rpc.call("dispatch", firstSpec, {
      type: "resolveInteraction",
      commandId: "approve-detach",
      hostSessionId: firstSpec.hostSessionId,
      runtimeEpoch: reconnectAgain.logEpoch,
      turnId: "turn-detach",
      interactionId: approvalId,
      decision: "allow",
    });
    await waitFor(
      () => rpc!.call<{ status: string }>("queryCommand", firstSpec, "send-detach"),
      (receipt) => receipt?.status === "completed",
      "approval resolution and turn completion",
    );
    const completed = await rpc.call<ConversationSnapshot>("snapshot", firstSpec);
    assert.equal(completed.pendingInteractions.length, 0);
    assert.ok(completed.rows.window.some((row) => row.kind === "toolCall"));
    const firstEvents = await rpc.call<AgentEvent[]>("eventsSince", firstSpec, 0);
    assert.equal(firstEvents.filter((event) => event.kind === "tool.finished").length, 1);
    assert.equal(
      (await rpc.call<{ status: string }>("queryCommand", firstSpec, "send-detach"))?.status,
      "completed",
    );
    await waitFor(
      () => supervisor.status(),
      (status) => status.runningTaskCount === 0,
      "idle Supervisor gate after terminal event",
    );

    const uncertainSpec = spec(targetId, worktreePath, "crash-session");
    await rpc.call<ConversationSnapshot>("create", uncertainSpec);
    const uncertainSend = sendCommand(uncertainSpec.hostSessionId, "send-crash", "turn-crash");
    assert.equal(
      (await rpc.call<{ status: string }>("dispatch", uncertainSpec, uncertainSend)).status,
      "accepted",
    );
    const uncertainSnapshot = await waitFor(
      () => rpc!.call<ConversationSnapshot>("snapshot", uncertainSpec),
      (snapshot) => snapshot.pendingInteractions.length === 1,
      "second pending approval before Core crash",
    );
    const crashApprovalId = uncertainSnapshot.pendingInteractions[0]!.interactionId;
    const oldGeneration = supervisor.status().generation;
    const corePid = supervisor.status().pid;
    assert.ok(corePid);
    process.kill(corePid, "SIGKILL");

    const restartedReady = await waitFor(
      () => supervisor.status(),
      (status) => status.state === "ready" && status.generation > oldGeneration,
      "Supervisor restart after Core crash",
      25_000,
    );
    const restarted = await waitFor(
      () => supervisor.status(),
      (status) => status.generation === restartedReady.generation && status.runningTaskCount === 1,
      "recovered activity snapshot from the new Core",
    );
    assert.equal(
      restarted.runningTaskCount,
      1,
      "the Supervisor's current Core generation reports recovered activity",
    );
    rpc.dispose();
    rpc = await connectAgentHost(restarted.host!, restarted.port!);
    const recovered = await rpc.call<ConversationSnapshot>("snapshot", uncertainSpec);
    assert.equal(recovered.pendingInteractions[0]?.interactionId, crashApprovalId);
    assert.equal(
      (await rpc.call<{ status: string }>("queryCommand", uncertainSpec, "send-crash"))?.status,
      "execution-unknown",
    );
    await assert.rejects(rpc.call("dispatch", uncertainSpec, uncertainSend), /not attached/);
    const recoveredEvents = await rpc.call<AgentEvent[]>("eventsSince", uncertainSpec, 0);
    assert.equal(recoveredEvents.filter((event) => event.kind === "tool.finished").length, 0);
    const recoveredUpdateGate = (await requestControl(layout.controlEndpoint, {
      command: "prepare-update",
    })) as UpdatePreparationResult;
    assert.deepEqual(recoveredUpdateGate, { status: "blocked", runningTaskCount: 1 });

    rpc.dispose();
    rpc = undefined;
    await supervisor.stop();
    assert.equal(
      supervisor.status().state,
      "stopped",
      "explicit server stop is separate from RPC detach",
    );
  } finally {
    rpc?.dispose();
    await supervisor.stop().catch(() => undefined);
    await rm(temp, { recursive: true, force: true });
  }
});
