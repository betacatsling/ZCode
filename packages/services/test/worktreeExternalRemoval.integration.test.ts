import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { Model } from "@zcode/contracts";
import { PiHarnessAdapter } from "../src/agent-adapters/pi/piHarnessAdapter.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { AgentHostTargetService } from "../src/agent-host/targetService.js";
import {
  createFileWorktreeService,
  createNodeWorkspaceAdmissionController,
} from "../src/worktree/index.js";

const execFile = promisify(execFileCallback);

const fakeModel = {
  providerId: "fixture-provider",
  modelId: "fixture-model",
  displayName: "Admission fixture",
  options: { reasoningLevel: "off" },
  properties: { contextWindow: 32000 },
  optionSpecs: { maxOutputTokens: { max: 1000 } },
  async *streamText(request: Parameters<Model["streamText"]>[0]) {
    const hasToolResult = request.messages.some((item) => item.role === "tool");
    yield { type: "start", modelId: "fixture-model" };
    if (!hasToolResult) {
      yield { type: "tool_input_start", id: "write-1", toolName: "write" };
      yield {
        type: "tool_input_delta",
        id: "write-1",
        delta: '{"path":"denied.txt","content":"not written"}',
      };
      yield { type: "tool_input_end", id: "write-1" };
      yield {
        type: "tool_call",
        toolCall: {
          id: "write-1",
          name: "write",
          input: { path: "denied.txt", content: "not written" },
        },
      };
      yield {
        type: "finish",
        finishReason: "tool-calls",
        usage: { inputTokens: 5, outputTokens: 2 },
      };
    } else {
      yield { type: "text_start", id: "text-1" };
      yield { type: "text_delta", id: "text-1", text: "Approval denied" };
      yield { type: "text_end", id: "text-1" };
      yield { type: "finish", finishReason: "stop", usage: { inputTokens: 7, outputTokens: 2 } };
    }
  },
} as unknown as Model;

