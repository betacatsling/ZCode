/**
 * Pins how a thrown Error crosses ChannelServer → ChannelClient: name, message, stack, plus the
 * optional passthrough fields (`code` among them) only when the server-side error defines them.
 * `cause` and other own properties never cross. Also pins both directions of wire compatibility:
 * a payload without `code` (the upstream VS Code shape) decodes on the current client, and a
 * payload with `code` decodes with an old-shape reader that only knows name/message/stack.
 *
 * Wire frames are `serialize(header) + serialize(body)`; the numbers are the const enums from
 * channels.shared.ts (RequestType.Promise = 100, ResponseType.Initialize = 200,
 * ResponseType.PromiseError = 202), which tsx cannot import across modules.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  BufferReader,
  BufferWriter,
  ChannelClient,
  ChannelServer,
  Event,
  createQueuePair,
  deserialize,
  serialize,
  type IMessagePassingProtocol,
  type IServerChannel,
  type VSBuffer,
} from "../src/index.js";

const REQUEST_PROMISE = 100;
const RESPONSE_INITIALIZE = 200;
const RESPONSE_PROMISE_ERROR = 202;

class CodedError extends Error {
  readonly code = "host-closed" as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodedError";
  }
}

function throwingChannel(error: unknown): IServerChannel {
  return {
    call: async () => {
      throw error;
    },
    listen: () => {
      throw new Error("no events");
    },
  };
}

function frame(header: unknown, body: unknown = undefined): VSBuffer {
  const writer = new BufferWriter();
  serialize(writer, header);
  serialize(writer, body);
  return writer.buffer;
}

function unframe(message: VSBuffer): { header: unknown[]; body: unknown } {
  const reader = new BufferReader(message);
  return { header: deserialize(reader) as unknown[], body: deserialize(reader) };
}

async function callThrough(error: unknown): Promise<unknown> {
  const [clientSide, serverSide] = createQueuePair();
  const server = new ChannelServer(serverSide, "ctx");
  server.registerChannel("svc", throwingChannel(error));
  const client = new ChannelClient(clientSide);
  try {
    await Event.toPromise(client.onDidInitialize);
    return await client
      .getChannel("svc")
      .call("run")
      .then(
        () => assert.fail("call should reject"),
        (rejection: unknown) => rejection,
      );
  } finally {
    client.dispose();
    server.dispose();
  }
}

/** Reads the raw PromiseError body the real ChannelServer puts on the wire. */
async function rawErrorBody(error: unknown): Promise<Record<string, unknown>> {
  const [clientSide, serverSide] = createQueuePair();
  const server = new ChannelServer(serverSide, "ctx");
  server.registerChannel("svc", throwingChannel(error));
  try {
    return await new Promise((resolve) => {
      const listener = clientSide.onMessage((message) => {
        const { header, body } = unframe(message);
        if (header[0] === RESPONSE_INITIALIZE) {
          clientSide.send(frame([REQUEST_PROMISE, 1, "svc", "run"]));
        } else if (header[0] === RESPONSE_PROMISE_ERROR && header[1] === 1) {
          listener.dispose();
          resolve(body as Record<string, unknown>);
        }
      });
    });
  } finally {
    server.dispose();
  }
}

/** A server that answers every Promise request with a fixed PromiseError body. */
function fakeServer(protocol: IMessagePassingProtocol, body: Record<string, unknown>): void {
  protocol.onMessage((message) => {
    const { header } = unframe(message);
    if (header[0] === REQUEST_PROMISE)
      protocol.send(frame([RESPONSE_PROMISE_ERROR, header[1]], body));
  });
  protocol.send(frame([RESPONSE_INITIALIZE]));
}

/** What a client that predates the passthrough fields does with a PromiseError body. */
function oldShapeClientError(body: Record<string, unknown>): Error {
  const error = new Error(body.message as string);
  error.name = body.name as string;
  if (Array.isArray(body.stack)) error.stack = body.stack.join("\n");
  return error;
}

test("a thrown error's code crosses the channel with name and message", async () => {
  const rejection = await callThrough(new CodedError("target host is closing"));
  assert.ok(rejection instanceof Error);
  const error = rejection as Error & { code?: unknown };
  assert.equal(error.name, "CodedError");
  assert.equal(error.message, "target host is closing");
  assert.equal(error.code, "host-closed");
  assert.ok(!(error instanceof CodedError), "the class itself does not cross");
});

test("an error without code arrives without a code property", async () => {
  const plain = new TypeError("bad input");
  const rejection = await callThrough(plain);
  assert.ok(rejection instanceof Error);
  assert.equal(rejection.name, "TypeError");
  assert.equal(rejection.message, "bad input");
  assert.equal(Object.hasOwn(rejection, "code"), false);
});

test("the wire body carries code but never cause or other own properties", async () => {
  const error = Object.assign(new CodedError("closed", { cause: new Error("journal closed") }), {
    secret: "not-on-the-wire",
  });
  const body = await rawErrorBody(error);
  assert.deepEqual(Object.keys(body).sort(), ["code", "message", "name", "stack"]);
  assert.equal(body.code, "host-closed");

  const withoutCode = await rawErrorBody(new Error("plain"));
  assert.deepEqual(Object.keys(withoutCode).sort(), ["message", "name", "stack"]);
});

test("the current client decodes an old-shape error payload that has no code", async () => {
  const [clientSide, serverSide] = createQueuePair();
  fakeServer(serverSide, { message: "old server failure", name: "LegacyError", stack: undefined });
  const client = new ChannelClient(clientSide);
  try {
    await Event.toPromise(client.onDidInitialize);
    await assert.rejects(client.getChannel("svc").call("run"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "LegacyError");
      assert.equal(error.message, "old server failure");
      assert.equal(Object.hasOwn(error, "code"), false);
      return true;
    });
  } finally {
    client.dispose();
  }
});

test("an old-shape reader decodes a payload that carries code (and ignores it)", async () => {
  const body = await rawErrorBody(new CodedError("target host is closing"));
  const error = oldShapeClientError(body);
  assert.equal(error.name, "CodedError");
  assert.equal(error.message, "target host is closing");
  assert.match(error.stack ?? "", /target host is closing/);
});
