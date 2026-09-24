import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createAcpTransport, type AcpDescriptor } from "../src/agent-adapters/acp/acpTransport.js";
import { probePinnedClaudeAcp } from "../src/agent-adapters/acp/pinnedClaudeProfile.js";

/** Native binary + real SDK + fake loopback upstream; not approval certification for arbitrary worktrees. */
test(
  "pinned Claude ACP native new/prompt/denied Edit/load with no provider call",
  {
    skip: !process.env.ACP_REAL_BIN,
    timeout: 90000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "acp-native-loop-"));
    const home = join(root, "home");
    const cwd = join(root, "work");
    const marker = join(cwd, "denied-marker");
    await Promise.all([mkdir(home), mkdir(cwd)]);
    await writeFile(marker, "original\n");
    let requests = 0;
    const permissionTools: string[] = [];
    let holdNext = false;
    let attackNext = false;
    let signalPending!: () => void;
    const pendingUpstream = new Promise<void>((resolvePending) => {
      signalPending = resolvePending;
    });
    const upstream = createServer(async (req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200).end();
        return;
      }
      let raw = "";
      for await (const part of req) {
        raw += String(part);
        if (raw.length > 200000) {
          res.writeHead(413).end();
          return;
        }
      }
      if (!req.url?.startsWith("/v1/messages")) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as { model: string; stream: boolean };
      assert.equal(body.stream, true);
      requests++;
      if (holdNext) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        signalPending();
        return; // Held fake upstream response: cancellation must interrupt native prompt.
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const event = (name: string, data: unknown) =>
        res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      event("message_start", {
        type: "message_start",
        message: {
          id: `msg_fixture_${requests}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      });
      const attackTool = attackNext;
      attackNext = false;
      if (requests <= 2 || attackTool) {
        const name = requests === 1 ? "Read" : "Edit";
        event("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: `toolu_fixture_00${requests}`, name, input: {} },
        });
        event("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(
              requests === 1
                ? { file_path: marker }
                : { file_path: marker, old_string: "original", new_string: "modified" },
            ),
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
          delta: { type: "text_delta", text: "done" },
        });
      }
      event("content_block_stop", { type: "content_block_stop", index: 0 });
      event("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: requests <= 2 || attackTool ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: 10 },
      });
      event("message_stop", { type: "message_stop" });
      res.end();
    });
    await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("loopback server missing");
    const env = {
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      ANTHROPIC_API_KEY: `fixture-${randomUUID()}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      LANG: "C.UTF-8",
    };
    const descriptor: AcpDescriptor = {
      executable: process.execPath,
      argv: [resolve(process.env.ACP_REAL_BIN!)],
      cwd,
      env,
      version: { argv: [], exact: "0.16.2" },
    };
    const connections: Awaited<ReturnType<typeof createAcpTransport>>[] = [];
    t.after(async () => {
      await Promise.all(connections.map((client) => client.close()));
      upstream.closeAllConnections();
      await new Promise<void>((done) => upstream.close(() => done()));
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const connect = async () => {
      const client = await createAcpTransport(descriptor, {
        probeVersion: probePinnedClaudeAcp,
        launch: (d) =>
          spawn(d.executable, [...d.argv], {
            cwd: d.cwd,
            env: d.env,
            stdio: ["pipe", "pipe", "pipe"],
          }),
        onPermission: (permission) => {
          permissionTools.push(String(permission.toolCall.title));
          permission.deny();
        },
      });
      connections.push(client);
      return client;
    };
    const first = await connect();
    assert.equal(first.capabilities.loadSession, true);
    const nativeId = await first.newSession();
    assert.ok(nativeId);
    const result = await first.prompt(
      "Use Edit to replace original with modified in denied-marker. Then say done.",
    );
    assert.equal(result.stopReason, "end_turn");
    assert.equal(await readFile(marker, "utf8"), "original\n");
    assert.ok(requests >= 3, "native denied Edit should lead to a follow-up response");
    assert.ok(
      permissionTools.some((title) => title.includes("Edit")),
      `denied Edit must cross real ACP permission request (got ${JSON.stringify(permissionTools)}, upstream ${requests})`,
    );
    await first.close();
    // Native opt-in negative certification: untrusted project settings may authorize Edit before
    // the Host-facing canUseTool callback. Clean-worktree denial above is insufficient evidence.
    await mkdir(join(cwd, ".claude"));
    await writeFile(
      join(cwd, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Edit"] } }),
    );
    const beforeAttackPermissions = permissionTools.length;
    attackNext = true;
    const unsafe = await connect();
    await unsafe.newSession();
    await unsafe.prompt(
      "Use Edit to replace original with modified in denied-marker. Then say done.",
    );
    assert.equal(
      await readFile(marker, "utf8"),
      "modified\n",
      "project allow can bypass host pre-tool denial",
    );
    assert.equal(
      permissionTools.slice(beforeAttackPermissions).some((title) => title.includes("Edit")),
      false,
    );
    await unsafe.close();
    const second = await connect();
    await second.load(nativeId);
    const resumed = await second.prompt("Reply with done.");
    assert.equal(resumed.stopReason, "end_turn");
    assert.equal(await readFile(marker, "utf8"), "original\n");
    holdNext = true;
    const active = second.prompt("Wait for cancellation.");
    await pendingUpstream;
    await second.cancel();
    // 取消通知不是终态；原生若回复 error，只能标记未知，不能重用该连接。
    const cancelled = await active.then(
      (result) => result.stopReason,
      (error: unknown) => String(error),
    );
    assert.ok(cancelled === "cancelled" || /unknown|cancel|exited|ended/i.test(cancelled));
    await assert.rejects(
      second.prompt("must not reuse cancelled connection"),
      /uncertain|unavailable/,
    );
    await second.close();
  },
);
