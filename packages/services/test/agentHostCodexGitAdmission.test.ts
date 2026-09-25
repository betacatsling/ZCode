import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectCatalog } from "../src/project-workspaces/projectCatalog.js";
import {
  CatalogWorkspaceAdmission,
  ProjectCatalogTargetBridge,
} from "../src/project-workspaces/targetBridge.js";
import { TargetWorktreeService } from "../src/project-workspaces/worktreeService.js";
import { AgentHostTargetService } from "../src/agent-host/targetService.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { CodexHarnessAdapter } from "../src/agent-adapters/codex/codexHarnessAdapter.js";
import { codexTrustedManifest } from "../src/agent-adapters/codex/codexAdapterContract.js";
import type { SessionSpecV2 } from "@zcode/shared/agent-host";
import { AiSdkModelAdapter, type CreateAiSdkModelOptions } from "@zcode/adapters";
import { createCodexGatewayLeaseIssuer } from "../src/agent-adapters/codex/createCodexGatewayLeaseIssuer.js";
import { createModelGateway } from "../src/model-gateway/gateway.js";
import { responsesProtocol } from "../src/model-gateway/ingress/responses.js";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  await exec("git", ["-C", cwd, ...args]);
}

function modelOptions(baseUrl: string): CreateAiSdkModelOptions {
  return {
    providerId: "synthetic",
    modelId: "first",
    providerConfig: {
      access: { type: "api-key", apiKey: "fake-local-key" },
      api: { type: "openai-responses", baseUrl },
    } as CreateAiSdkModelOptions["providerConfig"],
    modelConfig: {
      properties: {
        requiresMfjsToolSchema: false,
        contextWindow: 8192,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: true,
      },
      optionSpecs: {
        reasoningLevel: { values: ["off"], map: "{}" },
        maxOutputTokens: { max: 2048, map: '{"max_output_tokens": maxOutputTokens}' },
      },
    } as CreateAiSdkModelOptions["modelConfig"],
    options: { reasoningLevel: "off", maxOutputTokens: 2048 },
  };
}
const frame = (type: string, fields: object) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;

