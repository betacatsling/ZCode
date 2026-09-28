import assert from "node:assert/strict";
import test from "node:test";
import {
  HostMessageTypes,
  HostResponseTypes,
  type WorkspaceAdmissionActivityRequest,
  zcodeTaskMetaSchema,
  zcodeWorkspaceRefSchema,
} from "@zcode/shared";
import { TaskRealtimeBus } from "./taskRealtimeBus.js";

class FakeUtilityProcess {
  readonly sent: unknown[] = [];
  #message?: (message: unknown) => void;

  on(event: string, listener: (message: unknown) => void): void {
    if (event === "message") this.#message = listener;
  }
  once(_event: string, _listener: () => void): void {}
  off(event: string): void {
    if (event === "message") this.#message = undefined;
  }
  postMessage(message: unknown): void {
    this.sent.push(message);
  }
  emit(message: unknown): void {
    this.#message?.(message);
  }
}

function take<T extends { type: string }>(
  messages: readonly unknown[],
  type: string,
): T | undefined {
  return messages.find(
    (message): message is T =>
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      (message as { type?: unknown }).type === type,
  );
}

test("native workspace refs preserve trailing whitespace in filesystem paths and fallback keys", () => {
  const workspacePath = "/tmp/project with a trailing space \n";
  const workspace = zcodeWorkspaceRefSchema.parse({
    workspacePath,
    workspaceKey: workspacePath,
  });
  assert.equal(workspace.workspacePath, workspacePath);
  assert.equal(workspace.workspaceKey, workspacePath);
  const taskMeta = zcodeTaskMetaSchema.parse({
    taskId: "native-session",
    traceId: "native-session",
    title: "task",
    workspacePath,
    createdAt: 1,
    updatedAt: 1,
    mode: "build",
  });
  assert.equal(taskMeta.workspacePath, workspacePath);
});

test("workspace activity query routes to the registered session owner and returns its fact", () => {
  const bus = new TaskRealtimeBus();
  const requester = new FakeUtilityProcess();
  const owner = new FakeUtilityProcess();
  const workspacePath = "/remote/project with spaces\n";
  const workspaceIdentity = "remote:ssh:host-a:/remote/project with spaces";
  const workspaceKey = workspaceIdentity.trim() || workspacePath;
  bus.registerHost({
    hostId: "requester",
    windowId: 1,
    child: requester as never,
    workspaceKeys: [workspaceKey],
  });
  bus.registerHost({
    hostId: "owner",
    windowId: 2,
    child: owner as never,
    workspaceKeys: [],
  });
  owner.emit({
    type: HostResponseTypes.SessionRouteAnnounce,
    route: { sessionId: "native-session", workspacePath, workspaceIdentity },
  });
  const request: WorkspaceAdmissionActivityRequest = {
    requestId: "query-1",
    workspaceId: "workspace-1",
    workspacePath,
    workspaceIdentity,
    workspaceKey,
    worktreeGeneration: "generation-1",
  };
  requester.emit({
    type: HostResponseTypes.WorkspaceAdmissionActivityRequest,
    request,
  });
  const routed = take<{
    type: string;
    request: { requestId: string; worktreeGeneration: string };
  }>(owner.sent, HostMessageTypes.WorkspaceAdmissionActivityQuery);
  const local = take<{
    type: string;
    request: { requestId: string; worktreeGeneration: string };
  }>(requester.sent, HostMessageTypes.WorkspaceAdmissionActivityQuery);
  assert.ok(routed);
  assert.ok(local);
  assert.equal(routed.request.worktreeGeneration, "generation-1");
  owner.emit({
    type: HostResponseTypes.WorkspaceAdmissionActivityResult,
    result: {
      requestId: routed.request.requestId,
      fact: {
        complete: true,
        ownerPresent: true,
        state: "busy",
        activeSessionCount: 1,
        activeTurnCount: 1,
        pendingCommandCount: 0,
        pendingInputCount: 1,
        pendingApprovalCount: 1,
      },
    },
  });
  requester.emit({
    type: HostResponseTypes.WorkspaceAdmissionActivityResult,
    result: {
      requestId: local.request.requestId,
      fact: {
        complete: false,
        ownerPresent: false,
        state: "unknown",
        activeSessionCount: 0,
        activeTurnCount: 0,
        pendingCommandCount: 0,
        pendingInputCount: 0,
        pendingApprovalCount: 0,
      },
    },
  });
  const aggregate = take<{
    type: string;
    result: {
      requestId: string;
      fact: { complete: boolean; state: string; pendingInputCount: number };
    };
  }>(requester.sent, HostMessageTypes.WorkspaceAdmissionActivityQueryResult);
  assert.equal(aggregate?.result.requestId, "query-1");
  assert.deepEqual(aggregate?.result.fact, {
    complete: true,
    ownerPresent: true,
    state: "busy",
    activeSessionCount: 1,
    activeTurnCount: 1,
    pendingCommandCount: 0,
    pendingInputCount: 1,
    pendingApprovalCount: 1,
  });
});

test("workspace activity query with no provable owner returns unknown", () => {
  const bus = new TaskRealtimeBus();
  const requester = new FakeUtilityProcess();
  bus.registerHost({
    hostId: "requester",
    windowId: 1,
    child: requester as never,
    workspaceKeys: [],
  });
  requester.emit({
    type: HostResponseTypes.WorkspaceAdmissionActivityRequest,
    request: {
      requestId: "query-empty",
      workspaceId: "workspace-1",
      workspacePath: "/missing-owner",
      workspaceKey: "/missing-owner",
      worktreeGeneration: "generation-1",
    },
  });
  const query = take<{
    type: string;
    request: { requestId: string; startIfMissing?: boolean };
  }>(requester.sent, HostMessageTypes.WorkspaceAdmissionActivityQuery);
  assert.equal(query?.request.startIfMissing, true);
  requester.emit({
    type: HostResponseTypes.WorkspaceAdmissionActivityResult,
    result: {
      requestId: query!.request.requestId,
      fact: {
        complete: false,
        ownerPresent: false,
        state: "unknown",
        activeSessionCount: 0,
        activeTurnCount: 0,
        pendingCommandCount: 0,
        pendingInputCount: 0,
        pendingApprovalCount: 0,
      },
    },
  });
  const result = take<{
    type: string;
    result: { requestId: string; fact: { complete: boolean; state: string } };
  }>(requester.sent, HostMessageTypes.WorkspaceAdmissionActivityQueryResult);
  assert.deepEqual(result?.result, {
    requestId: "query-empty",
    fact: {
      complete: false,
      ownerPresent: false,
      state: "unknown",
      activeSessionCount: 0,
      activeTurnCount: 0,
      pendingCommandCount: 0,
      pendingInputCount: 0,
      pendingApprovalCount: 0,
    },
  });
});