async function git(cwd: string | undefined, args: readonly string[]): Promise<string> {
  const result = await execFile("git", cwd ? ["-C", cwd, ...args] : [...args], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout;
}

test("workspace-derived external session remains readable after safe removal; approval blocks first attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-external-worktree-removal-"));
  const main = join(root, "repository");
  const linked = join(root, "linked worktree\nwith newline");
  const catalogPath = join(root, "worktree-catalog.json");
  const targetId = "target-local";
  const admissionRoot = `${catalogPath}.admission`;
  const admission = createNodeWorkspaceAdmissionController({
    root: admissionRoot,
    targetId: () => targetId,
  });
  let external: AgentHostTargetService | undefined;
  const worktrees = createFileWorktreeService({
    filePath: catalogPath,
    targetId: () => targetId,
    admissionRoot,
    admissionController: admission,
    activity: {
      async readNative() {
        return { complete: true, state: "idle" as const };
      },
      async readExternal(workspace) {
        if (!external) return { complete: false, state: "unknown" as const };
        const index = await external.listActivityIndex();
        const workspaceKey = workspace.workspaceIdentity?.trim() || workspace.worktreePath;
        const sessions = index.sessions.filter(
          ({ spec }) =>
            spec.execution.targetId === targetId &&
            spec.execution.worktreePath === workspace.worktreePath &&
            spec.execution.workspaceIdentity.trim() === workspaceKey,
        );
        const pendingApprovalCount = sessions.reduce(
          (count, session) => count + session.pendingInteractionIds.length,
          0,
        );
        const state =
          !index.complete || sessions.some((session) => session.state === "unknown")
            ? "unknown"
            : sessions.some(
                  (session) =>
                    session.state === "busy" ||
                    session.activeTurnId !== null ||
                    session.pendingInteractionIds.length > 0,
                )
              ? "busy"
              : "idle";
        return { complete: index.complete, state, pendingApprovalCount };
      },
    },
  });

  try {
    await git(undefined, ["init", "-q", main]);
    await git(main, ["config", "user.email", "test@example.com"]);
    await git(main, ["config", "user.name", "Worktree Admission Test"]);
    await writeFile(join(main, "README.md"), "history root\n", "utf8");
    await git(main, ["add", "README.md"]);
    await git(main, ["commit", "-qm", "initial"]);
    await git(main, ["branch", "-M", "main"]);
    await git(main, ["worktree", "add", "-q", linked, "-b", "feature/external"]);
    const discovery = await worktrees.discover(linked);
    assert.equal(discovery.kind, "git");
    if (discovery.kind !== "git") throw new Error("linked worktree discovery failed");
    const candidate = discovery.candidates.find((item) => item.worktreePath === linked);
    assert.ok(candidate);
    const adopted = await worktrees.adopt("project-one", candidate);

    const registry = new HarnessRegistry();
    registry.register(
      new PiHarnessAdapter({
        root: join(root, "pi-workers"),
        modelFactory: () => fakeModel,
      }),
    );
    external = new AgentHostTargetService({
      root: join(root, "agent-host"),
      target: {
        id: targetId,
        kind: "local",
        platform: process.platform as "darwin" | "linux" | "win32",
        available: true,
      },
      catalog: {
        fingerprint: "pi-fake-catalog-v1",
        validateSelection: () => ({ ok: true as const }),
      },
      registry,
      worktrees,
      authorizeWorktree: async (spec, realPath) => {
        const stored = (await worktrees.read()).workspaces.find(
          (workspace) => workspace.id === spec.execution.workspaceId,
        );
        return Boolean(
          stored &&
          realPath === stored.worktreePath &&
          spec.execution.worktreePath === stored.worktreePath &&
          spec.execution.worktreeGeneration === stored.worktreeGeneration &&
          spec.execution.workspaceIdentity ===
            (stored.workspaceIdentity?.trim() || stored.worktreePath) &&
          stored.lifecycle === "active" &&
          stored.verification === "verified",
        );
      },
      withWorkspaceAdmission: async (spec, operation) => {
        const stored = (await worktrees.read()).workspaces.find(
          (workspace) => workspace.id === spec.execution.workspaceId,
        );
        if (
          !stored ||
          spec.execution.worktreeGeneration !== stored.worktreeGeneration ||
          spec.execution.worktreePath !== stored.worktreePath ||
          spec.execution.workspaceIdentity !==
            (stored.workspaceIdentity?.trim() || stored.worktreePath)
        ) {
          throw new Error("stale-or-unavailable-workspace-generation");
        }
        return admission.withWorkspace(
          {
            targetId,
            workspaceId: stored.id,
            workspaceIdentity: stored.workspaceIdentity,
            workspacePath: stored.worktreePath,
            expectedGeneration: spec.execution.worktreeGeneration,
          },
          operation,
        );
      },
    });

    const created = await external.createExternalForWorkspace({
      workspaceId: adopted.workspace.id,
      worktreeGeneration: adopted.workspace.worktreeGeneration,
      hostSessionId: "external-session-1",
      harness: { id: "pi", adapterVersion: "0.87.1" },
      modelBinding: {
        kind: "host-managed",
        selection: {
          providerId: "fixture-provider",
          modelId: "fixture-model",
          options: { reasoningLevel: "off" },
        },
      },
    });
    const spec = {
      schemaVersion: 1 as const,
      hostSessionId: "external-session-1",
      execution: {
        targetId,
        workspaceIdentity: linked,
        worktreePath: linked,
        workspaceId: adopted.workspace.id,
        worktreeGeneration: adopted.workspace.worktreeGeneration,
      },
      harness: { id: "pi", adapterVersion: "0.87.1" },
      modelBinding: {
        kind: "host-managed" as const,
        selection: {
          providerId: "fixture-provider",
          modelId: "fixture-model",
          options: { reasoningLevel: "off" },
        },
      },
    };
    let resolveApproval!: (interactionId: string) => void;
    const approvalRequested = new Promise<string>((resolve) => (resolveApproval = resolve));
    const turnFinished = new Promise<void>((resolve) => {
      const disposable = external!.subscribe((event) => {
        if (
          event.spec.hostSessionId === spec.hostSessionId &&
          event.event.kind === "interaction.requested"
        ) {
          resolveApproval(event.event.interactionId);
        }
        if (
          event.spec.hostSessionId === spec.hostSessionId &&
          event.event.kind === "turn.finished"
        ) {
          disposable();
          resolve();
        }
      });
    });
    const cleanPreview = await worktrees.previewRemoveWorkspace({
      workspaceId: adopted.workspace.id,
      expectedGeneration: adopted.workspace.worktreeGeneration,
    });
    assert.equal(cleanPreview.safeToRemove, true);
    const accepted = await external.dispatch(spec, {
      type: "send",
      commandId: "send-1",
      hostSessionId: spec.hostSessionId,
      turnId: "turn-1",
      text: "request a write approval",
    });
    assert.equal(accepted.status, "accepted");
    const approvalId = await Promise.race([
      approvalRequested,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("fake Pi approval was not requested")),
          8_000,
        );
        timer.unref();
      }),
    ]);

    await worktrees.updateWorkspace({ operation: "archive", workspaceId: adopted.workspace.id });
    await assert.rejects(
      worktrees.removeWorkspace({
        workspaceId: adopted.workspace.id,
        expectedGeneration: adopted.workspace.worktreeGeneration,
        confirmationToken: cleanPreview.confirmationToken!,
      }),
      /workspace-removal-blocked:.*external-approval-pending/,
    );
    assert.equal(
      (await external.snapshot(spec)).pendingInteractions.length,
      1,
      "a denied removal leaves the live approval and session running",
    );
    const blocked = await worktrees.previewRemoveWorkspace({
      workspaceId: adopted.workspace.id,
      expectedGeneration: adopted.workspace.worktreeGeneration,
    });
    assert.ok(blocked.blockers.includes("external-approval-pending"));
    assert.equal((await external.snapshot(spec)).pendingInteractions.length, 1);

    await external.dispatch(spec, {
      type: "resolveInteraction",
      commandId: "deny-approval-1",
      hostSessionId: spec.hostSessionId,
      runtimeEpoch: created.snapshot.logEpoch,
      turnId: "turn-1",
      interactionId: approvalId,
      decision: "deny",
    });
    await turnFinished;
    const ready = await worktrees.previewRemoveWorkspace({
      workspaceId: adopted.workspace.id,
      expectedGeneration: adopted.workspace.worktreeGeneration,
    });
    assert.equal(ready.safeToRemove, true);
    await worktrees.removeWorkspace({
      workspaceId: adopted.workspace.id,
      expectedGeneration: adopted.workspace.worktreeGeneration,
      confirmationToken: ready.confirmationToken!,
    });
    assert.equal((await external.snapshot(spec)).seq > 0, true);
    await assert.rejects(
      external.createExternalForWorkspace({
        workspaceId: adopted.workspace.id,
        worktreeGeneration: adopted.workspace.worktreeGeneration,
        hostSessionId: "stale-external-session",
        harness: { id: "pi", adapterVersion: "0.87.1" },
        modelBinding: {
          kind: "host-managed",
          selection: {
            providerId: "fixture-provider",
            modelId: "fixture-model",
            options: { reasoningLevel: "off" },
          },
        },
      }),
      /stale-or-unavailable-workspace/,
    );
    assert.equal(
      await git(main, ["show-ref", "--verify", "refs/heads/feature/external"]).then(() => true),
      true,
    );
  } finally {
    await external?.close();
    await rm(root, { recursive: true, force: true });
  }
});
