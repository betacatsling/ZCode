import type {
  WorkspaceSessionBindingCapabilityResult,
  WorkspaceSessionCreateRequest,
  WorkspaceSessionCreateResult,
} from "./workspace-session.js";
import type { StaticHarnessAsset } from "./directory.js";

/** Public service shape for a deliberate workspace-scoped owner, including an empty native one. */
export const explicitWorkspaceSessionExample = {
  request: {
    requestId: "create-agent-01J8MZQ4X9R6W2F0K3P7D5N1AB",
    workspaceId: "workspace-42",
    worktreeGeneration: "generation-7",
    harnessId: "pi",
    modelBinding: {
      kind: "host-managed",
      selection: { providerId: "provider-demo", modelId: "model-demo" },
    },
    title: "Review the storage adapter",
  },
  result: {
    locator: {
      ownerKind: "agent-host",
      sessionId: "host-01J8MZQ4X9R6W2F0K3P7D5N1AB",
      targetId: "target-local",
      workspaceId: "workspace-42",
      worktreeGeneration: "generation-7",
      workspacePath: "/repo",
      harnessId: "pi",
      title: "Review the storage adapter",
      modelBinding: {
        kind: "host-managed",
        selection: { providerId: "provider-demo", modelId: "model-demo" },
      },
    },
    reused: false,
  },
} satisfies {
  request: WorkspaceSessionCreateRequest;
  result: WorkspaceSessionCreateResult;
};

export const explicitNativeSessionBindingExample: WorkspaceSessionCreateRequest = {
  requestId: "create-agent-native-01J8MZQ4X9R6W2F0K3P7D5N1AB",
  workspaceId: "workspace-42",
  worktreeGeneration: "generation-7",
  harnessId: "zcode",
  modelBinding: {
    kind: "native-selection",
    selection: { providerId: "provider-demo", modelId: "model-demo" },
  },
};

export const piWorkspaceSessionCapabilityExample: WorkspaceSessionBindingCapabilityResult = {
  targetId: "target-local",
  report: {
    support: "supported",
  },
};

export const piStaticHarnessAssetExample: StaticHarnessAsset = {
  assetId: "pi-light",
  mediaType: "image/svg+xml",
  content:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect x="0" y="0" width="2" height="2" fill="#e48a7a"/></svg>',
};
