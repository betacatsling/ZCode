# pi-file-boundary early interface

Owner: pi-file-boundary. `packages/services/src/agent-adapters/pi/piFileTools.ts` exports `createPiFileToolOptions(worktreeRoot: string): Promise<{ read: ReadToolOptions; write: WriteToolOptions; edit: EditToolOptions }>`; construction pins root inode, per-operation Linux proc-fd traversal rejects symlinks. Integrator (piWorker owner) passes returned object to Pi SDK `createAgentSession({ toolOptions: ... })` if SDK supports this option; otherwise construct `customTools` from SDK `createReadToolDefinition/createWriteToolDefinition/createEditToolDefinition` and set `tools: ["bash"]`. Never use SDK default file tools in parallel. Unsupported OS fails closed. Host approval is not Bash confinement.

Spec: docs/agent-host/PI-FILE-BOUNDARY.md. SHA follows commit.
