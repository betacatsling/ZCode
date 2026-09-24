import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createCodexTransport } from "../src/agent-adapters/codex/codexTransport.js";

class FakeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  kill() {
    this.exitCode = 0;
    this.emit("exit", 0);
    return true;
  }
}

function fixture() {
  const child = new FakeProcess();
  const root = join(tmpdir(), `zcode-codex-fake-${randomUUID()}`);
  const cleanup = () => rm(root, { recursive: true, force: true });
  const sent: Record<string, unknown>[] = [];
  let buffer = "";
  child.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      sent.push(JSON.parse(buffer.slice(0, end)) as Record<string, unknown>);
      buffer = buffer.slice(end + 1);
    }
  });
  const receive = (value: unknown) => child.stdout.write(`${JSON.stringify(value)}\n`);
  const next = async (index: number) => {
    for (let i = 0; i < 100 && sent.length <= index; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.ok(sent[index]);
    return sent[index];
  };
  const open = async (onEvent: (event: any) => void = () => {}) => {
    await mkdir(root);
    const creating = createCodexTransport({
      cwd: root,
      sessionHome: join(root, "private"),
      gatewayUrl: "http://127.0.0.1:4567/v1",
      gatewayToken: "secret",
      model: "fixture",
      onEvent,
      spawnProcess: (_command, args) => {
        if (args[0] === "--version") {
          const version = new FakeProcess();
          queueMicrotask(() => {
            version.stdout.end("codex-cli 0.156.1\n");
            version.emit("exit", 0);
          });
          return version as any;
        }
        assert.ok(args.includes('web_search="disabled"'));
        assert.ok(args.includes("features.multi_agent=false"));
        return child as any;
      },
    });
    const init = await next(0);
    assert.equal(init.method, "initialize");
    receive({ id: init.id, result: {} });
    const initialized = await next(1);
    assert.equal(initialized.method, "initialized");
    return creating;
  };
  return { child, sent, receive, next, open, cleanup };
}

