import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IAgentHostService,
  IProjectCatalogRpcService,
  IProjectCatalogTargetRpcService,
  type IProjectCatalogService,
} from "@zcode/services";
import {
  AgentHostTargetService,
  ProjectCatalog,
  TargetWorktreeService,
  ProjectCatalogTargetBridge,
  CatalogWorkspaceAdmission,
  NativePersistentSessionIndex,
  NativeSessionDirectory,
  NativeSessionStoreMetadataReader,
  createTrustedAcpFactory,
  probeTrustedAcpProfile,
  captureHostModel,
  createModelGateway,
  responsesProtocol,
  anthropicMessagesProtocol,
  ClaudeCodeTransport,
  CodexTransport,
  AcpTransport,
  resolveHarnessAsset,
} from "@zcode/services/node";
import { writableSessionSpecV2Schema } from "@zcode/shared/agent-host";
import { sidebarSnapshotSchema } from "@zcode/shared/project-workspaces";

void (undefined as IProjectCatalogService | undefined);

test("public assembly entrypoints retain host, catalog, gateway, asset and transport boundaries", async () => {
  assert.ok(IAgentHostService);
  assert.ok(IProjectCatalogRpcService);
  assert.ok(IProjectCatalogTargetRpcService);
  for (const value of [
    AgentHostTargetService,
    ProjectCatalog,
    TargetWorktreeService,
    ProjectCatalogTargetBridge,
    CatalogWorkspaceAdmission,
    NativePersistentSessionIndex,
    NativeSessionDirectory,
    NativeSessionStoreMetadataReader,
    createTrustedAcpFactory,
    probeTrustedAcpProfile,
    captureHostModel,
    createModelGateway,
    ClaudeCodeTransport,
    CodexTransport,
    AcpTransport,
  ])
    assert.equal(typeof value, "function");
  assert.equal(responsesProtocol.id, "responses");
  assert.equal(anthropicMessagesProtocol.id, "anthropic-messages");
  assert.ok(writableSessionSpecV2Schema);
  assert.ok(sidebarSnapshotSchema);
  assert.equal((await resolveHarnessAsset("builtin:zcode"))?.kind, "trusted-png");
  assert.equal(await resolveHarnessAsset("../untrusted"), undefined);
});
