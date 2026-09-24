// Actual pinned SDK/CLI -> local fake Messages endpoint. Adapter lease is a mock, not Gateway certification.
import { ClaudeHarnessAdapter } from "../../src/agent-adapters/claude-code/claudeHarnessAdapter.ts";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
if (process.env.ZCODE_CLAUDE_PROBE !== "1") throw new Error("explicit isolated probe required");
const root = await mkdtemp(join(tmpdir(), "claude-adapter-native-"));
const cwd = join(root, "workspace"),
  profileRoot = join(root, "profiles");
await mkdir(cwd);
await mkdir(profileRoot);
const marker = join(cwd, "marker");
await writeFile(marker, "original\n");
let requests = 0;
const issued = [],
  revoked = [],
  seen = [];
const server = createServer(async (req, res) => {
  if (req.method === "HEAD") {
    res.writeHead(200).end();
    return;
  }
  if (!req.url?.startsWith("/v1/messages")) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 200000) {
      res.writeHead(413).end();
      return;
    }
  }
  const token = String(req.headers["x-api-key"] ?? "");
  seen.push({ token, model: JSON.parse(body).model });
  requests++;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  event("message_start", {
    type: "message_start",
    message: {
      id: `msg_fixture_${requests}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 0 },
    },
  });
  if (requests === 1) {
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_fixture_001", name: "Edit", input: {} },
    });
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({
          file_path: marker,
          old_string: "original",
          new_string: "modified",
        }),
      },
    });
  } else {
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ok" },
    });
  }
  event("content_block_stop", { type: "content_block_stop", index: 0 });
  event("message_delta", {
    type: "message_delta",
    delta: { stop_reason: requests === 1 ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 3 },
  });
  event("message_stop", { type: "message_stop" });
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const selection = { providerId: "fixture", modelId: "m1", options: { reasoningLevel: "off" } };
const spec = {
  schemaVersion: 2,
  hostSessionId: "native-probe",
  projectId: "p",
  workspaceId: "w",
  execution: {
    targetId: "t",
    workspaceIdentity: "repo",
    worktreePath: cwd,
    worktreeGeneration: "g",
    cwdRelativeToWorktree: ".",
  },
  harness: { id: "claude-code", adapterVersion: "2.1.263" },
  modelBinding: { kind: "host-managed", selection },
};
const plan = {
  schemaVersion: 1,
  hostSessionId: spec.hostSessionId,
  targetId: "t",
  harnessId: "claude-code",
  adapterVersion: "2.1.263",
  catalogFingerprint: "fixture",
  requested: spec.modelBinding,
  effective: selection,
  route: "messages-gateway",
  support: { support: "supported" },
  capabilities: {},
};
const adapter = new ClaudeHarnessAdapter({
  root: profileRoot,
  verifyCwd: async () => cwd,
  nativeModel: () => "claude-sonnet-4-6",
  gateway: {
    url: `http://127.0.0.1:${server.address().port}`,
    issueToken: async (binding) => {
      issued.push(binding.turnId);
      return `fixture-${binding.turnId}-${randomUUID()}`;
    },
    revokeToken: (token) => revoked.push(token),
  },
});
const events = [];
try {
  const binding = await adapter.create(spec, plan);
  adapter.subscribe(spec.hostSessionId, (event) => {
    events.push({ kind: event.kind, turnId: event.turnId });
    if (event.kind === "interaction.requested") {
      void adapter.resolveInteraction({
        type: "resolveInteraction",
        hostSessionId: spec.hostSessionId,
        commandId: randomUUID(),
        runtimeEpoch: binding.runtimeEpoch,
        turnId: event.turnId,
        interactionId: event.interactionId,
        decision: "deny",
      });
    }
  });
  for (const turnId of ["one", "two"]) {
    await adapter.prepareTurn(spec, { turnId, runtimeEpoch: binding.runtimeEpoch, plan });
    await adapter.send({
      type: "send",
      hostSessionId: spec.hostSessionId,
      turnId,
      commandId: randomUUID(),
      text: turnId === "one" ? "Edit marker from original to modified" : "Reply ok",
    });
  }
  console.log(
    JSON.stringify({
      marker: await readFile(marker, "utf8"),
      requests,
      issued,
      revokedCount: revoked.length,
      distinctTokens: new Set(seen.map((r) => r.token)).size === 2,
      modelMatches: seen.every((r) => r.model === "claude-sonnet-4-6"),
      events,
    }),
  );
} catch (error) {
  console.log(JSON.stringify({ error: String(error).slice(0, 180), requests, events }));
  process.exitCode = 1;
} finally {
  await adapter.shutdown();
  server.close();
  await rm(root, { recursive: true, force: true });
}