test("real Git/catalog/Target Host Codex V2 rejects foreign scope then pinned CLI executes subdir via fake upstream", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-real-git-host-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  let target: TargetWorktreeService | undefined;
  let host: AgentHostTargetService | undefined;
  let leaseCount = 0;
  let upstreamCount = 0;
  const nativeCwds: string[] = [];
  let adapter: CodexHarnessAdapter | undefined;
  let gateway: ReturnType<typeof createModelGateway> | undefined;
  const upstream = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/responses");
      assert.equal(request.headers.authorization, "Bearer fake-local-key");
      let raw = "";
      for await (const chunk of request) {
        raw += String(chunk);
        assert.ok(raw.length < 256_000);
      }
      const body = JSON.parse(raw) as { model: string };
      assert.equal(body.model, "first");
      const id = `resp-${++upstreamCount}`;
      const item = {
        id: `msg-${upstreamCount}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Real Git subdir complete." }],
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        frame("response.created", { response: { id, model: body.model, created_at: 1760000000 } }) +
          frame("response.output_item.added", {
            output_index: 0,
            item: { type: "message", id: item.id },
          }) +
          frame("response.output_text.delta", {
            output_index: 0,
            item_id: item.id,
            content_index: 0,
            delta: "Real Git subdir complete.",
          }) +
          frame("response.output_item.done", { output_index: 0, item }) +
          frame("response.completed", {
            response: { id, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
          }) +
          "data: [DONE]\n\n",
      );
    } catch {
      response.writeHead(500).end();
    }
  });
  try {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    const model = new AiSdkModelAdapter({ retry: { maxAttempts: 1 } }).createModel(
      modelOptions(`http://127.0.0.1:${address.port}/v1`),
    );
    gateway = createModelGateway({
      protocols: [responsesProtocol],
      resolveModel: () => model,
      limits: { maxBodyBytes: 256_000, maxConcurrentRequests: 1 },
    });
    const { url } = await gateway.start();
    const issuer = createCodexGatewayLeaseIssuer({ gateway, gatewayUrl: `${url}/v1` });
    adapter = new CodexHarnessAdapter({
      root: join(root, "profiles"),
      spawnProcess: ((command, args, options) => {
        if (args[0] !== "--version") nativeCwds.push(options.cwd ?? "");
        return spawn(command, args, options);
      }) as typeof spawn,
      lease: {
        ...issuer,
        issue: async (input) => {
          leaseCount++;
          return issuer.issue(input);
        },
      },
    });
    await git(repo, "init", "-q");
    await git(
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "base",
    );
    const sub = join(repo, "sub");
    await mkdir(sub);
    await symlink(root, join(repo, "escape"));
    target = await TargetWorktreeService.open({
      storageDirectory: join(root, "target"),
      executionTargetId: "local",
      activity: async () => ({ running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false }),
    });
    const catalog = await ProjectCatalog.open(
      join(root, "catalog.json"),
      new ProjectCatalogTargetBridge(target, "local", (_id, cwd) => cwd),
      { allSessions: async () => [], workspaceFreshness: async () => "live" as const },
    );
    await catalog.importProject({
      id: "p",
      bindingId: "b",
      name: "Project",
      targetId: "local",
      repositoryPath: repo,
    });
    const workspace = await catalog.adopt({
      bindingId: "b",
      workspaceId: "w",
      title: "Main",
      worktreePath: repo,
    });
    const gate = new CatalogWorkspaceAdmission(catalog, target, "local");
    const registry = new HarnessRegistry();
    registry.registerTrusted(codexTrustedManifest, () => adapter!);
    host = new AgentHostTargetService({
      root: join(root, "host"),
      target: {
        id: "local",
        kind: "local",
        platform: process.platform as "darwin" | "linux",
        available: true,
      },
      catalog: { fingerprint: "fixture", validateSelection: () => ({ ok: true as const }) },
      registry,
      admission: {
        verify: (candidate) => gate.verify(candidate),
        withAdmission: (candidate, action) =>
          gate.withAdmission(candidate, (canonicalCwd) => action({ canonicalCwd })),
      },
    });
    const spec: SessionSpecV2 = {
      schemaVersion: 2,
      projectId: "p",
      workspaceId: "w",
      hostSessionId: "codex",
      execution: {
        targetId: "local",
        workspaceIdentity: workspace.workspaceIdentity,
        worktreePath: workspace.worktreePath,
        worktreeGeneration: workspace.worktreeGeneration,
        cwdRelativeToWorktree: "sub",
      },
      harness: { id: "codex", adapterVersion: "0.156.1" },
      modelBinding: {
        kind: "host-managed",
        selection: {
          providerId: "synthetic",
          modelId: "first",
          options: { reasoningLevel: "off" },
        },
      },
    };
    for (const [name, candidate] of [
      ["target", { ...spec, execution: { ...spec.execution, targetId: "foreign" } }],
      ["identity", { ...spec, execution: { ...spec.execution, workspaceIdentity: "foreign" } }],
      ["workspace", { ...spec, workspaceId: "foreign" }],
      ["generation", { ...spec, execution: { ...spec.execution, worktreeGeneration: "foreign" } }],
      ["path", { ...spec, execution: { ...spec.execution, worktreePath: root } }],
      ["escape", { ...spec, execution: { ...spec.execution, cwdRelativeToWorktree: "escape" } }],
    ] as const) {
      await assert.rejects(host.create(candidate, `reject-${name}`));
    }
    assert.equal(leaseCount, 0);
    assert.equal((await gate.verify(spec)).canonicalCwd, await realpath(sub));
    await host.create(spec, "create-valid");
    const stale = await host.dispatch(spec, {
      type: "cancelTurn",
      commandId: "stale-epoch",
      hostSessionId: spec.hostSessionId,
      runtimeEpoch: "foreign",
      turnId: "foreign",
    });
    assert.equal(stale.status, "rejected");
    assert.equal(leaseCount, 0);
    const receipt = await host.dispatch(spec, {
      type: "send",
      commandId: "send-valid",
      hostSessionId: spec.hostSessionId,
      turnId: "turn-valid",
      text: "Reply with the synthetic subdir answer",
    });
    assert.equal(receipt.status, "accepted");
    const result = await host.waitForIdle(spec);
    assert.equal((await host.queryCommand(spec, "send-valid"))?.status, "completed");
    assert.ok(
      result.rows.window.some(
        (row) => row.kind === "assistantText" && row.text === "Real Git subdir complete.",
      ),
    );
    assert.deepEqual(nativeCwds, [await realpath(sub)]);
    assert.equal(leaseCount, 1);
    assert.equal(upstreamCount, 1);
  } finally {
    await host?.close();
    await adapter?.shutdown();
    await target?.close();
    await gateway?.close();
    upstream.closeAllConnections();
    if (upstream.listening) await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
