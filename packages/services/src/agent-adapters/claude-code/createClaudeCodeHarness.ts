import { homedir } from "node:os";
import { ClaudeCodeHarnessAdapter, type ClaudeCodeHarnessOptions } from "./claudeCodeHarnessAdapter.js";
import { FakeClaudeCodeTransport, type ClaudeCodeTransport } from "./claudeCodeFakeTransport.js";
import { createMockClaudeCodeModelBindingPort } from "./claudeCodeModelReport.js";
import { createFilesystemClaudeCodeProfileSink } from "./claudeCodeProfile.js";

export interface CreateClaudeCodeHarnessOptions extends Omit<
  ClaudeCodeHarnessOptions,
  "transport" | "profileSink" | "userHome"
> {
  readonly userHome?: string;
  readonly transport?: ClaudeCodeTransport;
  readonly profileSink?: ClaudeCodeHarnessOptions["profileSink"];
}

/** Opt-in factory. The default app composition does not register this adapter. */
export function createClaudeCodeHarness(options: CreateClaudeCodeHarnessOptions): ClaudeCodeHarnessAdapter {
  const userHome = options.userHome ?? homedir();
  const transport = options.transport ?? new FakeClaudeCodeTransport({ userHome });
  const profileSink =
    options.profileSink ??
    createFilesystemClaudeCodeProfileSink({ managedRoot: options.managedRoot, userHome });
  return new ClaudeCodeHarnessAdapter({
    ...options,
    userHome,
    transport,
    profileSink,
    modelBindingPort: options.modelBindingPort ?? createMockClaudeCodeModelBindingPort(),
  });
}
