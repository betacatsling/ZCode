import assert from "node:assert/strict";
import { test } from "node:test";
import { IAgentHostService, type IProjectCatalogService } from "@zcode/services";
import {
  AgentHostTargetService,
  ProjectCatalog,
  TargetWorktreeService,
  createModelGateway,
  responsesProtocol,
  anthropicMessagesProtocol,
  ClaudeCodeTransport,
  CodexTransport,
  AcpTransport,
} from "@zcode/services/node";
import { writableSessionSpecV2Schema } from "@zcode/shared/agent-host";
import { sidebarSnapshotSchema } from "@zcode/shared/project-workspaces";

void (undefined as IProjectCatalogService | undefined);

test("public assembly entrypoints retain host, catalog, gateway and transport boundaries", () => {
  assert.ok(IAgentHostService);
  for (const value of [
    AgentHostTargetService,
    ProjectCatalog,
    TargetWorktreeService,
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
});
