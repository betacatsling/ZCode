import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  atomicWritePrivateTextFile,
  withFileLock,
  workspaceAdmissionFenceFilePath,
} from "@zcode/shared/node";

type ChildMessage = {
  type?: string;
  operation?: string;
  message?: string;
  stack?: string;
  results?: Array<{ status: string; reasonCode?: string }>;
  pendingCommandCount?: number;
  pendingInputCount?: number;
};

function waitForMessage(
  child: ChildProcess,
  messages: ChildMessage[],
  predicate: (message: ChildMessage) => boolean,
  description: string,
): Promise<ChildMessage> {
  const queued = messages.findIndex(predicate);
  if (queued >= 0) return Promise.resolve(messages.splice(queued, 1)[0]!);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`timed out waiting for ${description}`)), 20_000);
    const onMessage = (raw: unknown) => {
      const message = raw as ChildMessage;
      if (message.type === "fatal") {
        const queuedFatal = messages.findIndex((candidate) => candidate.type === "fatal");
        if (queuedFatal >= 0) messages.splice(queuedFatal, 1);
        finish(new Error(`process fixture failed: ${message.message}\n${message.stack ?? ""}`));
      } else if (predicate(message)) {
        const queuedMatch = messages.findIndex(predicate);
        if (queuedMatch >= 0) messages.splice(queuedMatch, 1);
        finish(undefined, message);
      } else {
        messages.push(message);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(new Error(`process fixture exited before ${description}: ${code ?? signal ?? "unknown"}`));
    const finish = (error?: Error, message?: ChildMessage) => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(message!);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

test(
  "a cross-process freeze serializes CommandInbox create and send before native admission",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-native-admission-process-"));
    const workspacePath = join(root, "workspace with spaces\nand newline");
    const workspaceId = "workspace-process";
    const workspaceIdentity = "process-workspace-identity";
    const targetId = "target-process";
    const generation = "generation-process-1";
    const admissionRoot = join(root, "fences");
    const fencePath = workspaceAdmissionFenceFilePath(
      admissionRoot,
      targetId,
      workspaceIdentity,
      workspacePath,
    );
    const fence = {
      schemaVersion: 1,
      targetId,
      workspaceId,
      workspaceKey: workspaceIdentity,
      worktreePath: workspacePath,
      worktreeGeneration: generation,
      lifecycle: "active",
    };
    let child: ChildProcess | undefined;
    const childMessages: ChildMessage[] = [];
    let resolveChildExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => (resolveChildExit = resolve),
    );

    try {
      await mkdir(workspacePath, { recursive: true });
      await atomicWritePrivateTextFile(fencePath, `${JSON.stringify(fence)}\n`);
      const fixture = fileURLToPath(
        new URL("./fixtures/workspace-admission-process-owner.ts", import.meta.url),
      );
      child = fork(fixture, [admissionRoot, workspacePath, targetId, generation], {
        cwd: process.cwd(),
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      child.on("message", (raw: unknown) => childMessages.push(raw as ChildMessage));
      child.once("exit", (code, signal) => resolveChildExit({ code, signal }));
      await waitForMessage(child, childMessages, (message) => message.type === "ready", "owner ready");

      await withFileLock(fencePath, async () => {
        const entered = Promise.all(
          ["createSession", "sendText"].map((operation) =>
            waitForMessage(
              child!,
              childMessages,
              (message) =>
                message.type === "admission-entered" && message.operation === operation,
              `CommandInbox ${operation} entering the shared fence`,
            ),
          ),
        );
        child!.send({ type: "attempts" });
        await entered;
        await atomicWritePrivateTextFile(
          fencePath,
          `${JSON.stringify({
            ...fence,
            lifecycle: "frozen",
            freezeToken: "cross-process-freeze",
            previousLifecycle: "active",
          })}\n`,
        );
      });

      const result = await waitForMessage(
        child,
        childMessages,
        (message) => message.type === "attempts-result",
        "native admission outcomes",
      );
      assert.deepEqual(result.results?.map((item) => item.status), ["rejected", "rejected"]);
      assert.equal(result.pendingCommandCount, 0);
      assert.equal(result.pendingInputCount, 0);

      child.send({ type: "close" });
      await waitForMessage(child, childMessages, (message) => message.type === "closed", "owner closed");
      assert.deepEqual(await childExit, { code: 0, signal: null });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await childExit;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