test("correlates interleaved sessions and rejects stale approval after interrupt", async () => {
  const f = fixture();
  const events: any[] = [];
  const transport = await f.open((event) => events.push(event));
  try {
    const a = transport.startThread();
    const b = transport.startThread();
    const first = await f.next(2);
    const second = await f.next(3);
    f.receive({
      id: second.id,
      result: { thread: { id: "b" }, model: "fixture", modelProvider: "zcode" },
    });
    f.receive({
      id: first.id,
      result: { thread: { id: "a" }, model: "fixture", modelProvider: "zcode" },
    });
    assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
    const ta = transport.startTurn("a", "hello");
    const tb = transport.startTurn("b", "hi");
    const ra = await f.next(4);
    const rb = await f.next(5);
    f.receive({ id: rb.id, result: { turn: { id: "tb" } } });
    f.receive({ id: ra.id, result: { turn: { id: "ta" } } });
    assert.deepEqual(await Promise.all([ta, tb]), ["ta", "tb"]);
    f.receive({
      id: 91,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "a", turnId: "ta", itemId: "i", approvalId: "native-a" },
    });
    f.receive({
      id: 92,
      method: "item/fileChange/requestApproval",
      params: { threadId: "b", turnId: "tb", itemId: "j" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.length, 2);
    assert.equal(events[0].approvalId, "native-a");
    await transport.replyApproval(events[1].callbackId, "decline");
    assert.deepEqual(await f.next(6), { id: 92, result: { decision: "decline" } });
    const interrupted = transport.interruptTurn("a", "ta");
    assert.deepEqual(await f.next(7), { id: 91, result: { decision: "decline" } });
    const interrupt = await f.next(8);
    assert.equal(interrupt.method, "turn/interrupt");
    f.receive({ id: interrupt.id, result: {} });
    await interrupted;
    await assert.rejects(transport.replyApproval(events[0].callbackId, "accept"), /stale|unknown/);
    await assert.rejects(transport.replyApproval(events[1].callbackId, "accept"), /stale|unknown/);
  } finally {
    await transport.close();
    await f.cleanup();
  }
});

test("rejects a mismatched native model binding and concurrent turns", async () => {
  const f = fixture();
  const transport = await f.open();
  try {
    const mismatch = transport.startThread();
    f.receive({
      id: (await f.next(2)).id,
      result: { thread: { id: "bad" }, model: "other", modelProvider: "zcode" },
    });
    await assert.rejects(mismatch, /binding mismatch/);
    const started = transport.startThread();
    f.receive({
      id: (await f.next(3)).id,
      result: { thread: { id: "good" }, model: "fixture", modelProvider: "zcode" },
    });
    const id = await started;
    const turn = transport.startTurn(id, "one");
    await f.next(4);
    await assert.rejects(transport.startTurn(id, "two"), /already active/);
    f.receive({ id: f.sent[4].id, result: { turn: { id: "t" } } });
    await turn;
    f.receive({
      method: "turn/completed",
      params: { threadId: id, turn: { id: "t", status: "completed" } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const nextTurn = transport.startTurn(id, "two");
    f.receive({ id: (await f.next(5)).id, result: { turn: { id: "t2" } } });
    assert.equal(await nextTurn, "t2");
  } finally {
    await transport.close();
    await f.cleanup();
  }
});

test("many individually valid native approvals cannot exceed pending approval byte budget", async () => {
  const f = fixture();
  const transport = await f.open();
  try {
    const thread = transport.startThread();
    f.receive({
      id: (await f.next(2)).id,
      result: { thread: { id: "a" }, model: "fixture", modelProvider: "zcode" },
    });
    await thread;
    const turn = transport.startTurn("a", "prompt");
    f.receive({ id: (await f.next(3)).id, result: { turn: { id: "t" } } });
    await turn;
    const pending = transport.startThread();
    await f.next(4);
    for (let i = 0; i < 2; i++)
      f.receive({
        id: i + 91,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "a", turnId: "t", itemId: `${i}${"x".repeat(600_000)}` },
      });
    await assert.rejects(pending, /approval.*limit/);
    await assert.rejects(transport.startThread());
  } finally {
    await transport.close();
    await f.cleanup();
  }
});

test("aggregate stdout bytes reject a single oversized multi-line chunk before dispatch", async () => {
  const f = fixture();
  let delivered = 0;
  const transport = await f.open(() => delivered++);
  try {
    const pending = transport.startThread();
    await f.next(2);
    const line = `${JSON.stringify({ method: "thread/name/updated", params: { payload: "x".repeat(2000) } })}\n`;
    f.child.stdout.write(line.repeat(600));
    await assert.rejects(pending, /frame too large/);
    assert.equal(delivered, 0);
  } finally {
    await transport.close();
    await f.cleanup();
  }
});

test("rejects malformed and oversized frames; exit clears pending calls", async () => {
  for (const frame of ["{bad}\n", `${"x".repeat(1024 * 1024 + 1)}\n`]) {
    const f = fixture();
    const transport = await f.open();
    const pending = transport.startThread();
    await f.next(2);
    f.child.stdout.write(frame);
    await assert.rejects(pending);
    await assert.rejects(transport.startThread());
    await transport.close();
    await f.cleanup();
  }
  const f = fixture();
  const transport = await f.open();
  const pending = transport.startThread();
  await f.next(2);
  f.child.emit("exit", 1);
  await assert.rejects(pending);
  await assert.rejects(transport.startThread());
  await transport.close();
  await f.cleanup();
});

test(
  "isolated Codex 0.156.1 accepts a synthetic Responses turn",
  { skip: process.env.ZCODE_CODEX_TRANSPORT_SMOKE !== "1", timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-codex-transport-"));
    const cwd = join(root, "cwd");
    await mkdir(cwd);
    const gateway = createServer(async (request, response) => {
      if (request.url !== "/v1/responses" || request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 128000) {
          response.writeHead(413).end();
          return;
        }
      }
      const parsed = JSON.parse(body);
      assert.equal(parsed.model, "fixture-model");
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, value: object) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
      send("response.created", { response: { id: "resp-fixture" } });
      send("response.output_item.done", {
        item: {
          type: "message",
          role: "assistant",
          id: "message-fixture",
          content: [{ type: "output_text", text: "Hello." }],
        },
      });
      send("response.completed", {
        response: {
          id: "resp-fixture",
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        },
      });
      response.end();
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    let transport: Awaited<ReturnType<typeof createCodexTransport>> | undefined;
    try {
      const address = gateway.address();
      assert.ok(address && typeof address !== "string");
      let finish!: (status: string) => void;
      const completed = new Promise<string>((resolve) => {
        finish = resolve;
      });
      transport = await createCodexTransport({
        cwd,
        sessionHome: join(root, "profile"),
        gatewayUrl: `http://127.0.0.1:${address.port}/v1`,
        gatewayToken: "synthetic-only",
        model: "fixture-model",
        onEvent: (event) => {
          if (event.kind === "notification" && event.method === "turn/completed")
            finish((event.params as { turn: { status: string } }).turn.status);
        },
      });
      const threadId = await transport.startThread();
      await transport.startTurn(threadId, "Say hello");
      assert.equal(await completed, "completed");
    } finally {
      await transport?.close();
      gateway.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("pinned synthetic fixture preserves developer messages and optional-tool differences", async () => {
  const fixturePath = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "codexCompatibility0.156.1.fixture.json",
  );
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
    cliVersion: string;
    cases: Array<{
      name: string;
      request: {
        body: {
          input: Array<{ role: string; content: Array<{ text?: string }> }>;
          instructions?: string;
          tools: Array<{ name?: string; type: string }>;
        };
      };
    }>;
  };
  assert.equal(fixture.cliVersion, "codex-cli 0.156.1");
  const get = (name: string) => fixture.cases.find((trial) => trial.name === name)!.request.body;
  assert.equal(
    get("default").tools.some((tool) => tool.name === "multi_agent_v1"),
    true,
  );
  assert.equal(
    get("default").tools.some((tool) => tool.type === "web_search"),
    true,
  );
  assert.equal(
    get("optional-tools-disabled").tools.some((tool) =>
      ["multi_agent_v1", "web_search"].includes(tool.name ?? tool.type),
    ),
    false,
  );
  assert.equal("instructions" in get("empty-instruction-overrides"), false);
  assert.equal(get("custom-base").instructions, "Synthetic base marker. Do not execute tools.");
  const developer = (name: string) =>
    get(name)
      .input.filter((message) => message.role === "developer")
      .flatMap((message) => message.content.map((content) => content.text ?? ""));
  assert.equal(
    developer("custom-developer").some((text) => text.includes("Synthetic developer marker")),
    true,
  );
  for (const trial of fixture.cases) {
    assert.equal(
      developer(trial.name).some((text) => text.startsWith("<permissions instructions>")),
      true,
    );
    assert.equal(
      developer(trial.name).some((text) => text.startsWith("<skills_instructions>")),
      true,
    );
    assert.equal(trial.request.body.input.length > 0 && trial.request.body.tools.length > 0, true);
  }
});

test("unknown CLI versions never launch app-server or expose token in argv", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-codex-version-"));
  const starts: string[][] = [];
  try {
    await assert.rejects(
      createCodexTransport({
        cwd: root,
        sessionHome: join(root, "private"),
        gatewayUrl: "http://127.0.0.1:7654/v1",
        gatewayToken: "fake-secret",
        model: "fixture",
        onEvent: () => {},
        spawnProcess: (_command, args) => {
          starts.push(args as string[]);
          const child = new FakeProcess();
          queueMicrotask(() => {
            child.stdout.end("codex-cli 0.156.2\n");
            child.emit("exit", 0);
          });
          return child as any;
        },
      }),
      /Unsupported Codex CLI version/,
    );
    assert.equal(starts.length, 1);
    assert.equal(starts[0].includes("fake-secret"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("denies unknown backend requests and closes with pending approval", async () => {
  const f = fixture();
  const events: any[] = [];
  const transport = await f.open((event) => events.push(event));
  f.receive({ id: "unknown", method: "unexpected/action", params: {} });
  await f.next(2);
  assert.deepEqual(f.sent[2], {
    id: "unknown",
    error: { code: -32601, message: "Unsupported request" },
  });
  await transport.close();
  await assert.rejects(transport.startThread());
  await f.cleanup();
});
