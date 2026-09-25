import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IAgentHostService,
  IWorkspaceHierarchyService,
  ISettingService,
  ServiceCollection,
} from "@zcode/services";
import type { IServerChannel } from "@zcode/rpc";
import { Emitter } from "@zcode/rpc";
import type { SessionSpecV2 } from "@zcode/shared/agent-host";
import { createPairedPhoneAgentHost, registerPairedPhoneChannel } from "./pairedPhoneAgentHost.js";

const scope = {
  workspaceId: "a",
  hostSessionId: "session-a",
  workspacePath: "/a",
  workspaceIdentity: "local:a",
};
const spec = {
  schemaVersion: 2,
  hostSessionId: "session-a",
  projectId: "project-a",
  workspaceId: "a",
  execution: {
    targetId: "local",
    workspaceIdentity: "local:a",
    worktreePath: "/a",
    worktreeGeneration: "1",
    cwdRelativeToWorktree: ".",
  },
  harness: { id: "pi", adapterVersion: "1" },
  modelBinding: { kind: "harness-managed" },
} as const satisfies SessionSpecV2;
const foreign = {
  ...spec,
  hostSessionId: "session-b",
  workspaceId: "b",
  execution: { ...spec.execution, workspaceIdentity: "local:b" },
} satisfies SessionSpecV2;

test("phone port denies foreign IDs, forged specs, and stale generations before dispatch", async () => {
  let effects = 0;
  let current = true;
  const owner = {
    getAvailability: async () => ({
      target: { id: "local", available: true },
      harnesses: ["pi"],
      admissionEnabled: true,
    }),
    getSessionSpec: async ({
      workspaceId,
      hostSessionId,
    }: {
      workspaceId: string;
      hostSessionId: string;
    }) => (workspaceId === "a" && hostSessionId === "session-a" ? spec : undefined),
    dispatch: async () => {
      effects++;
      return { status: "accepted" };
    },
  } as unknown as IAgentHostService;
  const hierarchy = {
    resolveWorkspace: async () => ({
      workspaceId: "a",
      workspaceIdentity: "local:a",
      workspacePath: "/a",
      targetId: "local",
    }),
  } as unknown as IWorkspaceHierarchyService;
  const phone = createPairedPhoneAgentHost(owner, hierarchy, scope, () => current);
  await assert.rejects(phone.dispatch(foreign, { type: "sendText" } as never), /denied/);
  await assert.rejects(
    phone.dispatch({ ...spec, harness: { id: "other", adapterVersion: "1" } }, {
      type: "sendText",
    } as never),
    /denied/,
  );
  await assert.rejects(
    phone.getSessionSpec({ targetId: "local", workspaceId: "b", hostSessionId: "session-b" }),
    /denied/,
  );
  assert.equal(effects, 0);
  current = false;
  await assert.rejects(phone.dispatch(spec, { type: "sendText" } as never), /denied/);
  assert.equal(effects, 0);
});

test("subscription hides unverified, foreign and revoked producer events", async () => {
  const emitter = new Emitter<{ spec: SessionSpecV2; event: never }>();
  let current = true;
  const owner = {
    getAvailability: async () => ({ target: { id: "local", available: true } }),
    getSessionSpec: async () => spec,
    onEvent: emitter.event,
  } as unknown as IAgentHostService;
  const hierarchy = {
    resolveWorkspace: async () => ({
      workspaceId: "a",
      workspaceIdentity: "local:a",
      workspacePath: "/a",
      targetId: "local",
    }),
  } as unknown as IWorkspaceHierarchyService;
  const phone = createPairedPhoneAgentHost(owner, hierarchy, scope, () => current);
  let seen = 0;
  const listener = phone.onEvent(() => {
    seen++;
  });
  emitter.fire({ spec, event: {} as never });
  emitter.fire({ spec: foreign, event: {} as never });
  assert.equal(seen, 0);
  await phone.getSessionSpec({ targetId: "local", workspaceId: "a", hostSessionId: "session-a" });
  emitter.fire({ spec: foreign, event: {} as never });
  emitter.fire({ spec, event: {} as never });
  assert.equal(seen, 1);
  current = false;
  emitter.fire({ spec, event: {} as never });
  assert.equal(seen, 1);
  listener.dispose();
  emitter.dispose();
});

test("Host registration exposes no window-wide or privileged channels", async () => {
  let effects = 0;
  const channels = new Map<string, IServerChannel>();
  const owner = {
    getAvailability: async () => ({ target: { id: "local", available: true } }),
    getSessionSpec: async () => spec,
    dispatch: async () => {
      effects++;
    },
  } as unknown as IAgentHostService;
  const hierarchy = {
    resolveWorkspace: async () => ({
      workspaceId: "a",
      workspaceIdentity: "local:a",
      workspacePath: "/a",
      targetId: "local",
    }),
  } as unknown as IWorkspaceHierarchyService;
  const services = new ServiceCollection()
    .register(IAgentHostService, owner)
    .register(IWorkspaceHierarchyService, hierarchy)
    .register(ISettingService, {} as never);
  registerPairedPhoneChannel(
    {
      registerChannel: (name, channel) => {
        channels.set(name, channel);
      },
    },
    services,
    scope,
    () => true,
  );
  assert.deepEqual([...channels.keys()], [IAgentHostService.channelName]);
  const channel = channels.get(IAgentHostService.channelName)!;
  await assert.rejects(
    channel.call(null as never, "dispatch", [foreign, { type: "sendText" }]),
    /denied/,
  );
  assert.throws(() => channel.call(null as never, "create", [spec, "new"]), /denied/);
  assert.throws(() => channel.call(null as never, "constructor", []), /denied/);
  assert.throws(() => channel.listen(null as never, "onDynamicProcessResourceSample"), /denied/);
  assert.equal(effects, 0);
});

test("phone target lookup rotated while awaiting: no business effect", async () => {
  let current = true;
  let effects = 0;
  const owner = {
    getAvailability: async () => ({ target: { id: "local", available: true } }),
    getSessionSpec: async () => spec,
    dispatch: async () => {
      effects++;
    },
  } as unknown as IAgentHostService;
  const hierarchy = {
    resolveWorkspace: async () => {
      current = false;
      return {
        workspaceId: "a",
        workspaceIdentity: "local:a",
        workspacePath: "/a",
        targetId: "local",
      };
    },
  } as unknown as IWorkspaceHierarchyService;
  const phone = createPairedPhoneAgentHost(owner, hierarchy, scope, () => current);
  await assert.rejects(phone.dispatch(spec, { type: "sendText" } as never), /denied/);
  assert.equal(effects, 0);
});
